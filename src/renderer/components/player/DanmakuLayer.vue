<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { usePlayerStore } from '../../stores/player';
import type { DanmakuComment, DanmakuSettings } from '../../../shared/types';

/**
 * The danmaku canvas.
 *
 * Everything on it is driven by the playback position rather than by a clock of its own, which is what makes
 * it survive a pause, a seek, a 2× rate and a buffer stall without a second timeline to fall out of step.
 * A comment is spawned when the position reaches its timestamp and takes `duration` of *position* to
 * cross, so at 2× it simply moves twice as fast.
 *
 * `positionMs` itself is far too coarse to place a glyph with — the main process coalesces its property
 * events into one push every 200ms, measured at 4.4 Hz, while this window paints at 47 fps. Left alone that
 * re-painted a comment in the same place 91% of the time and then moved it 37px, which is what 「卡」 was.
 * The clock below fills the gaps between samples and keeps the truth as the anchor.
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

/** The reference player crosses one comment in 8s at 基础速度 1.0×, and that is the number the speed row
 *  multiplies; it is not a setting of its own. */
const CROSS_MS = 8000;
const GAP = 0.12;

let items: Flowing[] = [];
let pinned: Pinned[] = [];
let tails: number[] = [];
let cursor = 0;
let lastPos = -1;
let raf = 0;
let geo = { w: 0, h: 0, dpr: 1 };

/** Half a second is how long the extrapolation is allowed to stay ahead of a corrected sample. */
const CORRECT_S = 0.6;

/** The playback position as a continuous function: the last sample plus the wall clock since it arrived. */
const clock = { pos: 0, at: 0, rate: 1, paused: false, lead: 0 };

const cfg = computed<DanmakuSettings>(() => player.prefs);

function showAt(now: number): number {
  if (clock.paused) return clock.pos;
  const t = (now - clock.at) / 1000;
  // Whatever the run-ahead was is handed back over the next frames rather than in one jump, so a buffer
  // stall that froze the position slides the picture's comments instead of snapping them left.
  return clock.pos + t * clock.rate + clock.lead * Math.max(0, 1 - t / CORRECT_S);
}

function shown(): number {
  return showAt(performance.now());
}

/** Called for every `player:state` push. The slope comes from the two samples either side of it, not from
 *  the nominal rate, so a paused or stalled file reads as 0 and the glyphs stop with the picture. */
function resync(): void {
  const s = player.state;
  const pos = s.positionMs / 1000;
  const now = performance.now();
  const ahead = showAt(now);
  const nominal = s.speed || 1;
  const dt = (now - clock.at) / 1000;
  const measured = dt > 0.02 && dt < 2 ? Math.min(nominal * 3, Math.max(0, (pos - clock.pos) / dt)) : nominal;
  const gap = ahead - pos;
  clock.pos = pos;
  clock.at = now;
  clock.rate = measured;
  clock.paused = s.paused;
  // A seek is not drift: folding a minutes-long gap into the correction would fling every glyph across the
  // screen, so it is dropped and the frame reset in `frame` takes it instead.
  clock.lead = Math.abs(gap) < 1.5 ? gap : 0;
}

function prime(): void {
  const s = player.state;
  clock.pos = s.positionMs / 1000;
  clock.at = performance.now();
  clock.rate = s.speed || 1;
  clock.paused = s.paused;
  clock.lead = 0;
}

const active = computed(() => player.danmakuOn && player.dmComments.length > 0 && player.state.status !== 'idle');

/** 延迟显示 shifts the whole timeline, so a rip whose studio logo runs long is brought back in step
 *  without refetching anything. A positive delay means every comment appears that much later. */
function delaySec(): number {
  return Math.max(-30, Math.min(30, (cfg.value.delayMs || 0) / 1000));
}

/** Comments arrive in time order, so the cursor is the only walk needed to find what is due. */
function indexAt(pos: number): number {
  const list = player.dmComments;
  const at = pos + delaySec();
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].timeSec < at) lo = mid + 1;
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

const FONT_STACK = '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';

function fontFor(size: number): string {
  const family = cfg.value.fontFamily ? `"${cfg.value.fontFamily}", ${FONT_STACK}` : FONT_STACK;
  return `${cfg.value.bold ? 800 : 600} ${size}px ${family}`;
}

function measure(ctx: CanvasRenderingContext2D, text: string, size: number): number {
  ctx.font = fontFor(size);
  return ctx.measureText(text).width;
}

