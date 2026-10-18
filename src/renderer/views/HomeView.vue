<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { LibraryItem } from '../../shared/types';
import HeroBanner from '../components/home/HeroBanner.vue';
import HeroSkeleton from '../components/HeroSkeleton.vue';
import RowScroller from '../components/home/RowScroller.vue';
import { beginPlay } from '../lib/handoff';
import { PLAYABLE, PLAYABLE_PAGE } from '../lib/resume';
import { useAppStore } from '../stores/app';
import { usePlayerStore } from '../stores/player';

const store = useAppStore();
const player = usePlayerStore();
const router = useRouter();

const scroller = ref<HTMLElement | null>(null);
const scroll = ref(0);
const atTop = ref(true);

/** The lobby promotes whatever the shelves hold, ranked by how well it fills a hero. */
const features = computed<LibraryItem[]>(() => {
  const seen = new Set<string>();
  const pool: LibraryItem[] = [];
  for (const row of store.rows) {
    if (row.key === 'resume') continue;
    for (const it of row.items) {
      // A slide the hero cannot play is worse than no slide: the same one table the detail page's hero
      // uses, so 合集/播放列表/资源库 rows never reach a button that would answer 「服务器出错了」.
      if (seen.has(it.id) || !PLAYABLE_PAGE.includes(it.type)) continue;
      seen.add(it.id);
      pool.push(it);
    }
  }
  const score = (it: LibraryItem): number =>
    (it.backdropImageTag ? 4 : 0) + (it.overview ? 2 : 0) + (it.communityRating && it.communityRating >= 7 ? 1 : 0);
  return pool.sort((a, b) => score(b) - score(a)).slice(0, 5);
});

const variant = (key: string) => (key === 'resume' ? 'still' : 'poster');
const cardWidth = (key: string) => (key === 'resume' ? 300 : 190);

/** The lobby's own in-progress rows. The hero needs them as candidates because a Series card has no
 *  position of its own — the episode it stopped on is the one already in 继续观看. */
const resume = computed(() => store.rows.find(r => r.key === 'resume')?.items || []);

/** The rAF throttle this used to have is what made the hero's parallax swim: deferring the write to
   the next frame's callback puts the art layer one whole frame behind the scroll it tracks, measured
   at 30.6-30.8px of error per frame while a wheel flick moves 110px (0.28 x 110 = one frame exactly;
   three rounds each way, 0.0-0.1px with this version). Scroll events are dispatched in the frame's
   scroll step, before its animation callbacks and before paint, and Vue flushes on a microtask, so
   assigning straight out of the handler lands in the frame that is already scrolling. */
function onScroll(): void {
  const el = scroller.value;
  if (!el) return;
  scroll.value = el.scrollTop;
  atTop.value = el.scrollTop < 420;
}

function toTop(): void {
  scroller.value?.scrollTo({ top: 0, behavior: 'smooth' });
}

function open(item: LibraryItem, autoplay = false): void {
  const page = item.type === 'Episode' ? item.parentId : item.id;
  if (!page) return;
  if (autoplay) beginPlay(page);
  router.push(`/detail/${page}`);
}

const toast = ref('');
let toastTimer: number | null = null;

function say(msg: string): void {
  toast.value = msg;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.value = ''), 3600);
}

async function onPlay(item: LibraryItem, fromStart = false): Promise<void> {
  if (PLAYABLE.includes(item.type)) {
    const ok = await player.play(item.id, fromStart);
    if (!ok) say(player.error || '无法开始播放');
    return;
  }
  /* A Series names no file, so this click cannot be honoured here: it opens the page that resolves which
     episode to start and asks that page to start it. A collection has nothing to resolve — a BoxSet has no
     first episode any more than a library does — so those pages still open without the note. */
  open(item, item.type === 'Series' || item.type === 'Season');
}

