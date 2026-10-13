<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { LibraryItem } from '../../../shared/types';
import MediaCard from './MediaCard.vue';

const props = withDefaults(
  defineProps<{ title: string; items: LibraryItem[]; variant?: 'poster' | 'still'; width?: number }>(),
  { variant: 'poster', width: 190 },
);
const emit = defineEmits<{ (e: 'play', item: LibraryItem): void }>();

const root = ref<HTMLElement | null>(null);
const track = ref<HTMLElement | null>(null);
const atStart = ref(true);
const atEnd = ref(true);
let observer: IntersectionObserver | null = null;

function measure(): void {
  const el = track.value;
  if (!el) return;
  atStart.value = el.scrollLeft <= 2;
  atEnd.value = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
}

function nudge(dir: number): void {
  const el = track.value;
  if (!el) return;
  el.scrollBy({ left: dir * Math.round(el.clientWidth * 0.82), behavior: 'smooth' });
}

/** The arrows centre on the poster band, not on the card: MediaCard's second label line is `v-if`'d,
    so the cards in a row are not all the same height, while every poster shares one band. Read on
    entry because the row is `content-visibility: auto` — a row below the fold has no laid-out poster
    to measure — and on the row, not the scroller, so hovering the title cannot reveal the discs at
    their fallback position and then slide them. */
function alignEdges(e: Event): void {
  const wrap = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('.wrap');
  const frame = wrap?.querySelector<HTMLElement>('.card .frame');
  if (!wrap || !frame) return;
  const f = frame.getBoundingClientRect();
  wrap.style.setProperty('--band-cy', `${(f.top + f.bottom) / 2 - wrap.getBoundingClientRect().top}px`);
}

onMounted(() => {
  measure();
  const el = root.value;
  if (el) {
    observer = new IntersectionObserver(
      entries => {
        if (entries.some(x => x.isIntersecting)) {
          el.classList.add('in');
          observer?.disconnect();
        }
      },
      { rootMargin: '0px 0px -8% 0px' },
    );
    observer.observe(el);
  }
  window.addEventListener('resize', measure);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  window.removeEventListener('resize', measure);
});
</script>

<template>
  <section ref="root" class="row" @pointerenter="alignEdges">
    <header>
      <h2>{{ title }}</h2>
      <span class="count">{{ items.length }}</span>
    </header>

    <div class="wrap">
      <button class="edge left" :class="{ off: atStart }" aria-label="向左" @click="nudge(-1)">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
      <div ref="track" class="track" @scroll.passive="measure">
        <MediaCard
          v-for="(it, i) in items"
          :key="it.id"
          :item="it"
          :variant="variant"
          :width="width"
          :index="i"
          @play="emit('play', $event)"
        />
      </div>
      <button class="edge right" :class="{ off: atEnd }" aria-label="向右" @click="nudge(1)">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
    </div>
  </section>
</template>

<style scoped>
.row {
  /* The only thing that moves here is the row box, and it slides inside .flow's static clip. Putting
     the gutter on the scroller's own padding instead looks identical at rest but breaks the sweep:
     scroll-padding-left cannot be transitioned, so the snap port jumps to its destination on frame one
     and rewrites scrollLeft by the whole padding delta (measured: 142 = 214 - 72), parking the cards at
     the collapsed line while the rail travels. A constant padding keeps that delta out of existence. */
  margin-left: calc(var(--gutter) - var(--tuck) - var(--rail-x));
  padding: 16px 0 4px;
  transition: margin var(--rail-dur) var(--rail-ease);
  /* Only two or three rows are on screen at a time and the sweep repaints whatever is laid out:
     skipping the rest measured +12fps across three interleaved rounds. `auto` in the intrinsic
     size keeps each row's own height once it has rendered, so the scroller does not jump. */
  content-visibility: auto;
  /* The content box of a real poster row (419px measured, less the 20px of row padding). At 320px a
     row that had never been on screen reserved 99px less than it then took, so every scroll that
     brought one into range shoved the rest of the page down and re-lengthened the scrollbar. */
  contain-intrinsic-size: auto 399px;
}
.row header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding-left: var(--tuck);
  margin-bottom: 11px;
}
h2 {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.2px;
  margin: 0;
  color: var(--text);
}
.count {
  /* 13px, not 12: at 12px a CJK glyph's topmost stroke row gets no antialiasing row at all, which
     reads as the character being cut. The header's height is set by the 18px h2, so this is free. */
  font-size: 13px;
  font-weight: 600;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  opacity: 0;
  transform: translate3d(-4px, 0, 0);
  transition: opacity var(--hov) var(--ease) 0.1s, transform var(--hov) var(--ease-out) 0.1s;
}
.row:hover .count {
  opacity: 1;
  transform: none;
}
.wrap {
  position: relative;
}
.track {
  display: flex;
  gap: 14px;
  overflow-x: auto;
  scroll-behavior: smooth;
  scroll-snap-type: x proximity;
  /* Both insets are constant: the row's margin carries the rail, so the snap port and the resting card
     can never disagree. */
  scroll-padding: 0 var(--side) 0 var(--tuck);
  padding: 6px var(--side) 20px var(--tuck);
  scrollbar-width: none;
}
.track::-webkit-scrollbar {
  height: 0;
}
.edge {
  position: absolute;
  /* --band-cy is the poster band's centre, measured by alignEdges; the fallback only matters before
     the first hover, while the disc is invisible anyway. */
  top: var(--band-cy, 50%);
  z-index: 3;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  margin-top: -17px;
  border-radius: 50%;
  color: var(--text);
  background: rgba(255, 255, 255, 0.86);
  border: 1px solid var(--line);
  backdrop-filter: blur(12px);
  box-shadow: var(--shadow);
  opacity: 0;
  transform: scale(0.86);
  transition: opacity var(--hov) var(--ease), transform var(--hov) var(--ease-out), background var(--hov) var(--ease);
}
.edge.left {
  /* The wrap slides with the row, so this constant offset is always 7px past the content line. */
  left: calc(var(--tuck) + 7px);
}
.edge.right {
  /* Measured from the card band's right line (--side in from the window), not from the wrap, whose
     edge is the window itself: at right:10px this button stood 14.5px outside the band while its
     twin on the left sits 7px inside its own line, so the pair was 21.5px out of agreement. */
  right: calc(var(--side) + 7px);
}
.row:hover .edge {
  opacity: 1;
  transform: none;
}
.edge:hover {
  background: var(--ink);
  border-color: transparent;
  color: #fff;
}
.edge:active {
  transform: scale(0.88);
}
.edge.off {
  opacity: 0 !important;
  pointer-events: none;
}
</style>
