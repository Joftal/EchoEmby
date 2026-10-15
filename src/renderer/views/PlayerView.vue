<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import DanmakuLayer from '../components/player/DanmakuLayer.vue';
import TrackPanel from '../components/player/TrackPanel.vue';
import QualityPanel from '../components/player/QualityPanel.vue';
import SpeedPanel from '../components/player/SpeedPanel.vue';
import ChapterPanel from '../components/player/ChapterPanel.vue';
import EpisodePanel from '../components/player/EpisodePanel.vue';
import DanmakuPanel from '../components/player/DanmakuPanel.vue';
import { SPEED_STEPS, usePlayerStore } from '../stores/player';
import { useAppStore } from '../stores/app';
import { fmtClock } from '../lib/format';
import { VOLUME_MAX, type PlayMethod } from '../../shared/types';

const player = usePlayerStore();
const app = useAppStore();

const s = computed(() => player.state);
const session = computed(() => player.session);
const media = computed(() => player.media);
const step = computed(() => app.config?.settings.player.seekStepMs || 10000);
const hideAfter = computed(() => app.config?.settings.player.controlsTimeoutMs || 3200);

const METHOD_CN: Record<PlayMethod, string> = { DirectPlay: '直接播放', DirectStream: '直接串流', Transcode: '转码' };

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
  if (session.value?.method) out.push({ text: METHOD_CN[session.value.method] });
  return out;
});

/** The live read-out in the corner: what the demuxer is pulling right now, over a three second window. */
const rate = computed(() => {
  const b = s.value.netBytesPerSec;
  if (!b || s.value.status !== 'playing') return '';
  return `${(b / 1048576).toFixed(1)} MB/s`;
});

/** The 画质 trigger says what is being used, the way the reference's 「1080p」 button does. `tier` is the
 *  negotiated bitrate, not an index, so the rung is found the same way the 播放资源 menu finds it. */
const tierLabel = computed(() => {
  const se = session.value;
  if (!se) return '画质';
  return se.tiers.find(t => t.bitrate === se.tier)?.label || '画质';
});

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

function volumeTo(v: number): void {
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
  s: () => player.openPanel('subtitle'),
  a: () => player.openPanel('audio'),
  v: () => player.openPanel('video'),
  q: () => player.openPanel('quality'),
  d: () => player.openPanel('danmaku'),
  e: () => player.openPanel('episodes'),
  c: () => player.openPanel('chapters'),
  t: () => player.openPanel('speed'),
  ',': () => void player.cmd({ action: 'frameStep', value: -1 }),
  '.': () => void player.cmd({ action: 'frameStep', value: 1 }),
  '[': () => nudgeSpeed(-1),
  ']': () => nudgeSpeed(1),
  r: () => void player.cmd({ action: 'restart' }),
  Escape: () => (player.panel ? player.closePanel() : void player.close()),
};