/* The lobby is kept alive, so its work happens on activate rather than mount: onActivated fires on the
   first mount too, and then again on every return. Returning used to cost a full rebuild — scroll back
   to the top, carousel back to slide one, 157 card entrances replayed, one 86ms frame. Now the tree is
   re-attached as it was and only the scroll position has to be put back by hand, because KeepAlive
   detaches the element and a detached scroller forgets where it was.
   The `rows` check stays: switching account calls store.invalidate(), which empties the rows while the
   cached tree sits detached, so the lobby has to notice it came back to nothing. */
let savedScroll = 0;

/** Re-attaching the kept tree restarts every CSS animation inside it: measured on 返回, 50 posters played
 *  `card-in` from opacity 0 again, under the page that was pushing in. An entrance is a one-shot, so an element is
 *  pinned the moment its own has finished — which leaves the resting style exactly where the fill had it,
 *  since every one of these keyframes starts at opacity 0 and none holds a value the element lacks. Rows
 *  further down that have not been revealed yet are untouched and still animate when they scroll in, and
 *  the loops that never end — the carousel, the shimmers — are not entrances and are not matched here.
 *  Snapping them from `onActivated` was the first version and does not work: the hook runs ~80ms before the
 *  re-inserted tree gets its animations, so it finished 14 of them and missed all 50. */
const ENTRANCE = /^(fade-in|card-in|row-in)$/;

function pinEntrance(e: AnimationEvent): void {
  if (ENTRANCE.test(e.animationName)) (e.target as HTMLElement).style.animationName = 'none';
}

onActivated(async () => {
  const el = scroller.value;
  if (el) {
    el.scrollTop = savedScroll;
    scroll.value = savedScroll;
    atTop.value = savedScroll < 420;
  }
  if (!store.ready) await store.init();
  if (!store.account) {
    router.replace('/login');
    return;
  }
  if (!store.rows.length) await store.loadHome();
});

onDeactivated(() => {
  savedScroll = scroller.value?.scrollTop ?? 0;
});

onBeforeUnmount(() => {
  if (toastTimer !== null) window.clearTimeout(toastTimer);
});
</script>

<template>
  <div ref="scroller" class="page" @scroll.passive="onScroll" @animationend="pinEntrance">
    <Transition name="hero-swap">
      <HeroBanner v-if="features.length" :items="features" :scroll="scroll" :resume="resume" @play="onPlay" @open="open" />
      <HeroSkeleton v-else layout="lobby" />
    </Transition>

    <p v-if="store.error && !store.rows.length" class="err">
      {{ store.error }}
      <button @click="store.loadHome()">重试</button>
    </p>

    <div class="flow">
      <RowScroller
        v-for="row in store.rows"
        :key="row.key"
        :title="row.title"
        :items="row.items"
        :variant="variant(row.key)"
        :width="cardWidth(row.key)"
        @play="onPlay"
      />

      <div v-if="store.loading && !store.rows.length">
        <div v-for="n in 2" :key="n" class="rsk">
          <div class="hd"></div>
          <div class="cards">
            <div v-for="m in 9" :key="m" class="cd"></div>
          </div>
        </div>
      </div>
    </div>

    <Transition name="fade">
      <button v-if="!atTop" class="top no-drag" aria-label="回到顶部" @click="toTop">
        <svg viewBox="0 0 24 24" width="17" height="17"><path d="M12 19V6M6 12l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
    </Transition>

    <Transition name="toast">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.page {
  /* The rail is a floating layer, so the content line is the glass edge plus its 12px margin — not
     the old extra --side, which left a hard seam of background between the panel and the posters.
     In both states that lands 12px off the rail's right edge (rail 12+202 / 12+60 against 226 / 84).
     The right inset is the plain page margin and never moves with it. */
  --side: clamp(10px, 1.8vw, 26px);
  --gutter: var(--nav-w);
  /* The rail's own left offset. It is also the x where the poster band is clipped, so a card travelling
     left stays whole until the panel's border hides the cut. */
  --rail-x: 12px;
  /* Clip -> content line. 214 = the expanded gutter (226) less --rail-x; the resting card lands on
     --gutter in both states, and the rail's right edge is always 12px short of it. */
  --tuck: 214px;
  position: relative;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  padding-bottom: 46px;
}
/* The rows keep painting above the hero's parallax layer, which is a transformed element. */
.flow {
  position: relative;
  z-index: 1;
  /* The poster band clips here rather than at the scroller's own edge. This box never moves, so the
     cut sits under the rail's border in both states; the rows shift inside it instead. */
  margin-left: var(--rail-x);
  overflow-x: clip;
}
/* A cold lobby answers every shelf in the same frame (measured: all nine rows and the hero inserted at
   4570ms), so the rows take the detail page's cascade instead of arriving as one block. Opacity only —
   the cards inside each row already rise 14px on their own stagger, and a transform here would stack on
   top of that. */
