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
import { embyCached } from '../lib/embycache';
import { hasContent, VOLUME_MAX } from '../../shared/types';
import { versionNames } from '../../shared/version-label';

const player = usePlayerStore();
const app = useAppStore();

const s = computed(() => player.state);
const session = computed(() => player.session);
const media = computed(() => player.media);
const step = computed(() => app.config?.settings.player.seekStepMs || 10000);
const skipSec = computed(() => Math.round(step.value / 1000));
/** How long the chrome survives after the pointer stops moving. Not a setting: every player on this
 *  machine puts its bar away about a second after the hand leaves it, and a knob for the same number only
 *  made the reader guess which guess was theirs. */
const HIDE_AFTER_MS = 1000;

const visible = ref(true);
const dragging = ref(false);
const hover = ref<{ ratio: number; x: number } | null>(null);
/** The preview frame for the spot under the pointer. Asking for one is also what tells the decoder to make
 *  that part of the file next, and the answer is null until it exists — so the pointer polls while it
 *  stays put rather than waiting for a push. Nothing here blocks: a tip without a picture is the state
 *  this had before previews existed. */
const shot = ref<string | null>(null);
const shotFor = ref(-1);
/** Whether the decoder is still being asked for this spot. The placeholder box is exactly this: a wait that
 *  ends - with the picture, or with nothing if the second never comes. */
const fetching = ref(false);
let shotTimer: number | null = null;
/** Polls spent on the second under the pointer. A second the worker cannot decode must not be asked for
 *  forever: after this many turns the nearest picture stays and the asking stops. The cap has to outlast
 *  the main process's own deadline for one ask (8 s on a long film, where a seek reads from the server),
 *  or a slow-but-working seek would be dropped halfway. */
let shotTries = 0;
const SHOT_TRIES_MAX = 60;
/** A hand on the move takes the grid's pre-rendered cell; only a hand that has stopped pays for a seek to
 *  its own second. This is the line between the two: a drag across a two hour film must not become a
 *  hundred seeks, and a pointer that rests must not be left with the picture of another scene. */
let movedAt = 0;
const STILL_MS = 160;
const SHOT_POLL_MS = 220;
/** When the grid was last asked for, so a hand moving across the bar costs one call per tenth of a second
 *  rather than one per pointer event. */
let coarseAt = 0;
const rail = ref<HTMLElement | null>(null);
const overRail = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

/** The one way the chrome goes away, so the timer and the pointer leaving the window cannot disagree about
 *  when it is allowed to go: a bar that vanishes while a menu is open takes the way out of it with it, a bar
 *  that vanishes mid-drag drops the seek, and a paused film is being looked at, not watched past. */
function hide(): void {
  if (dragging.value || overRail.value || player.panel || s.value.paused || s.value.status === 'error') return;
  visible.value = false;
}

/** Anything that can start a hide is funneled through here. */
function show(): void {
  visible.value = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(hide, HIDE_AFTER_MS);
}

/** The cursor is off the window — over the desktop, another monitor, another app. Nothing on this film is
 *  being pointed at any more, so the bar goes now rather than in a second. `relatedTarget` is null only when
 *  the pointer really left the document; moving between two elements names the one it landed on. */
