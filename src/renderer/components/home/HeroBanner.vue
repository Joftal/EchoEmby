<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import type { LibraryItem } from '../../../shared/types';
import { fmtDate, fmtElapsed, ticksToMs } from '../../lib/format';
import { genreLabels } from '../../lib/genres';
import { PLAYABLE, resumeTarget } from '../../lib/resume';
import { useScores } from '../../lib/scores';
import HeroPlay from '../HeroPlay.vue';
import ScoreStrip from '../ScoreStrip.vue';
import TitleArt from '../TitleArt.vue';
import { useAppStore } from '../../stores/app';
import { usePlayerStore } from '../../stores/player';
import { begin } from '../../lib/handoff';

const props = defineProps<{ items: LibraryItem[]; scroll: number; resume?: LibraryItem[] }>();
const emit = defineEmits<{ (e: 'play', item: LibraryItem, fromStart?: boolean): void; (e: 'open', item: LibraryItem): void }>();

const store = useAppStore();
const player = usePlayerStore();
const idx = ref(0);
const hovering = ref(false);
const DUR = 9000;
let timer: number | null = null;
let dueAt = 0;
let left = DUR;

/** Gateway image replies flake under a burst, so art is fetched per slide and retried. */
interface Art { url: string; wide: boolean; tries: number }
const art = ref<Record<string, Art>>({});
const pending = new Set<string>();
/* Which slides have pixels. A slide turned `.on` while its image was still in flight, so the first
   computed style was already the end state and the 1.1s crossfade could not run: measured on a cold
   lobby, the band went from no photo to a full-contrast still in a single frame. */
const decoded = ref<Record<string, boolean>>({});

/* The title treatment rides along with the slide but answers for itself: the list is filled once per
   item, and TitleArt walks it. */
const titleArt = ref<Record<string, string[]>>({});

async function fetchTitle(it: LibraryItem): Promise<void> {
  const urls = await store.logoCandidates(it);
  titleArt.value = { ...titleArt.value, [it.id]: urls };
}

const current = computed(() => props.items[idx.value] ?? null);
/* The slide's own score strip already asks the six sources for this title; read the same answers here for
   the synopsis, since a card the server leaves blank has a Chinese record at TMDB. The ask is keyed by
   item for the whole session, so this registers a reader rather than a second round of requests. */
const scores = useScores(() => current.value);
const overview = computed(() => {
  const t = scores.value.tmdb;
  return t?.overviewZh || current.value?.overview || t?.overviewOther || '';
});
const playable = computed(() => PLAYABLE.includes(current.value?.type || ''));
/** The slide's own button reads the lobby's 继续观看 rows as its candidates: a Series card has no progress
 *  of its own, and the episode it stopped on is already in the store. Null is not "no button" — it is "no
 *  row in hand", and the click then goes through the title's page to reach its first episode. */
const target = computed(() => resumeTarget(current.value, props.resume || []));
/** The id the page this button opens will seed its poster from — an episode slide opens its series, the
 *  same resolution a row click makes, so both hand over the art the plate is already showing. */
const detailId = computed(() => (current.value ? (current.value.type === 'Episode' ? current.value.parentId || '' : current.value.id) : ''));
const plate = ref<HTMLImageElement | null>(null);
/** Only a single playable row has a runtime that is its own. The server's number on a Series row is neither
 *  the show's nor one episode's (measured: 模范出租车 answers 1小时4分 for a first season that runs 17小时1分),
 *  so the slide leaves it out the way the detail page's line does. */
const runtime = computed(() => (playable.value ? fmtElapsed(ticksToMs(current.value?.runTimeTicks)) : ''));
const genres = computed(() => genreLabels(current.value?.genres).slice(0, 3).join(' '));
const date = computed(() => fmtDate(current.value?.premiereDate) || String(current.value?.productionYear || ''));
/** The slot beside the genres answers 「what is this」, so it carries the shape the server named. A Series
 *  used to read 「精选推荐」 there — a sentence about the carousel, not the title — and on a host whose
 *  shelves are all shows that is every slide the hero has. */