function onKey(e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null;
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
  if (e.ctrlKey || e.metaKey) return;
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
        <span class="name">{{ session?.name || '播放器' }}</span>
        <span v-if="session?.line" class="line">{{ session.line }}</span>
      </div>
      <div class="no-drag ends">
        <span v-if="rate" class="pl-pill live">{{ rate }}</span>
        <button class="ib close" title="关闭播放器" @click="player.close()">
          <svg viewBox="0 0 24 24" width="17" height="17"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" fill="none" /></svg>
        </button>
      </div>
    </header>

    <button v-if="!visible" class="hitzone" @click="show" @pointermove="show"></button>

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
        <span v-for="b in badges" :key="b.text" class="pl-pill" :class="b.cls">{{ b.text }}</span>
        <span v-if="session?.tier === 0" class="pl-pill orig">原片</span>
      </div>

      <div class="pl-rowline">
        <div class="pl-caps">
          <button class="ib" :class="{ act: !s.paused }" title="播放 / 暂停（空格）" @click="player.cmd({ action: 'toggle' })">
            <svg v-if="s.paused" viewBox="0 0 24 24" width="19" height="19"><path d="M8 5l12 7-12 7z" fill="currentColor" /></svg>
            <svg v-else viewBox="0 0 24 24" width="18" height="18"><rect x="6" y="5" width="4" height="14" rx="1.5" fill="currentColor" /><rect x="14" y="5" width="4" height="14" rx="1.5" fill="currentColor" /></svg>
          </button>
          <button class="ib" :disabled="!session?.prev" title="上一集" @click="player.cmd({ action: 'prev' })">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M18 6l-8 6 8 6zM7 5v14" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" /></svg>
          </button>
          <button class="ib" :disabled="!session?.next" title="下一集" @click="player.cmd({ action: 'next' })">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l8 6-8 6zM17 5v14" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" /></svg>
          </button>
          <button class="ib skip" :title="`后退 ${Math.round(step / 1000)} 秒`" @click="player.cmd({ action: 'skip', value: -step })">
            <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M11 5H6.5A4.5 4.5 0 0 0 2 9.5V12a5 5 0 0 0 5 5h3M11 5l-3.5 3.5M11 5L7.5 8.5" /><text x="15" y="17" font-size="11" stroke="none" fill="currentColor" text-anchor="middle">10</text></svg>
          </button>
          <button class="ib skip" :title="`快进 ${Math.round(step / 1000)} 秒`" @click="player.cmd({ action: 'skip', value: step })">
            <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M13 5h4.5A4.5 4.5 0 0 1 22 9.5V12a5 5 0 0 1-5 5h-3M13 5l3.5 3.5M13 5l-3.5 3.5" /><text x="9" y="17" font-size="11" stroke="none" fill="currentColor" text-anchor="middle">10</text></svg>
          </button>
          <span class="pl-time">{{ fmtClock(s.positionMs) }}<span class="dash">/</span>{{ fmtClock(s.durationMs) }}</span>
        </div>

        <div class="pl-caps">
          <div class="vol">
            <button class="ib" :class="{ act: s.muted }" title="静音（M）" @click="player.cmd({ action: 'mute', value: !s.muted })">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M4 9v6h4l5 4V5L8 9H4z" />
                <path v-if="s.muted || !s.volume" d="M16.5 9.5l5 5M21.5 9.5l-5 5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" />
                <path v-else d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" />
              </svg>
            </button>
            <input class="vslider" type="range" :min="0" :max="VOLUME_MAX" :value="s.volume" @input="e => volumeTo(Number((e.target as HTMLInputElement).value))" />
            <span class="vnum">{{ s.muted ? 0 : s.volume }}</span>
          </div>

          <div class="pl-menu">
            <button class="ib word" :class="{ act: player.panel === 'quality' }" title="播放资源（Q）" @click="player.openPanel('quality')">{{ tierLabel }}</button>
            <Transition name="pl">
              <QualityPanel v-if="player.panel === 'quality'" />
            </Transition>
          </div>

          <div class="pl-menu">
            <button class="ib word cc" :class="{ act: player.panel === 'subtitle' || media.subtitle !== 'no' }" title="字幕（S）" @click="player.openPanel('subtitle')">CC</button>
            <Transition name="pl">
              <TrackPanel v-if="player.panel === 'subtitle'" kind="subtitle" />
            </Transition>
          </div>

          <div class="pl-menu">
            <button class="ib" :class="{ act: player.panel === 'audio' }" title="音轨（A）" @click="player.openPanel('audio')">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3 12v-2M7 15V7M11 17V5M15 14v-4M19 12.5v-1" /></svg>
            </button>
            <Transition name="pl">
              <TrackPanel v-if="player.panel === 'audio'" kind="audio" />
            </Transition>
          </div>

          <div class="pl-menu">
            <button class="ib" :class="{ act: player.panel === 'video' }" title="画面（V）" @click="player.openPanel('video')">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="6" width="18" height="12" rx="2.5" /><path d="M8 6v12" stroke-linecap="round" /></svg>
            </button>
            <Transition name="pl">
              <TrackPanel v-if="player.panel === 'video'" kind="video" />
            </Transition>
          </div>

          <div class="pl-menu">
            <button class="ib" :class="{ act: player.panel === 'speed' || s.speed !== 1 }" title="速度（T）" @click="player.openPanel('speed')">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 17a8 8 0 1 1 16 0" /><path d="M12 17l4-5" /></svg>
              <span v-if="s.speed !== 1" class="tag">{{ s.speed }}</span>
            </button>
            <Transition name="pl">
              <SpeedPanel v-if="player.panel === 'speed'" />
            </Transition>
          </div>

          <div class="pl-menu">
            <button class="ib" :class="{ act: player.panel === 'chapters' }" title="片段（C）" @click="player.openPanel('chapters')">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6 4v16M10 4v16M14 4h4M14 9h4M14 14h4" /></svg>
            </button>
            <Transition name="pl">
              <ChapterPanel v-if="player.panel === 'chapters'" />
            </Transition>
          </div>

          <div class="pl-menu" v-if="session?.seriesId">
            <button class="ib" :class="{ act: player.panel === 'episodes' }" title="选集（E）" @click="player.openPanel('episodes')">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10" /></svg>
            </button>
            <Transition name="pl">
              <EpisodePanel v-if="player.panel === 'episodes'" />
            </Transition>
          </div>

          <div class="pl-menu">
            <button class="ib dm" :class="{ act: player.panel === 'danmaku', off: !player.danmakuOn }" title="弹幕（D）" @click="player.openPanel('danmaku')">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3 8h12M6 12h11M9 16h9" /><circle cx="19.5" cy="7" r="1.4" fill="currentColor" stroke="none" /></svg>
            </button>
            <Transition name="pl">
              <DanmakuPanel v-if="player.panel === 'danmaku'" />
            </Transition>
          </div>

          <button class="ib" :title="s.fullscreen ? '退出全屏（F）' : '全屏（F）'" @click="player.cmd({ action: 'fullscreen', value: !s.fullscreen })">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path v-if="!s.fullscreen" d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /><path v-else d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>
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
  padding: 14px 18px 44px;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.72), transparent);
  z-index: 3;
}
.topin {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.ends {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.name {
  font-size: 15px;
  font-weight: 600;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8), 0 3px 14px rgba(0, 0, 0, 0.6);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.line {
  font-size: 13px;
  color: var(--pl-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pl-pill.live {
  font-variant-numeric: tabular-nums;
}
/* The timeline sits on its own line, full width, above both capsules: the capsules carry the buttons,
   the line carries the playhead. */
.seek {
  position: relative;
  padding: 10px 2px;
  cursor: pointer;
  touch-action: none;
}
.rail {
  position: relative;
  height: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.24);
  transition: height var(--hov) var(--ease-out);
}
.seek:hover .rail {
  height: 6px;
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
  width: 13px;
  height: 13px;
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
  padding: 3px 7px;
  border-radius: var(--r-badge);
  background: rgba(12, 12, 16, 0.9);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
}
.pl-time {
  padding-left: 4px;
}
.ib {
  min-width: 34px;
  height: 34px;
  padding: 0 7px;
  border-radius: 999px;
  color: var(--pl-text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-size: 13px;
  transition: background var(--hov) var(--ease), transform var(--hov) var(--ease-out), color var(--hov) var(--ease);
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
  font-size: 13px;
  letter-spacing: 0.4px;
}
.skip {
  letter-spacing: -0.5px;
}
.ib .tag {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.vol {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 6px;
  margin-right: 4px;
  border-right: 1px solid var(--pl-line);
}
.vslider {
  width: 78px;
  accent-color: var(--pl-fill);
}
.vnum {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--pl-dim);
  width: 28px;
  text-align: right;
}
.notice {
  position: absolute;
  left: 50%;
  bottom: 178px;
  transform: translate(-50%, 0);
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(12, 12, 16, 0.88);
  font-size: 13px;
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
  padding: 9px 18px;
  border-radius: 999px;
  background: var(--pl-fill);
  color: #fff;
  font-size: 13px;
}
</style>
