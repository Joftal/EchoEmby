<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  AudioLines,
  BookMarked,
  Film,
  Gauge,
  ListVideo,
  Maximize,
  MessagesSquare,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-vue-next';
import DanmakuLayer from '../components/player/DanmakuLayer.vue';
import SheetLayer from '../components/player/SheetLayer.vue';
import TitleArt from '../components/TitleArt.vue';
import { SPEED_STEPS, usePlayerStore } from '../stores/player';
import { useAppStore } from '../stores/app';
import { fmtClock } from '../lib/format';
import { VOLUME_MAX } from '../../shared/types';

const player = usePlayerStore();
const app = useAppStore();

const s = computed(() => player.state);
const session = computed(() => player.session);
const media = computed(() => player.media);
const step = computed(() => app.config?.settings.player.seekStepMs || 10000);
const skipSec = computed(() => Math.round(step.value / 1000));
const hideAfter = computed(() => app.config?.settings.player.controlsTimeoutMs || 3200);

const visible = ref(true);
const dragging = ref(false);
const hover = ref<{ ratio: number; x: number } | null>(null);
const rail = ref<HTMLElement | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;

/** Anything that can start a hide is funneled through here: a bar that vanishes while a menu is open
 *  would take the way out of it with it. */
function show(): void {
  visible.value = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    if (!dragging.value && !player.panel && !s.value.paused && s.value.status !== 'error') visible.value = false;
  }, hideAfter.value);
}

const buffered = computed(() => `${(s.value.durationMs ? Math.min(1, s.value.bufferedMs / s.value.durationMs) : 0) * 100}%`);
const ticks = computed(() => media.value.chapters.slice(1).map(c => `${(c.timeMs / (s.value.durationMs || 1)) * 100}%`));

/** The facts strip under the timeline. Every line is read back from the demuxer or the server, never
 *  assumed, and a fact the file did not report simply does not appear. */
const badges = computed(() => {
  const m = media.value;
  const out: { text: string; cls?: string }[] = [];
  if (m.width) out.push({ text: `${m.width}×${m.height}` });
  if (m.hdr || session.value?.hdr) out.push({ text: 'HDR', cls: 'hdr' });
  const vid = m.tracks.find(t => t.kind === 'video' && t.selected);
  const aud = m.tracks.find(t => t.kind === 'audio' && t.selected);
  if (vid?.codec) out.push({ text: vid.codec.toUpperCase() });
  if (aud?.codec) out.push({ text: aud.codec.toUpperCase() });
  if (m.fps) out.push({ text: `${m.fps.toFixed(2)} fps` });
  return out;
});

/** The live read-out in the corner: what this app is pulling off the network right now, over a three
 *  second window - the player's stream plus any posters or metadata still arriving behind it. It stays
 *  mounted at zero while nothing is arriving, so the corner never jumps when a transfer starts or ends.
 *  Under a megabyte the one-decimal MB reading collapses to `0.3 MB/s`, which is exactly the range where
 *  the difference between starving and merely slow matters, so the unit follows the number there. */