const KIND_WORD: Record<string, string> = { Movie: '电影', Episode: '剧集', Series: '剧集', Season: '剧集', Video: '视频' };
const kind = computed(() => KIND_WORD[current.value?.type || ''] || '精选推荐');

async function fetchArt(it: LibraryItem, wide: boolean): Promise<void> {
  const url = wide ? await store.backdropUrl(it, 1600) : await store.imageUrl(it, 1200);
  if (!url) return;
  art.value = { ...art.value, [it.id]: { url, wide, tries: art.value[it.id]?.tries || 0 } };
}

function need(it: LibraryItem | null): void {
  if (!it) return;
  if (!art.value[it.id] && !pending.has(it.id)) {
    pending.add(it.id);
    void fetchArt(it, !!it.backdropImageTag).finally(() => pending.delete(it.id));
  }
  if (!(it.id in titleArt.value)) void fetchTitle(it);
}

/** Hand the page this slide opens the art and the row already on screen, so it paints before it asks. */
function seedPlate(): void {
  // The banner's plate is the poster itself, so the page it opens can start from pixels already on screen.
  if (detailId.value) begin(plate.value, detailId.value, current.value);
}

function openDetail(): void {
  seedPlate();
  const it = current.value;
  if (it) emit('open', it);
}

/** The slide's own 播放. With a row in hand it names an episode and the lobby plays it; without one the
 *  slide is a Series the lobby cannot open a file for, so the click travels to its page — which is the
 *  only place that knows the first episode — and asks that page to start it.
 *  `fromStart` is the word on the button kept as a promise: 「播放」 opens the file at 0, 「继续播放」 takes
 *  the server's offset, so a label cannot over-promise a first watch and then drop the viewer mid-item. */
function playSlide(): void {
  const it = current.value;
  if (!it) return;
  const start = !target.value?.resumed;
  if (target.value) {
    emit('play', target.value.item, start);
    return;
  }
  seedPlate();
  emit('play', it, start);
}

function srcFor(it: LibraryItem): string {
  const a = art.value[it.id];
  if (!a) return '';
  return a.tries ? `${a.url}&_r=${a.tries}` : a.url;
}

function onArtError(it: LibraryItem): void {
  const a = art.value[it.id];
  if (!a) return;
  decoded.value[it.id] = false;
  const tries = a.tries + 1;
  if (a.wide && tries >= 3) {
    // No backdrop is coming; the poster art keeps the slide readable.
    art.value = { ...art.value, [it.id]: { ...a, tries: 0, url: '' } };
    void fetchArt(it, false);
    return;
  }
  if (tries > 4) return;
  art.value = { ...art.value, [it.id]: { ...a, tries } };
}

watch(
  () => [idx.value, props.items] as const,
  () => {
    need(current.value);
    need(props.items[(idx.value + 1) % props.items.length]);
  },
  { immediate: true },
);

function go(next: number): void {
  const n = props.items.length;
  if (!n) return;
  idx.value = (next + n) % n;
  // A dot click restarts the hold, because that is what the bar it just re-keyed restarts to.
  left = DUR;
  arm();
}

/* One timeout per slide instead of a fixed interval: the interval fired on its own schedule while
   the dot's bar was paused, so a hover of eight seconds bought the next slide one second of screen
   time, and a click could be overwritten a beat later. `left` is what the current slide is still
   owed, so pausing hands the remainder back rather than dropping it. */
