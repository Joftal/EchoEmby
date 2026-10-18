<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

/** A horizontal band that switches like the home rows: a track with edge arrows that fade in on
 *  hover and hide themselves at either end. The cards come in through the slot, so the caller decides
 *  whether a band holds poster cards, cast heads or stills. */
const props = withDefaults(defineProps<{ title?: string; count?: number }>(), { title: '', count: 0 });

const track = ref<HTMLElement | null>(null);
const atStart = ref(true);
const atEnd = ref(true);

/** Where the last press meant to leave the band. A press landing on a running glide has to build on this rather
 *  than on the frame the animation happens to be passing, otherwise each new glide cancels the previous one and
 *  keeps only the part it already travelled: three quick presses used to move two thirds of the way. */
let want = 0;
let gliding = false;

function measure(): void {
  const el = track.value;
  // Skip a track with no laid-out box: both reads are 0 and `0 + 0 >= 0 - 2` satisfies "at end", which parks the
  // arrows off with nothing measured. The lobby proved the case — the same guard took 5 stuck rows at mount to 0.
  if (!el || !el.clientWidth) return;
  atStart.value = el.scrollLeft <= 2;
  atEnd.value = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
}

/** Any scroll that ends is the truth about where the band sits, so a wheel or a fling that lands between two
 *  cards becomes the starting point of the next press instead of a stale target. */
function settle(): void {
  const el = track.value;
  if (!el) return;
  want = el.scrollLeft;
  gliding = false;
}

/** One card's own width plus the gap, read off two adjacent cards. A share of the viewport would be the wrong
 *  unit: it lands partway into a card, and nothing re-aligns the row any more. */
function pitch(): number {
  const el = track.value;
  if (!el || el.children.length < 1) return 0;
  const kids = el.children;
  if (kids.length > 1) return kids[1].getBoundingClientRect().left - kids[0].getBoundingClientRect().left;
  return kids[0].getBoundingClientRect().width + (parseFloat(getComputedStyle(el).columnGap) || 0);
}

function nudge(dir: number): void {
  const el = track.value;
  const p = pitch();
  if (!el || p <= 0) return;
  const cards = Math.max(1, Math.round((el.clientWidth * 0.82) / p));
  const to = (gliding ? want : el.scrollLeft) + dir * cards * p;
  want = Math.min(Math.max(0, Math.round(to / p) * p), el.scrollWidth - el.clientWidth);
  gliding = true;
  el.scrollTo({ left: want, behavior: 'smooth' });
}

/** Two things move the truth about where the band sits, and neither of them is a scroll: a late TMDB payload
 *  replaces the heads or the stills while the track keeps its own width (数到三 s 剧照 row was caught holding
 *  11568px of overflow behind a right arrow that was still `off`, because the one measure at mount had seen
 *  one card), and the rail's sweep changes the width while the cards stay put. So watch both boxes. */
let ro: ResizeObserver | null = null;
let mo: MutationObserver | null = null;

onMounted(() => {
  measure();
  const el = track.value;
  if (!el) return;
  ro = new ResizeObserver(measure);
  ro.observe(el);
  mo = new MutationObserver(measure);
  mo.observe(el, { childList: true });
});
onBeforeUnmount(() => {
  ro?.disconnect();
  mo?.disconnect();
});
</script>

<template>
  <section class="hrow">
    <header v-if="title || $slots.header">
      <slot name="header">
        <h2>{{ title }}</h2>
        <span v-if="count" class="count">{{ count }}</span>
      </slot>
    </header>
    <div class="wrap">
      <button class="edge left" :class="{ off: atStart }" aria-label="向左" @click="nudge(-1)">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
      <div ref="track" class="track" @scroll.passive="measure" @scrollend="settle">
        <slot />
      </div>
      <button class="edge right" :class="{ off: atEnd }" aria-label="向右" @click="nudge(1)">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
    </div>
  </section>
</template>

<style scoped>
/* Same gutter math as the home rows so a band rests its first card on the content line and its art
   bleeds under the floating rail. The caller's .page defines --gutter/--tuck/--rail-x/--side. */
.hrow {
  margin-left: calc(var(--gutter) - var(--tuck) - var(--rail-x));
  padding: 16px 0 4px;
  transition: margin var(--rail-dur) var(--rail-ease);
}
.hrow header {
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
  font-size: 13px;
  font-weight: 600;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  opacity: 0;
  transform: translate3d(-4px, 0, 0);
  transition: opacity var(--hov) var(--ease) 0.1s, transform var(--hov) var(--ease-out) 0.1s;
}
.hrow:hover .count {
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
  /* No snap: proximity here behaved like mandatory, so it rewrote every ask onto its own grid (a press asked for
     1082 px and got 1002), yanked a fling back ~110 px when it overshoot, and re-anchored an interrupted glide in
     a single frame — the jump with no animation. nudge() counts whole cards instead, which is the same result with
     the destination decided once, in code. */
  padding: 6px var(--side) 20px var(--tuck);
  scrollbar-width: none;
}
.track::-webkit-scrollbar {
  height: 0;
}
.edge {
  position: absolute;
  top: calc(50% - 17px);
  z-index: 3;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
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
  left: calc(var(--tuck) + 7px);
}
.edge.right {
  right: calc(var(--side) + 7px);
}
.hrow:hover .edge {
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