function onPointerOut(e: PointerEvent): void {
  if (e.relatedTarget) return;
  if (timer) clearTimeout(timer);
  hide();
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

/** The 播放资源 trigger says which version is on screen, in the same word the card inside the panel and the
 *  page's 播放资源 card both use: there is no bitrate ladder to name any more, so the only answer this button
 *  can give is the file itself. A file with nothing to choose between says the panel's own name instead of
 *  a number: 「版本 1」 beside 「1 个版本」 and 「这个条目只有一个版本」 is one fact told three times, and the
 *  ordinal is the least useful of them - measured 2026-10-28 on 253192, whose single 4K file had no shape
 *  word in its `Name`, so the trigger, the card and the note all said 版本 1 about the only file there is. */
const sourceLabel = computed(() => {
  const se = session.value;
  if (!se) return '播放资源';
  const playable = se.sources.filter(hasContent);
  if (playable.length < 2) return '播放资源';
  return versionNames(se.sources)[se.sourceIndex] || '播放资源';
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
    const r = await embyCached('item', session.value?.seriesId || id, () => window.echoemby.emby.item(session.value?.seriesId || id));
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
  startPoll();
  rail.value?.setPointerCapture(e.pointerId);
  void seekTo(shown.value);
}
function onRailMove(e: PointerEvent): void {
  if (!s.value.durationMs) return;
  hover.value = { ratio: ratioAt(e), x: e.clientX };
  movedAt = Date.now();
  startPoll();
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
/** Where the pointer is, in the units the preview grid is cut in. */
const hoverMs = computed(() => (hover.value && s.value.durationMs ? Math.round(hover.value.ratio * s.value.durationMs) : 0));
/** 进度条预览图 is a setting, off unless the file says on. With it off the tooltip is the clock alone — as it
 *  was before the feature existed — and a pointer that cannot produce a picture does not ask the main process
 *  twelve times a second. */
const previewOn = computed(() => app.config?.settings.player.thumbPreview === true);

async function pullShot(precise: boolean): Promise<void> {
  if (!previewOn.value || !hover.value) return;
  // 0 is the first frame of the film, not "no pointer": the left end of the bar gets a picture like
  // every other place on it. Asking for 0 used to be skipped, so that end never had one (2026-10-29).
  const ms = Math.max(0, Math.min(hoverMs.value, Math.max(0, s.value.durationMs - 1)));
  const r = await window.echoemby.player.thumb(ms, precise);
  // The pointer may have moved while the answer was being made; that picture is about another spot.
  if (!hover.value || hoverMs.value !== ms) return;
  if (r.ok && r.data && r.data.url) {
    shot.value = r.data.url;
    shotFor.value = ms;
    // 精确 means the decoder has made this very second. A picture of the neighbourhood is still shown -
    // it is the same part of the film - but the asking goes on until the second under the pointer is real.
    // `final` is the worker saying it will not produce that second at all.
    if (r.data.exact || r.data.final) {
      stopPoll();
      return;
    }
  } else if (shotFor.value !== ms) {
    shot.value = null;
  }
  // Every precise attempt counts, not only the ones answered with a neighbour's picture: a file that
  // cannot make that second at all (starving stream, dead worker) answers with no url, and that used to
  // leave the skeleton breathing on screen - and the IPC on the wire - for as long as the pointer rested.
  if (precise && ++shotTries > SHOT_TRIES_MAX) stopPoll();
}
function startPoll(): void {
  if (!previewOn.value) {
    // No picture will be made, so any picture still in the tip is about a moment the viewer is not
    // asking about any more: 关 has to leave the clock alone, the way it was before the feature existed.
    shot.value = null;
    shotFor.value = -1;
    return;
  }
  fetching.value = true;
  if (shotTimer == null) {
    shotTries = 0;
    shotTimer = window.setInterval(() => void pullShot(Date.now() - movedAt >= STILL_MS), SHOT_POLL_MS);
  }
  if (Date.now() - coarseAt < 100) return;
  coarseAt = Date.now();
  void pullShot(false);
}
function stopPoll(): void {
  fetching.value = false;
  if (shotTimer == null) return;
  window.clearInterval(shotTimer);
  shotTimer = null;
}
/** The bar is being read, not passed over: a preview that disappears one second after the pointer stops is
 *  a preview of a frame nobody got to look at. While the pointer rests on the rail the chrome stays. */
/** 关掉 进度条预览图 while the pointer is on the bar, or while a tip is up: the switch has to reach the tip
 *  the viewer is looking at, not only the next time the pointer enters the rail. */
watch(previewOn, on => {
  if (on) {
    // A pointer already resting on the bar has to fill in without being moved again, or 开 would look
    // like it needed a second gesture.
    if (hover.value) startPoll();
    return;
  }
  stopPoll();
  shot.value = null;
  shotFor.value = -1;
});
function onRailEnter(): void {
  overRail.value = true;
  show();
}
function onRailLeave(): void {
  overRail.value = false;
  show();
}
function onLeave(): void {
  hover.value = null;
  shot.value = null;
  shotFor.value = -1;
  stopPoll();
}

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
  window.addEventListener('pointerout', onPointerOut);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('mousemove', show);
  window.removeEventListener('pointerout', onPointerOut);
  if (timer) clearTimeout(timer);
  player.detach();
});
</script>

<template>
  <div class="stage" :class="{ hidden: !visible }" @pointermove="show" @pointerleave="onLeave">
    <div class="surface" @click="onSurfaceClick" @dblclick="dblclick"></div>
    <DanmakuLayer />

    <header class="pl-top">
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
      <div
        class="seek"
        ref="rail"
        @pointerdown="onDown"
        @pointerup="onUp"
        @pointermove="onRailMove"
        @pointerenter="onRailEnter"
        @pointerleave="onRailLeave"
      >
        <div class="rail">
          <div class="buf" :style="{ width: buffered }"></div>
          <div class="fill" :style="{ width: shownPosition }"></div>
          <span v-for="(t, i) in ticks" :key="i" class="tick" :style="{ left: t }"></span>
          <div class="thumb" :style="{ left: shownPosition }"></div>
        </div>
        <span v-if="hover" class="tip" :style="{ '--at': `${hover.ratio * 100}%` }">
          <img v-if="shot" class="frame" :src="shot" alt="" />
          <!-- The box the picture lands in. A long film needs seconds to read the spot under the
               pointer, and a tip that changes size when the frame finally arrives is worse than one
               that says it is fetching. -->
          <span v-else-if="previewOn && fetching" class="hold"></span>
          <span class="when">{{ hoverTime }}</span>
        </span>
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

          <button class="ib word" data-panel="quality" :class="{ act: player.panel === 'quality' }" title="播放资源（Q）" @click="player.openPanel('quality')">{{ sourceLabel }}</button>

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
  /* Two halves of one defect. The box runs 52px below the last thing it draws, so as a hit target it was
     a plate over the film: a click at y=75 hit-tested to this header and did nothing, y=160 reached the
     影片 and toggled pause. And its own -webkit-app-region covered the same 121px as a window drag.
     The plate lets the mouse go; the row's two ends take it back. */
  pointer-events: none;
}
/* The grip is the row the chrome is painted in, not the gradient — and it stops with the chrome. An
   invisible band over the top of the film would otherwise swallow the very gesture meant to wake the
   player: a click there became a window drag. Regions ignore pointer-events, so this says it itself. */