function arm(): void {
  disarm();
  if (props.items.length < 2 || hovering.value || document.hidden) return;
  dueAt = performance.now() + left;
  timer = window.setTimeout(() => {
    timer = null;
    go(idx.value + 1);
  }, left);
}
function disarm(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
}
function hold(): void {
  if (timer !== null) left = Math.max(0, dueAt - performance.now());
  disarm();
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility);
});
onBeforeUnmount(() => {
  disarm();
  document.removeEventListener('visibilitychange', onVisibility);
});
/* The lobby is kept alive now, so the carousel has to stop counting while it is off screen — the
   timeout would otherwise fire against a detached tree and the reader would come back to a slide they
   never saw. `hovering` is cleared rather than trusted: leaving through the hero's own 详情 button
   detaches the element with the pointer still inside it, so no mouseleave ever arrives and the hold
   would stay on for good. */
onActivated(arm);
onDeactivated(() => {
  hold();
  hovering.value = false;
});
function onVisibility(): void {
  if (document.hidden) hold();
  else arm();
}
watch(hovering, paused => (paused ? hold() : arm()));
watch(
  () => props.items.length,
  () => {
    left = DUR;
    arm();
  },
);
</script>

<template>
  <section
    v-if="current"
    class="hero"
    @mouseenter="hovering = true"
    @mouseleave="hovering = false"
  >
    <div class="stage" :style="{ transform: `translate3d(0, ${Math.round(scroll * 0.28)}px, 0)` }">
      <div v-for="(it, i) in items" :key="it.id" class="slide" :class="{ on: i === idx && (!art[it.id]?.url || decoded[it.id]) }">
        <img v-if="art[it.id]?.url" :src="srcFor(it)" :class="{ wide: art[it.id].wide }" alt="" decoding="async" @load="decoded[it.id] = true" @error="onArtError(it)" />
      </div>
    </div>
    <div class="wash"></div>
    <div
      class="copy"
      :style="{ opacity: Math.max(0, 1 - scroll / 240), transform: `translate3d(0, ${Math.round(scroll * 0.4)}px, 0)` }"
    >
      <div v-if="current && art[current.id]?.url && !art[current.id].wide && decoded[current.id]" class="art">
        <img ref="plate" :src="srcFor(current)" alt="" />
      </div>

      <div class="text">
        <TitleArt :urls="titleArt[current.id] || []" :name="current.seriesName || current.name" />
        <div class="meta">
          <span class="kind">{{ kind }}</span>
          <span v-if="genres">{{ genres }}</span>
          <span v-if="date">{{ date }}</span>
          <span v-if="runtime">{{ runtime }}</span>
        </div>
        <p class="ov">{{ overview }}</p>
        <ScoreStrip v-if="current" :item="current" />
      </div>
      <div class="cta">
        <!-- Ungated, like the detail page's copy of this button. The old `v-if="playable || target"` asked
             the slide whether it *was* a file, so every Series slide lost it — which on a host whose
             shelves are all shows (measured: nyamedia, 5 of 5 slides) read as "this server cannot be
             played" while its own detail page offered 播放 one click later. A slide that holds no row in
             hand still has something to play; the page it opens resolves which episode. -->
        <HeroPlay :target="target" :busy="player.busy" @play="playSlide" />
        <button class="ghost" @click="openDetail">
          <svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8" /><path d="M12 11v6M12 7.6v.9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
          {{ playable ? '详情' : '查看' }}
        </button>
      </div>
    </div>

    <div v-if="items.length > 1" class="dots">
      <button
        v-for="(it, i) in items"
        :key="it.id"
        class="dot"
        :class="{ on: i === idx }"
        :aria-label="`第 ${i + 1} 张`"
        @click="go(i)"
      >
        <i v-if="i === idx" :key="idx" :class="{ paused: hovering }"></i>
      </button>
    </div>
  </section>
</template>