const rate = computed(() => {
  const b = s.value.netBytesPerSec;
  if (!b) return '0 KB/s';
  if (b < 1048576) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB/s`;
  return `${(b / 1048576).toFixed(1)} MB/s`;
});

/** The 画质 trigger says what is being used, the way the reference's 「1080p」 button does. `tier` is the
 *  negotiated bitrate, not an index, so the rung is found the same way the 播放资源 menu finds it. */
const tierLabel = computed(() => {
  const se = session.value;
  if (!se) return '画质';
  return se.tiers.find(t => t.bitrate === se.tier)?.label || '画质';
});

/* The top-left carries the work's own title treatment, on the same rule the two heroes use. An episode
   takes the series' art, because that is the level both TMDB and the server file a logo at — an episode
   page has none. The item's name is what shows when nothing in the chain answers. */
const titleUrls = ref<string[]>([]);

watch(
  () => session.value?.itemId,
  async (id?: string) => {
    titleUrls.value = [];
    if (!id) return;
    const r = await window.echoemby.emby.item(session.value?.seriesId || id);
    if (!r.ok || !r.data || session.value?.itemId !== id) return;
    titleUrls.value = await app.logoCandidates(r.data);
  },
  { immediate: true },
);

function ratioAt(e: PointerEvent): number {
  const el = rail.value;
  if (!el) return 0;
  const rect = el.getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
}

/** The bar reports the place it is dragged to, not the place mpv last said it was: a seek that has not
 *  landed yet must not snap the thumb back under the pointer. */
const shown = ref(0);
const shownPosition = computed(() => `${(dragging.value ? shown.value : player.progress) * 100}%`);

function onDown(e: PointerEvent): void {
  if (!s.value.durationMs) return;
  dragging.value = true;
  shown.value = ratioAt(e);
  rail.value?.setPointerCapture(e.pointerId);
  void seekTo(shown.value);
}
function onRailMove(e: PointerEvent): void {
  if (!s.value.durationMs) return;
  hover.value = { ratio: ratioAt(e), x: e.clientX };
  if (!dragging.value) return;
  shown.value = ratioAt(e);
  void seekTo(shown.value);
}
async function onUp(e: PointerEvent): Promise<void> {
  if (dragging.value) {
    shown.value = ratioAt(e);
    await seekTo(shown.value);
  }
  dragging.value = false;
  rail.value?.releasePointerCapture(e.pointerId);
  show();
}
async function seekTo(ratio: number): Promise<void> {
  await player.cmd({ action: 'seekMs', value: Math.round(ratio * s.value.durationMs) });
}

const hoverTime = computed(() => (hover.value ? fmtClock(hover.value.ratio * s.value.durationMs) : ''));

const speedIndex = computed(() => SPEED_STEPS.indexOf(s.value.speed));
function nudgeSpeed(dir: number): void {
  const i = speedIndex.value < 0 ? SPEED_STEPS.indexOf(1) : speedIndex.value;
  const next = SPEED_STEPS[Math.min(SPEED_STEPS.length - 1, Math.max(0, i + dir))];
  void player.cmd({ action: 'speed', value: next });
}

/** Any volume gesture - slider drag or arrow key - also lifts mute, the way a hardware rocker does:
 *  reaching for the level means wanting to hear it. */
function volumeTo(v: number): void {
  if (s.value.muted) void player.cmd({ action: 'mute', value: false });
  void player.cmd({ action: 'volume', value: Math.min(VOLUME_MAX, Math.max(0, Math.round(v))) });
}

const keys: Record<string, () => void> = {
  ' ': () => void player.cmd({ action: 'toggle' }),
  k: () => void player.cmd({ action: 'toggle' }),
  ArrowRight: () => void player.cmd({ action: 'skip', value: step.value }),
  ArrowLeft: () => void player.cmd({ action: 'skip', value: -step.value }),
  l: () => void player.cmd({ action: 'skip', value: step.value }),
  j: () => void player.cmd({ action: 'skip', value: -step.value }),
  ArrowUp: () => volumeTo(s.value.volume + 5),
  ArrowDown: () => volumeTo(s.value.volume - 5),
  m: () => void player.cmd({ action: 'mute', value: !s.value.muted }),
  f: () => void player.cmd({ action: 'fullscreen', value: !s.value.fullscreen }),
  n: () => session.value?.next && void player.cmd({ action: 'next' }),
  p: () => session.value?.prev && void player.cmd({ action: 'prev' }),
  s: () => player.openPanel('subtitle', true),
  a: () => player.openPanel('audio', true),
  v: () => player.openPanel('video', true),
  q: () => player.openPanel('quality', true),
  d: () => player.openPanel('danmaku', true),
  e: () => player.openPanel('episodes', true),
  c: () => player.openPanel('chapters', true),
  t: () => player.openPanel('speed', true),
  ',': () => void player.cmd({ action: 'frameStep', value: -1 }),
  '.': () => void player.cmd({ action: 'frameStep', value: 1 }),
  '[': () => nudgeSpeed(-1),
  ']': () => nudgeSpeed(1),
  r: () => void player.cmd({ action: 'restart' }),
  Escape: () => (player.panel ? player.closePanel() : void player.close()),
};

/** The keys a menu works with. While the card holds the cursor they belong to it: ArrowDown is the next
 *  chapter, not the next five seconds, and Escape backs out of a submenu before it closes the player.
 *  A menu opened by mouse leaves the cursor on the page, so the same keys still drive the film. */
const CARD_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ', 'Escape']);

function cardHoldsCursor(): boolean {
  const el = document.activeElement;
  return !!player.panel && el instanceof HTMLElement && el !== document.body && !!el.closest('.pl-sheet');
}

function onKey(e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null;
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
  if (e.ctrlKey || e.metaKey) return;
  if (cardHoldsCursor() && CARD_KEYS.has(e.key)) return;
  if (e.repeat && !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const digit = /^[0-9]$/.test(e.key);
  const fn = digit ? () => void seekTo(Number(e.key) / 10) : keys[e.key === 'K' ? 'k' : e.key];
  if (!fn) return;
  // Escape belongs to the player while this overlay is up: the library window keeps its own 返回主页,
  // and a keypress that reached both would leave the video open under a page change.
  e.preventDefault();
  e.stopPropagation();
  show();
  fn();
}

const ended = computed(() => s.value.status === 'ended');

/** A click on the picture with a menu open closes the menu: the popover floats over the video, so the
 *  first click anywhere off it is the user saying 「不用了」, not a request to pause the film. */
async function onSurfaceClick(): Promise<void> {
  if (player.panel) {
    player.closePanel();
    show();
    return;
  }
  await player.cmd({ action: ended.value ? 'restart' : 'toggle' });
  show();
}

function dblclick(): void {
  void player.cmd({ action: 'fullscreen', value: !s.value.fullscreen });
}

onMounted(() => {
  player.attach();
  void app.init();
  player.seedDanmaku();
  show();
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('mousemove', show);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('mousemove', show);
  if (timer) clearTimeout(timer);
  player.detach();
});
</script>

<template>
  <div class="stage" :class="{ hidden: !visible }" @pointermove="show" @pointerleave="hover = null">
    <div class="surface" @click="onSurfaceClick" @dblclick="dblclick"></div>
    <DanmakuLayer />

    <header class="pl-top drag">
      <div class="topin no-drag">
        <TitleArt class="art" :urls="titleUrls" :name="session?.name || '播放器'" />
      </div>
      <div class="no-drag ends">
        <span class="pl-pill live" title="本应用当前的下载速度">{{ rate }}</span>
        <button class="ib close" title="关闭播放器" @click="player.close()">
          <X :size="20" />
        </button>
      </div>
    </header>

    <button v-if="!visible" class="hitzone" @click="show" @pointermove="show"></button>

    <SheetLayer />

    <div class="pl-bar">
      <div class="seek" ref="rail" @pointerdown="onDown" @pointerup="onUp" @pointermove="onRailMove">
        <div class="rail">
          <div class="buf" :style="{ width: buffered }"></div>
          <div class="fill" :style="{ width: shownPosition }"></div>
          <span v-for="(t, i) in ticks" :key="i" class="tick" :style="{ left: t }"></span>
          <div class="thumb" :style="{ left: shownPosition }"></div>
        </div>
        <span v-if="hover" class="tip" :style="{ left: `${hover.ratio * 100}%` }">{{ hoverTime }}</span>
      </div>

      <div class="pl-badges">
        <span class="pl-pill meta">
          <template v-for="(b, i) in badges" :key="b.text">
            <i v-if="i" class="bar"></i>
            <span :class="b.cls">{{ b.text }}</span>
          </template>
        </span>
      </div>

      <div class="pl-rowline">
        <div class="pl-caps">
          <button class="ib" :disabled="!session?.prev" title="上一集" @click="player.cmd({ action: 'prev' })">
            <SkipBack :size="22" />
          </button>
          <button class="ib skip" :title="`后退 ${skipSec} 秒`" @click="player.cmd({ action: 'skip', value: -step })">
            <RotateCcw :size="23" /><span class="n">{{ skipSec }}</span>
          </button>
          <button class="ib primary" :class="{ act: !s.paused }" title="播放 / 暂停（空格）" @click="player.cmd({ action: 'toggle' })">
            <Play v-if="s.paused" :size="27" fill="currentColor" stroke-width="1" /><Pause v-else :size="26" fill="currentColor" stroke-width="1" />
          </button>
          <button class="ib skip" :title="`快进 ${skipSec} 秒`" @click="player.cmd({ action: 'skip', value: step })">
            <RotateCw :size="23" /><span class="n">{{ skipSec }}</span>
          </button>
          <button class="ib" :disabled="!session?.next" title="下一集" @click="player.cmd({ action: 'next' })">
            <SkipForward :size="22" />
          </button>
          <span class="pl-time">{{ fmtClock(s.positionMs) }}<span class="dash">/</span>{{ fmtClock(s.durationMs) }}</span>
        </div>

        <div class="pl-caps">
          <div class="vol">
            <button class="ib" :class="{ act: s.muted }" title="静音（M）" @click="player.cmd({ action: 'mute', value: !s.muted })">
              <VolumeX v-if="s.muted || !s.volume" :size="23" /><Volume1 v-else-if="s.volume < 60" :size="23" /><Volume2 v-else :size="23" />
            </button>
            <input
              class="pl-range vslider"
              type="range"
              :min="0"
              :max="VOLUME_MAX"
              :value="s.muted ? 0 : s.volume"
              :style="{ '--p': `${((s.muted ? 0 : s.volume) / VOLUME_MAX) * 100}%` }"
              :aria-label="`音量 ${s.muted ? 0 : s.volume}`"
              @input="e => volumeTo(Number((e.target as HTMLInputElement).value))"
            />
            <span class="vnum">{{ s.muted ? 0 : s.volume }}</span>
          </div>

          <span class="cap-sep"></span>

          <button class="ib word" data-panel="quality" :class="{ act: player.panel === 'quality' }" title="播放资源（Q）" @click="player.openPanel('quality')">{{ tierLabel }}</button>

          <button class="ib word cc" data-panel="subtitle" :class="{ act: player.panel === 'subtitle' || media.subtitle !== 'no' }" title="字幕（S）" @click="player.openPanel('subtitle')">CC</button>

          <button class="ib" data-panel="audio" :class="{ act: player.panel === 'audio' }" title="音轨（A）" @click="player.openPanel('audio')">
            <AudioLines :size="23" />
          </button>

          <button class="ib" data-panel="video" :class="{ act: player.panel === 'video' }" title="画面（V）" @click="player.openPanel('video')">
            <Film :size="23" />
          </button>

          <span class="cap-sep"></span>

          <button class="ib" data-panel="speed" :class="{ act: player.panel === 'speed' || s.speed !== 1 }" title="速度（T）" @click="player.openPanel('speed')">
            <Gauge :size="23" />
            <span v-if="s.speed !== 1" class="tag">{{ s.speed }}</span>
          </button>

          <button class="ib" data-panel="chapters" :class="{ act: player.panel === 'chapters' }" title="片段（C）" @click="player.openPanel('chapters')">
            <BookMarked :size="23" />
          </button>

          <button v-if="session?.seriesId" class="ib" data-panel="episodes" :class="{ act: player.panel === 'episodes' }" title="选集（E）" @click="player.openPanel('episodes')">
            <ListVideo :size="23" />
          </button>

          <button class="ib dm" data-panel="danmaku" :class="{ act: player.panel === 'danmaku', off: !player.danmakuOn }" title="弹幕（D）" @click="player.openPanel('danmaku')">
            <MessagesSquare :size="23" />
          </button>

          <span class="cap-sep"></span>

          <button class="ib" :title="s.fullscreen ? '退出全屏（F）' : '全屏（F）'" @click="player.cmd({ action: 'fullscreen', value: !s.fullscreen })">
            <Minimize v-if="s.fullscreen" :size="23" /><Maximize v-else :size="23" />
          </button>
        </div>
      </div>
    </div>

    <p v-if="player.error" class="notice">{{ player.error }}</p>
    <div v-if="s.status === 'error'" class="fail">
      <p>{{ s.error || '播放失败' }}</p>
      <button class="act" @click="player.close()">返回</button>
    </div>
  </div>
</template>

<style scoped>
.stage {
  position: absolute;
  inset: 0;
  color: var(--pl-text);
}
.surface {
  position: absolute;
  inset: 0;
  /* Not `background: none`: a layered window is hit-tested by pixel alpha, and where the controls layer is
     fully transparent Windows skips the window and the mouse lands on the mpv host underneath it. Measured
     with WindowFromPoint over the picture: it answered with the host's render widget, so the page never saw
     a mousemove and a hover could not wake the chrome - no button was reachable. 2/255 of black is invisible
     over video and makes the whole window take the mouse. */
  background: rgba(0, 0, 0, 0.008);
}
.hitzone {
  position: absolute;
  inset: 0;
  z-index: 1;
}
/* A player that has put its chrome away puts the pointer away with it - the mouse still brings the bar
   back, but an arrowhead frozen in the middle of the film is not what a real player shows. */
.stage.hidden {
  cursor: none;
}
.stage.hidden .hitzone {
  cursor: none;
}
.pl-top {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 20px 52px;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.72), transparent);
  z-index: 3;
}
.topin {
  display: flex;
  align-items: baseline;
  gap: 12px;
  min-width: 0;
}
.ends {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}
/* The treatment scales with the window it is drawn in: 8% of the height, floored where a small window
   would make the art unreadable and capped so a maximized 4K screen does not get a banner. Measured on
   this window's own 1236x660 default that is 53px tall, at 1080p fullscreen 86px. The width is capped
   short of the strip so a 12:1 wordmark cannot reach the rate pill; `contain` then gives the wide ones
   their height back, which is why the height is a maximum and not a fixed row. */
.art {
  --title-h: clamp(34px, 8vh, 92px);
  --title-w: 100%;
  --title-gap: 0;
  --title-fs: 17px;
  --title-clamp: 1;
  flex: none;
  min-width: 0;
  max-width: min(42vw, 460px);
}
/* With no art anywhere in the chain the slot falls back to the name, and there it should still read as
   chrome rather than as a poster title. */
.art :deep(h1) {
  font-weight: 600;
  letter-spacing: 0;
  line-height: 1.3;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8), 0 3px 14px rgba(0, 0, 0, 0.6);
}
.pl-pill.live {
  font-variant-numeric: tabular-nums;
}
/* The timeline sits on its own line, full width, above both capsules: the capsules carry the buttons,
   the line carries the playhead. */
.seek {
  position: relative;
  padding: 11px 2px;
  cursor: pointer;
  touch-action: none;
}
.rail {
  position: relative;
  height: 5px;
  border-radius: 999px;
  /* The rail lives at the top of the bar, where the scrim gradient has already faded to nothing, so a
     translucent white track alone vanishes over snow or sky. The dark floor is painted inside the element
     rather than behind it, which keeps the rail readable on any ground without a second box. */
  background:
    linear-gradient(rgba(255, 255, 255, 0.3), rgba(255, 255, 255, 0.3)),
    linear-gradient(rgba(8, 9, 12, 0.72), rgba(8, 9, 12, 0.72));
  transition: height var(--hov) var(--ease-out);
}
.seek:hover .rail {
  height: 8px;
}
.buf {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.3);
  transition: width 0.3s linear;
}
.fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 999px;
  background: var(--pl-fill);
  transition: width 0.22s linear;
}
.tick {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: rgba(0, 0, 0, 0.5);
}
.thumb {
  position: absolute;
  top: 50%;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.5);
  transform: translate(-50%, -50%) scale(0);
  transition: transform var(--hov) var(--ease-out);
}
.seek:hover .thumb,
.seek:active .thumb {
  transform: translate(-50%, -50%) scale(1);
}
.tip {
  position: absolute;
  bottom: 100%;
  transform: translate(-50%, -6px);
  padding: 4px 9px;
  border-radius: var(--r-badge);
  background: rgba(12, 12, 16, 0.9);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
}
.pl-time {
  padding-left: 6px;
}
.ib {
  min-width: 44px;
  height: 44px;
  padding: 0 9px;
  border-radius: 999px;
  color: var(--pl-text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-size: 15px;
  transition: background var(--hov) var(--ease), transform var(--hov) var(--ease-out), color var(--hov) var(--ease);
}
/* One grid for every glyph: the set draws on 24 units with a 2-unit stroke, and the bar renders it at
   22-23 px over a 44 px target - the icon keeps most of its button, so the hit area is not all padding.
   Play/pause is the one exception: it is the control used most and gets a larger glyph on a larger disc. */
.ib svg {
  display: block;
  flex: none;
}
.ib.primary {
  min-width: 48px;
  height: 48px;
}
.ib.primary:hover {
  background: rgba(255, 255, 255, 0.18);
}
.ib:hover {
  background: rgba(255, 255, 255, 0.14);
}
.ib:active {
  transform: scale(0.92);
}
.ib:disabled {
  opacity: 0.32;
}
.ib.act {
  color: var(--pl-hi);
}
.ib.off {
  opacity: 0.55;
}
.ib.close {
  border-radius: 50%;
  background: rgba(10, 10, 14, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(10px);
}
.ib.word {
  font-weight: 600;
  letter-spacing: 0.2px;
}
.ib.cc {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.6px;
}
/* The seconds ride beside the arc, in real text at 15px. Two reasons it is not drawn into the icon: an
   SVG <text> inside a 24-unit viewBox scaled to 23 px lands under 11 px, and the ring's own opening is
   only ~12 px wide, so a legible numeral cannot sit inside it. */
.ib.skip {
  gap: 2px;
}
.ib.skip .n {
  font-size: 15px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.3px;
}
.ib .tag {
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.cap-sep {
  width: 1px;
  height: 28px;
  margin: 0 9px;
  background: rgba(255, 255, 255, 0.16);
  flex: none;
}
.vol {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-right: 5px;
}
.vslider {
  width: 104px;
}
.vnum {
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  color: var(--pl-dim);
  width: 34px;
  text-align: right;
}
.notice {
  position: absolute;
  left: 50%;
  bottom: 178px;
  transform: translate(-50%, 0);
  padding: 9px 15px;
  border-radius: 999px;
  background: rgba(12, 12, 16, 0.88);
  font-size: 14px;
  z-index: 4;
}
.fail {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  gap: 14px;
  text-align: center;
  background: rgba(10, 10, 14, 0.82);
  z-index: 6;
}
.fail p {
  font-size: 15px;
  max-width: 420px;
}
/* Scoped to the failure card on purpose: `.act` is also the state class every capsule trigger carries
   while its menu is open, and an unscoped rule here painted every open icon solid blue. */
.fail .act {
  justify-self: center;
  padding: 11px 22px;
  border-radius: 999px;
  background: var(--pl-fill);
  color: #fff;
  font-size: 15px;
}
</style>
