<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { usePlayerStore } from '../../stores/player';
import type { DanmakuComment } from '../../../shared/types';

/**
 * The danmaku canvas.
 *
 * Everything on it is driven by the playback position rather than by wall-clock time, which is what makes
 * it survive a pause, a seek, a 2× rate and a buffer stall without a second clock to fall out of step.
 * A comment is spawned when the position reaches its timestamp and takes `durationMs` of *position* to
 * cross, so at 2× it simply moves twice as fast.
 */
const player = usePlayerStore();
const canvas = ref<HTMLCanvasElement | null>(null);

interface Flowing {
  text: string;
  color: string;
  /** Position-seconds at which the comment entered. */
  born: number;
  width: number;
  lane: number;
  size: number;
}
interface Pinned extends Flowing {
  top: boolean;
}

const BASE = 25;
const GAP = 0.12;

let items: Flowing[] = [];
let pinned: Pinned[] = [];
let tails: number[] = [];
let cursor = 0;
let lastPos = -1;
let raf = 0;
let geo = { w: 0, h: 0, dpr: 1 };

const active = computed(() => player.danmakuOn && player.dmComments.length > 0 && player.state.status !== 'idle');

/** Comments arrive in time order, so the cursor is the only walk needed to find what is due. */
function indexAt(pos: number): number {
  const list = player.dmComments;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].timeSec < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function reset(pos: number): void {
  items = [];
  pinned = [];
  tails = [];
  cursor = indexAt(pos);
}

function measure(ctx: CanvasRenderingContext2D, text: string, size: number): number {
  ctx.font = `600 ${size}px "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif`;
  return ctx.measureText(text).width;
}

function resize(): void {
  const c = canvas.value;
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (geo.w === w && geo.h === h && geo.dpr === dpr) return;
  geo = { w, h, dpr };
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
}

function spawn(list: DanmakuComment[], pos: number, areaH: number): void {
  const cfg = player.prefs;
  const dur = cfg.durationMs / 1000;
  const size = Math.round(BASE * (cfg.fontScale || 1));
  const ctx = canvas.value?.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
  const lanes = Math.max(1, Math.floor(areaH / (size * 1.25)));
  // The wall: a dense timeline drops comments rather than frames, because a stutter costs the picture.
  let live = items.length + pinned.length;
  const cap = cfg.maxOnScreen || 80;
  while (cursor < list.length && list[cursor].timeSec <= pos) {
    const c = list[cursor++];
    if (live >= cap) continue;
    const width = measure(ctx, c.text, size);
    if (c.mode === 'scroll') {
      let lane = -1;
      for (let k = 0; k < lanes; k++) {
        if ((tails[k] ?? 0) <= pos) {
          lane = k;
          break;
        }
      }
      if (lane < 0) continue;
      // The lane is busy until this comment's tail has cleared the right edge.
      tails[lane] = pos + width / ((geo.w + width) / dur) + GAP;
      items.push({ text: c.text, color: c.color, born: pos, width, lane, size });
    } else {
      const rows = pinned.filter(p => p.top === (c.mode === 'top'));
      const used = new Set(rows.map(r => r.lane));
      let lane = -1;
      for (let k = 0; k < lanes; k++) if (!used.has(k)) { lane = k; break; }
      if (lane < 0) continue;
      pinned.push({ text: c.text, color: c.color, born: pos, width, lane, size, top: c.mode === 'top' });
    }
    live++;
  }
}

function draw(): void {
  const c = canvas.value;
  const ctx = c?.getContext('2d');
  if (!c || !ctx) return;
  resize();
  const cfg = player.prefs;
  const pos = player.state.positionMs / 1000;
  const dur = cfg.durationMs / 1000;
  const areaH = Math.max(40, geo.h * (cfg.displayArea ?? 1));

  if (Math.abs(pos - lastPos) > 1.5) reset(pos);
  lastPos = pos;

  ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
  ctx.clearRect(0, 0, geo.w, geo.h);
  spawn(player.dmComments, pos, areaH);

  items = items.filter(it => pos - it.born <= dur + it.width / geo.w);
  pinned = pinned.filter(p => pos - p.born <= dur);

  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = Math.min(1, Math.max(0.1, cfg.opacity ?? 0.85));
  for (const it of items) {
    const t = pos - it.born;
    const v = (geo.w + it.width) / dur;
    const x = geo.w - v * t;
    const y = it.lane * it.size * 1.25 + 4;
    paint(ctx, it, x, y);
  }
  const rowH = Math.round(BASE * (cfg.fontScale || 1)) * 1.25;
  for (const p of pinned) {
    // A pinned comment holds its lane for its whole duration, so the lanes stack from the top edge down
    // and from the bottom of the area up rather than overlapping in the middle.
    const y = p.top ? 4 + p.lane * rowH : areaH - (p.lane + 1) * rowH;
    paint(ctx, p, (geo.w - p.width) / 2, y);
  }
  ctx.globalAlpha = 1;
  raf = requestAnimationFrame(draw);
}

function paint(ctx: CanvasRenderingContext2D, it: Flowing, x: number, y: number): void {
  ctx.font = `600 ${it.size}px "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif`;
  // The outline is what keeps a white comment readable over snow, a bright sky or an unlit face.
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.lineWidth = 3;
  ctx.strokeText(it.text, x, y);
  ctx.fillStyle = it.color || '#ffffff';
  ctx.fillText(it.text, x, y);
}

function start(): void {
  if (raf) return;
  reset(player.state.positionMs / 1000);
  lastPos = player.state.positionMs / 1000;
  raf = requestAnimationFrame(draw);
}

function stop(): void {
  if (!raf) return;
  cancelAnimationFrame(raf);
  raf = 0;
  const c = canvas.value;
  c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
}

watch(active, on => (on ? start() : stop()), { immediate: true });

/** A new track's comments replace whatever is still crossing the screen. */
watch(
  () => player.dmComments,
  () => {
    if (active.value) start();
  },
);

onUnmounted(stop);
</script>

<template>
  <canvas v-show="active" ref="canvas" class="dm"></canvas>
</template>

<style scoped>
/* The layer must never take a click away from the controls above it. */
.dm {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
</style>
