<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { LibraryItem } from '../../../shared/types';
import MediaCard from './MediaCard.vue';
import { createLoopRail, RAIL_PRESS, type LoopRail } from '../../lib/looprail';

/* `count` is the number beside the title, and it only means anything when the rail is the whole answer.
   A shelf cut to fit the page would otherwise print its own length where the reader reads a category
   total, and these servers' library rows carry no total to put in its place. */
const props = withDefaults(
  defineProps<{ title: string; items: LibraryItem[]; variant?: 'poster' | 'still'; width?: number; count?: boolean }>(),
  { variant: 'poster', width: 190, count: true },
);
const emit = defineEmits<{ (e: 'play', item: LibraryItem): void }>();

const root = ref<HTMLElement | null>(null);
const track = ref<HTMLElement | null>(null);
const atStart = ref(true);
const atEnd = ref(true);
const looped = ref(false);
let rail: LoopRail | null = null;
let observer: IntersectionObserver | null = null;

/** Where the last press meant to leave the row. A press landing on a running glide builds on this rather than on
 *  the frame the animation happens to be passing: asking from there cancels the previous glide and keeps only the
 *  part it already travelled, so three quick presses moved two thirds of the way. */
let want = 0;
let gliding = false;

function measure(): void {
  const el = track.value;
  // A box that has not been laid out has nothing to say. An observer's first notification arrives while a
  // `content-visibility: auto` row below the fold is still skipped, and reading it there finds clientWidth 0,
  // which satisfies "at end" and switched the right arrow off on five lobby rows at mount (measured).
  if (!el || !el.clientWidth) return;
  const r = rail;
  looped.value = !!r?.looped;
  // A row that loops has no ends to report, and an arrow that goes nowhere is the one thing a loop
  // cannot leave behind.
  atStart.value = r?.looped ? false : el.scrollLeft <= 2;
  atEnd.value = r?.looped ? false : el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
}

/** Any scroll that ends is the truth about where the row sits, so a wheel or a fling that lands between two cards
 *  becomes the starting point of the next press instead of a stale target. */
function settle(): void {
  const el = track.value;
  if (!el) return;
  // Step over a copy before reading where the row landed: the offset the glide stopped at is a
  // position the reader was never shown, and the next press would build its target on it.
  rail?.normalize(true);
  want = el.scrollLeft;
  gliding = false;
}

function nudge(dir: number): void {
  const el = track.value;
  // One card's width plus the gap, read off two adjacent cards. A share of the viewport would be the
  // wrong unit: it lands partway into a card, and nothing re-anchors the row any more.
  const r = rail;
  const p = r?.pitch() || 0;
  if (!el || p <= 0) return;
  const cards = Math.max(1, Math.round((el.clientWidth * RAIL_PRESS) / p));
  // The rail turns the ask into somewhere the row can actually be: the same card on the card grid,
  // and one whole band earlier when the press walks past the end of its copies — clamping there used to
  // park the row between two posters.
  const to = (gliding ? want : el.scrollLeft) + dir * cards * p;
  want = r ? r.place(to) : Math.max(0, Math.min(Math.round(to / p) * p, el.scrollWidth - el.clientWidth));
  gliding = true;
  if (r) r.glideTo(want);
  else el.scrollTo({ left: want, behavior: 'smooth' });
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

/** Same two watches as the detail bands: the track's own box (the rail's sweep, a window resize, and the moment
 *  `content-visibility: auto` stops skipping this row's layout — a row that was below the fold when it mounted has
 *  no laid-out cards to measure, so its mount-time read said "nothing to scroll"), and its child list. */
let ro: ResizeObserver | null = null;
let mo: MutationObserver | null = null;

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
  const tr = track.value;
  if (tr) {
    rail = createLoopRail(tr, { onChange: () => measure(), onShift: d => { want += d; } });
    ro = new ResizeObserver(measure);
    ro.observe(tr);
    mo = new MutationObserver(measure);
    mo.observe(tr, { childList: true });
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
  ro?.disconnect();
  mo?.disconnect();
  rail?.destroy();
  rail = null;
});
</script>

<template>
  <section ref="root" class="row" @pointerenter="alignEdges">
    <header>
      <h2>{{ title }}</h2>
      <span v-if="count" class="count">{{ items.length }}</span>
    </header>

    <div class="wrap">
      <button class="edge left" :class="{ off: !looped && atStart }" aria-label="向左" @click="nudge(-1)">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
      <div ref="track" class="track" @scroll.passive="measure" @scrollend="settle">
        <MediaCard
          v-for="(it, i) in items"
          :key="it.id"
          :item="it"
          :variant="variant"
          :width="width"
          :index="i % 12"
          @play="emit('play', $event)"
        />
      </div>
      <button class="edge right" :class="{ off: !looped && atEnd }" aria-label="向右" @click="nudge(1)">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
    </div>
  </section>
</template>

<style scoped>
.row {
  /* The only thing that moves here is the row box, and it slides inside .flow's static clip. The gutter is paid by
     this margin and the scroller's own padding never changes, so the cards travel with the box instead of being
     re-inset under it mid-sweep (measured: a 142 = 214 - 72 inset delta parked them on the collapsed line while
     the rail was still travelling). */
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
  /* No snap, for the three things it cost on the detail page's bands: it rewrote a press's destination onto its
     own grid (1082 px asked, 1002 landed), yanked a fling back ~110 px when it overshot, and re-anchored a glide
     interrupted by a wheel in a single frame. nudge() counts whole cards instead, so the alignment is decided once. */
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