interface Sprite {
  c: HTMLCanvasElement;
  /** The box in CSS pixels; the canvas behind it holds dpr times as many device pixels. */
  w: number;
  h: number;
  /** Outline and shadow room baked into the box, so the glyphs sit at (pad, pad) inside it. */
  pad: number;
}

const SPRITE_CAP = 400;
const sprites = new Map<string, Sprite>();

/**
 * One comment's glyphs, rasterised once.
 *
 * Measured here: with the layer off this window's frame interval is a flat 16.7ms, but a screenful of
 * `strokeText` + `fillText` over CJK misses one vsync in seven and paces at 51fps with a 33ms frame in it. The
 * outline — which is what keeps a white comment readable over snow, a bright sky or an unlit face — is baked in
 * along with the fill, so a frame costs one `drawImage` per comment and a string is never rasterised twice
 * while it crosses. The shadow is baked in for the same reason.
 */
function sprite(ctx: CanvasRenderingContext2D, text: string, size: number, color: string): Sprite {
  const dpr = geo.dpr || 1;
  const st = cfg.value;
  const stroke = Math.max(0, st.strokeWidth || 0);
  const blur = Math.max(0, st.shadowBlur || 0);
  const off = Math.max(0, st.shadowOffset || 0);
  // The sprite's padding has to hold the outline and the shadow, or the canvas clips them at the edge.
  const pad = Math.ceil(stroke + blur + off) + 1;
  const key = [dpr, size, color, text, st.bold ? 1 : 0, stroke, st.strokeColor, blur, off, st.shadowColor, pad].join('|');
  const hit = sprites.get(key);
  if (hit) return hit;
  const w = Math.ceil(measure(ctx, text, size)) + pad * 2;
  const h = Math.ceil(size * 1.4) + pad * 2;
  const c = document.createElement('canvas');
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const s = c.getContext('2d');
  if (s) {
    s.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Without this the sprite's own context keeps the canvas default (10px sans-serif), so every comment was
    // rasterised at 10px inside a box sized for 字号 — small glyphs crowding the top of a too-tall box.
    s.font = fontFor(size);
    s.textBaseline = 'top';
    s.lineJoin = 'round';
    if (blur || off) {
      s.shadowColor = st.shadowColor || 'rgba(0, 0, 0, 0.6)';
      s.shadowBlur = blur;
      s.shadowOffsetX = off;
      s.shadowOffsetY = off;
    }
    if (stroke > 0) {
      s.lineWidth = stroke * 2;
      s.strokeStyle = st.strokeColor || '#000000';
      s.strokeText(text, pad, pad);
    }
    s.fillStyle = color || '#ffffff';
    s.fillText(text, pad, pad);
  }
  const out = { c, w, h, pad };
  // A track of a few thousand comments would otherwise hold a few thousand canvases; the screen never shows
  // more than the cap allows at once, so the whole cache is simply dropped and rebuilt as needed.
  if (sprites.size >= SPRITE_CAP) sprites.clear();
  sprites.set(key, out);
  return out;
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

function spawn(list: DanmakuComment[], pos: number, areaH: number, replaying = false): void {
  const st = cfg.value;
  const dur = CROSS_MS / 1000 / Math.max(0.1, st.speed || 1);
  const size = Math.max(10, Math.round(st.fontSize || 18));
  const laneH = size + Math.max(0, st.laneGap ?? 5);
  const ctx = canvas.value?.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
  // 弹幕行数 0 (自动) fits as many lanes as the area holds; a number is a ceiling the viewer chose.
  const fit = Math.max(1, Math.floor(areaH / laneH));
  const lanes = st.lanes && st.lanes > 0 ? Math.min(st.lanes, fit) : fit;
  const at = pos + delaySec();
  // The wall: a dense timeline drops comments rather than frames, because a stutter costs the picture.
  let live = items.length + pinned.length;
  const cap = st.maxOnScreen || 80;
  while (cursor < list.length && list[cursor].timeSec <= at) {
    const c = list[cursor++];
    if (live >= cap) continue;
    const width = measure(ctx, c.text, size);
    const pin = !st.scrollPinned && c.mode !== 'scroll';
    if (!pin) {
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
      items.push({ text: c.text, color: c.color, born: replaying ? c.timeSec - delaySec() : pos, width, lane, size });
    } else {
      const rows = pinned.filter(p => p.top === (c.mode === 'top'));
      const used = new Set(rows.map(r => r.lane));
      let lane = -1;
      for (let k = 0; k < lanes; k++) if (!used.has(k)) { lane = k; break; }
      if (lane < 0) continue;
      pinned.push({ text: c.text, color: c.color, born: replaying ? c.timeSec - delaySec() : pos, width, lane, size, top: c.mode === 'top' });
    }
    live++;
  }
}

/** Puts back what was already crossing at pos. A list swap - a new track, a blocked word, a settings write -
 *  empties the sprites while the file has not moved, and spawn() only starts what is still ahead, so a
 *  paused file went blank the moment its comments were replaced. Replayed comments keep the age they had,
 *  so they land where they were instead of entering from the right edge a second time. */
function seed(pos: number): void {
  if (!canvas.value) return;
  resize();
  const dur = CROSS_MS / 1000 / Math.max(0.1, cfg.value.speed || 1);
  const from = indexAt(pos - dur);
  if (from >= indexAt(pos)) return;
  const keep = cursor;
  cursor = from;
  spawn(player.dmComments, pos, Math.max(40, geo.h * (cfg.value.displayArea ?? 1)), true);
  cursor = keep;
}
function draw(): void {
  try {
    frame();
  } finally {
    // The next frame used to be queued on the last line of a clean frame, so a single throw anywhere above
    // left `raf` pointing at a callback that would never run again — and `start` refuses to begin a second
    // loop, so the canvas kept its last painted frame for the rest of the episode. Reproduced here by
    // wrapping strokeText from a probe: one exception, danmaku frozen, no message anywhere.
    raf = requestAnimationFrame(draw);
  }
}

function frame(): void {
  const c = canvas.value;
  const ctx = c?.getContext('2d');
  if (!c || !ctx) return;
  resize();
  const st = cfg.value;
  const pos = shown();
  const dur = CROSS_MS / 1000 / Math.max(0.1, st.speed || 1);
  const areaH = Math.max(40, geo.h * (st.displayArea ?? 1));
  const size = Math.max(10, Math.round(st.fontSize || 18));
  const laneH = size + Math.max(0, st.laneGap ?? 5);

  if (Math.abs(pos - lastPos) > 1.5) {
    reset(pos);
    seed(pos);
  }
  lastPos = pos;

  ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
  ctx.clearRect(0, 0, geo.w, geo.h);
  spawn(player.dmComments, pos, areaH);

  items = items.filter(it => pos - it.born <= dur + it.width / geo.w);
  pinned = pinned.filter(p => pos - p.born <= dur);

  ctx.globalAlpha = Math.min(1, Math.max(0.1, st.opacity ?? 1));
  for (const it of items) {
    const t = pos - it.born;
    const v = (geo.w + it.width) / dur;
    const x = geo.w - v * t;
    const y = it.lane * laneH + 4;
    paint(ctx, it, x, y);
  }
  for (const p of pinned) {
    // A pinned comment holds its lane for its whole duration, so the lanes stack from the top edge down
    // and from the bottom of the area up rather than overlapping in the middle.
    const y = p.top ? 4 + p.lane * laneH : areaH - (p.lane + 1) * laneH;
    paint(ctx, p, (geo.w - p.width) / 2, y);
  }
  ctx.globalAlpha = 1;
}

function paint(ctx: CanvasRenderingContext2D, it: Flowing, x: number, y: number): void {
  const s = sprite(ctx, it.text, it.size, it.color);
  ctx.drawImage(s.c, x - s.pad, y - s.pad, s.w, s.h);
}

function start(): void {
  if (raf) return;
  prime();
  reset(shown());
  seed(shown());
  lastPos = shown();
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

/** The samples are what keep the interpolated clock tied to the file, so every one of them is taken —
 *  including while the layer is off, so a restart does not inherit a stale anchor. */
watch(() => player.state, resync, { immediate: true });

/** A new list replaces what is on screen, and the loop cannot be told to do it by starting again:
 *  start() refuses to run twice, so a paused file - where the clock never moves and the drift check in
 *  frame() therefore never fires - would keep painting the previous list. Resetting here also lands the
 *  cursor on the new list, so what appears from now on is the filtered set rather than the old one. */
watch(
  () => player.dmComments,
  () => {
    if (!active.value) return;
    reset(shown());
    seed(shown());
    lastPos = shown();
    start();
  },
);

/** A style change repaints from the new sprite cache; the canvas is otherwise untouched between frames. */
watch(
  () => [cfg.value.fontSize, cfg.value.bold, cfg.value.strokeWidth, cfg.value.strokeColor, cfg.value.fontFamily, cfg.value.shadowBlur, cfg.value.shadowOffset, cfg.value.shadowColor, cfg.value.laneGap, cfg.value.lanes, cfg.value.speed],
  () => {
    sprites.clear();
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