<style scoped>
.hero {
  position: relative;
  /* Was 66vh: at the default 1360x816 the first row's server line ended 5px below the window's
     bottom edge, and this is the whole fix — the line now clears the fold by 35px. A 16px top gap
     (matching the rail) was built here and reverted: the poster reads better bleeding into the
     window's top edge than hanging from a strip of page background. */
  height: clamp(460px, 61vh, 620px);
  /* The poster stops where the rail stops instead of running under the glass: the two columns are
     split, and the hero's left edge lands on the same x the first card rests at (226 / 84). */
  margin-left: var(--gutter);
  /* The 4px every row contributes below itself, so the poster -> header distance measures the same
     20px a header -> next-header distance does. It used to be -22px, which parked the first header
     6px *inside* the poster. */
  margin-bottom: 4px;
  overflow: hidden;
  transition: margin-left var(--rail-dur) var(--rail-ease);
}
/* Only the art layer parallaxes. A transform on the clipped .hero box makes Chromium emit a
   1px dark row along the layer's own edge, which reads as a black line at the hero's bottom;
   the stage's edges always land outside the clip, so the cut stays clean. */
.stage {
  position: absolute;
  inset: -3px 0;
  will-change: transform;
}
.stage .slide,
.stage img {
  position: absolute;
  inset: 0;
}
.stage img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: 50% 26%;
  /* The ramp stays attached to every slide and only the active one plays it. Declaring it on
     `.slide.on img` instead meant the departing frame lost its animation-name the moment `.on`
     moved, and with it the transform: measured 1211.6 -> 1134.0 CSS px in a single frame (6.8%)
     while that frame was still at full opacity, i.e. the old poster snapped inward as it faded.
     Paused rather than absent, it holds its scale and the crossfade continues the same move.
     Alternating rather than `forwards` because a slide is on screen for 9s of a 45s cycle: with
     `forwards` its clock keeps accumulating across visits (measured currentTime 16000 on the third
     turn) and the art stops moving for the rest of the session. */
  animation: kb 16s ease-in-out infinite alternate;
  animation-play-state: paused;
}
.stage img.wide {
  object-position: 50% 18%;
}
.slide {
  opacity: 0;
  transform: scale(1.03);
  transition: opacity 1.1s var(--ease), transform 1.1s var(--ease);
}
.slide.on {
  opacity: 1;
  transform: none;
}
.slide.on img {
  animation-play-state: running;
}
@keyframes kb {
  from {
    transform: scale(1.005);
  }
  to {
    transform: scale(1.09) translate3d(0, -1.4%, 0);
  }
}

/* Legibility the way the references do it: press the art *down* and put white type on it. Every
   「高光」 complaint in this app has been about a white plate covering the poster; a dark ramp solves
   the same problem without ever reading as one, and it keeps the art's top half — where the subject
   usually is — untouched.
   Round U took out the `mask-image` that used to cut the ramp at `--gutter`. The cut kept the
   frosted rail sampling bare art, but it drew a vertical line 12px from the rail's own border, and
   the panel's edge plus a parallel near-black edge is the ugliest possible pairing. The rail is
   88% opaque, so a ramp behind it only tints it by ~12%; a soft tint inside the panel is the
   cheaper crime. The bottom stop is 0.7, not 0.94 — the strip under the CTA must still read as art.
   Stops are in px from the bottom, not %, because the copy block has a fixed pixel height while the
   hero's height is `clamp(460px, 61vh, 620px)`: a percentage ramp under-backs the title's top line
   at the minimum window (measured CR 4.48) and over-darkens the art at the maximum. The tail keeps
   a percentage floor via max() so a short hero doesn't end up washed all the way to its top edge. */
.wash {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to top,
    rgba(6, 8, 14, 0.7) 0,
    rgba(6, 8, 14, 0.78) 60px,
    rgba(6, 8, 14, 0.78) 200px,
    rgba(6, 8, 14, 0.64) 280px,
    rgba(6, 8, 14, 0.34) max(370px, 68%),
    rgba(6, 8, 14, 0.08) max(440px, 86%),
    transparent 100%
  );
}