.flow > .row {
  animation: fade-in 0.34s var(--ease) both;
}
.flow > .row:nth-child(2) {
  animation-delay: 0.05s;
}
.flow > .row:nth-child(3) {
  animation-delay: 0.1s;
}
.flow > .row:nth-child(4) {
  animation-delay: 0.15s;
}
.flow > .row:nth-child(5) {
  animation-delay: 0.2s;
}
.flow > .row:nth-child(n + 6) {
  animation-delay: 0.25s;
}
.err {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--danger);
  padding: 26px var(--side) 26px var(--gutter);
  transition: padding var(--rail-dur) var(--rail-ease);
}
.err button {
  padding: 5px 13px;
  border-radius: 999px;
  background: var(--bg-elev);
  border: 1px solid var(--line);
  color: var(--text);
  font-size: 13px;
  transition: background var(--hov) var(--ease), color var(--hov) var(--ease);
}
.err button:hover {
  background: var(--ink);
  border-color: transparent;
  color: var(--on-ink);
}

.rsk {
  /* The real row is 134.15px of chrome plus the card frame: 16 above the header, the header's 27.9
     line box plus its 11 margin, the track's 6px above the cards, and the track's 20 plus the row's
     own 4 below them. The skeleton splits the same way, so a row that arrives from the network never
     moves the rows underneath it. */
  padding: 16px var(--side) 24px calc(var(--gutter) - var(--rail-x));
  /* The real row above tweens its inset across the collapse; without this the skeleton jumped to the
     collapsed line on frame one and ran the rest of the sweep beside itself (measured: the gap between
     this box's left edge and the hero skeleton's swung from its constant 12px to 109.8px mid-scan). */
  transition: padding-left var(--rail-dur) var(--rail-ease);
}
.rsk .hd {
  /* 6.5 + 15 + 17.4 = the real header's 27.9px line box plus its 11px margin, as a slimmer bar. */
  width: 150px;
  height: 15px;
  border-radius: var(--r-badge);
  margin: 6.5px 0 17.4px;
  background: var(--shimmer);
  background-size: var(--sk-tile) 100%;
  animation: sh 1.3s linear infinite;
}
.cards {
  display: flex;
  gap: 14px;
  padding-top: 6px;
  overflow: hidden;
}
.cd {
  width: 190px;
  flex: none;
  aspect-ratio: 2 / 3;
  /* .label's 9px of padding plus two text lines. */
  margin-bottom: 49.3px;
  border-radius: var(--radius);
  background: var(--shimmer);
  background-size: var(--sk-tile) 100%;
  animation: sh 1.3s linear infinite;
}
.cd:nth-child(n + 7) {
  opacity: 0.55;
}
/* The first row is 继续观看, whose cards are 300px 16:9 stills, not 190px posters. */
.rsk:first-child .cd {
  width: 300px;
  aspect-ratio: 16 / 9;
}

.top {
  position: fixed;
  right: var(--side);
  bottom: 22px;
  z-index: var(--z-top);
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  color: var(--text);
  background: rgba(255, 255, 255, 0.86);
  border: 1px solid var(--line);
  backdrop-filter: blur(12px);
  box-shadow: var(--shadow);
  transition: background var(--hov) var(--ease), color var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.top:hover {
  background: var(--ink);
  color: #fff;
  transform: translate3d(0, -2px, 0);
}
.top:active {
  transform: scale(0.9);
}

</style>