.pl-top::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 52px;
  -webkit-app-region: drag;
}
.stage.hidden .pl-top::before {
  -webkit-app-region: none;
}
.topin {
  pointer-events: auto;
  display: flex;
  align-items: baseline;
  gap: 12px;
  min-width: 0;
}
.ends {
  pointer-events: auto;
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
/* The tip is the time, and once the decoder has caught up, the picture at that time. It is held inside
   the bar's own width: a preview is ~170 px wide, so half of it is the margin a `left` of 0% or 100% would
   otherwise spend outside the window. */
.tip {
  position: absolute;
  bottom: 100%;
  left: clamp(88px, var(--at), calc(100% - 88px));
  transform: translate(-50%, -6px);
  padding: 4px 9px;
  border-radius: var(--r-badge);
  background: rgba(12, 12, 16, 0.9);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
  align-items: center;
}
.tip:has(.frame),
.tip:has(.hold) {
  padding: 5px 5px 3px;
  border-radius: 10px;
}
/* The frame is being decoded: the same box it will occupy, sweeping so the wait is visible. */
.hold {
  display: block;
  width: 168px;
  height: 95px;
  border-radius: 6px;
  background: linear-gradient(100deg, rgba(255, 255, 255, 0.05) 20%, rgba(255, 255, 255, 0.14) 40%, rgba(255, 255, 255, 0.05) 60%);
  background-size: 240% 100%;
  animation: hold-sweep 1.1s linear infinite;
}
@keyframes hold-sweep {
  from { background-position: 140% 0; }
  to { background-position: -40% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .hold { animation: none; }
}
.frame {
  display: block;
  width: 168px;
  height: 95px;
  object-fit: cover;
  border-radius: 6px;
}
.when {
  line-height: 1.2;
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
  animation: fade-in 0.24s var(--ease) both;
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
  /* The dim arrives over a picture that has just stopped, so it arrives as a dim rather than as a cut to
     black. */
  animation: fade-in 0.34s var(--ease) both;
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