.copy {
  position: absolute;
  /* 32px off the poster's left edge. It used to be 0, on the theory that the hero's left edge *is*
     the content line (226) and the row titles and first card below rest on it — but the rail is a
     floating panel that ends at 214, so a flush copy put the largest text in the app 12px from that
     panel's edge and into the poster's bottom-left corner. 32 buys the corner air; the rows keep
     their own alignment, which is what the eye actually reads as a grid. */
  left: 32px;
  right: var(--side);
  bottom: 28px;
  display: flex;
  align-items: flex-end;
  gap: 20px;
  will-change: transform, opacity;
}
.art {
  width: 104px;
  flex: none;
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: var(--shadow);
  aspect-ratio: 2 / 3;
  /* It mounts on the decode, so this is the plate arriving rather than a fade over empty space. */
  animation: fade-in 0.5s var(--ease) both;
}
.art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.text {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 560px;
}
.meta {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 10px 0 8px;
  font-size: 13px;
  font-weight: 500;
  color: #dfe3ec;
  font-variant-numeric: tabular-nums;
}
.kind {
  font-weight: 600;
  color: #fff;
}
.ov {
  margin: 0 0 10px;
  font-size: 13.5px;
  line-height: 1.62;
  color: #d3d7e2;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  /* Claimed up front for the same reason the detail page reserves its four: the strip below this is the
     row the bottom of the column pins to, so a short synopsis does not just sit shorter, it drags the
     title and the meta line down by the difference, slide by slide, as the carousel turns. */
  min-height: calc(2 * 13.5px * 1.62);
}
/* Same reason as the strip's height below: this row is the last one in the column, so its box is what
   everything above it is measured from. The marks reach 26 when a platform logo has answered and 0 when
   none has, and the row cannot be allowed to move the title. */
.strip {
  min-height: 26px;
}
/* Below a ~754px window the 460px floor binds, so the copy block is then ~2/3 of the hero.
   Dropping the synopsis to one line pulls the title's top line down into the ramp's plateau. */
@media (max-height: 700px) {
  .ov {
    -webkit-line-clamp: 1;
    line-clamp: 1;
    min-height: calc(1 * 13.5px * 1.62);
  }
}
/* The actions answer for the hero's right edge: the copy column keeps its reading width, and the
   poster's empty right half carries the only two things worth clicking. `margin-left: auto` keeps
   them flush right even when the copy column shrinks at the minimum window. */
.cta {
  flex: none;
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}
.ghost {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 20px;
  border-radius: 999px;
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  background: rgba(255, 255, 255, 0.16);
  border: 1px solid rgba(255, 255, 255, 0.36);
  backdrop-filter: blur(10px);
  transition: transform var(--hov) var(--ease-out), background var(--hov) var(--ease), box-shadow var(--hov) var(--ease), border-color var(--hov) var(--ease);
}
.ghost:hover {
  background: rgba(255, 255, 255, 0.26);
  transform: translate3d(0, -2px, 0);
}
.ghost:active {
  transform: scale(0.96);
  transition-duration: 0.1s;
}

.dots {
  position: absolute;
  /* Centred on the poster band, not the window: the hero starts at the gutter, so the window's own
     middle would park the bar under the rail's right edge. */
  left: 50%;
  transform: translateX(-50%);
  bottom: 10px;
  display: flex;
  gap: 7px;
}
.dot {
  width: 22px;
  height: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.34);
  overflow: hidden;
  transition: width 0.35s var(--ease), background var(--hov) var(--ease);
}
.dot:hover {
  background: rgba(255, 255, 255, 0.55);
}
.dot.on {
  width: 40px;
  background: rgba(255, 255, 255, 0.24);
}
.dot i {
  display: block;
  height: 100%;
  width: 100%;
  background: #fff;
  transform-origin: left;
  animation: fill linear forwards;
  animation-duration: v-bind('DUR + "ms"');
}
.dot i.paused {
  animation-play-state: paused;
}
@keyframes fill {
  from {
    transform: scaleX(0);
  }
  to {
    transform: scaleX(1);
  }
}
</style>
