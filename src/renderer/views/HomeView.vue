<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { LibraryItem } from '../../shared/types';
import HeroBanner from '../components/home/HeroBanner.vue';
import RowScroller from '../components/home/RowScroller.vue';
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
      if (seen.has(it.id) || it.type === 'CollectionFolder' || it.type === 'BoxSet') continue;
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

function open(item: LibraryItem): void {
  const target = item.type === 'Episode' ? item.parentId : item.id;
  if (target) router.push(`/detail/${target}`);
}

const toast = ref('');
let toastTimer: number | null = null;

function say(msg: string): void {
  toast.value = msg;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.value = ''), 3600);
}

async function onPlay(item: LibraryItem): Promise<void> {
  if (item.type === 'Series' || item.type === 'CollectionFolder' || item.type === 'BoxSet') {
    open(item);
    return;
  }
  const ok = await player.play(item.id);
  if (!ok) say(player.error || '无法开始播放');
}

onMounted(async () => {
  if (!store.ready) await store.init();
  if (!store.account) {
    router.replace('/login');
    return;
  }
  if (!store.rows.length) await store.loadHome();
});

onBeforeUnmount(() => {
  if (toastTimer !== null) window.clearTimeout(toastTimer);
});
</script>

<template>
  <div ref="scroller" class="page" @scroll.passive="onScroll">
    <HeroBanner v-if="features.length" :items="features" :scroll="scroll" @play="onPlay" @open="open" />
    <div v-else class="hero-sk"></div>

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

.hero-sk {
  /* Mirrors .hero exactly: the same clamp (so mounting the real poster does not shove every row below
     it down the 74px the old, shorter placeholder was off by) and the same gutter, which this box was
     missing — the skeleton ran full-bleed to x=0 while the poster arrives at 226.
     It sweeps like the rows below it rather than sitting on a radial tint: the old gradient was a
     3-point step from the page, so the top half of the loading screen read as a blank window. */
  height: clamp(460px, 61vh, 620px);
  margin-left: var(--gutter);
  margin-bottom: 4px;
  background: var(--shimmer);
  background-size: 220% 100%;
  animation: sh 1.3s linear infinite;
  transition: margin-left var(--rail-dur) var(--rail-ease);
}
.rsk {
  /* The real row is 134.15px of chrome plus the card frame: 16 above the header, the header's 27.9
     line box plus its 11 margin, the track's 6px above the cards, and the track's 20 plus the row's
     own 4 below them. The skeleton splits the same way, so a row that arrives from the network never
     moves the rows underneath it. */
  padding: 16px var(--side) 24px calc(var(--gutter) - var(--rail-x));
  /* The real row above tweens its inset across the collapse; without this the skeleton jumped to the
     collapsed line on frame one and ran the rest of the sweep beside itself (measured: the gap between
     this box's left edge and .hero-sk's swung from its constant 12px to 109.8px mid-scan). */
  transition: padding-left var(--rail-dur) var(--rail-ease);
}
.rsk .hd {
  /* 6.5 + 15 + 17.4 = the real header's 27.9px line box plus its 11px margin, as a slimmer bar. */
  width: 150px;
  height: 15px;
  border-radius: var(--r-badge);
  margin: 6.5px 0 17.4px;
  background: var(--shimmer);
  background-size: 220% 100%;
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
  background-size: 220% 100%;
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

.toast {
  position: fixed;
  left: 50%;
  bottom: 26px;
  z-index: var(--z-toast);
  transform: translateX(-50%);
  padding: 9px 18px;
  border-radius: 999px;
  font-size: 13px;
  color: var(--text);
  background: rgba(255, 255, 255, 0.86);
  border: 1px solid var(--line);
  backdrop-filter: blur(14px) saturate(180%);
  box-shadow: var(--shadow);
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.28s var(--ease), transform 0.34s var(--ease-out);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate3d(-50%, 14px, 0);
}
</style>
