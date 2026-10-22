<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { createLoopRail, RAIL_PRESS, type LoopRail } from '../../lib/looprail';

/** A horizontal band that switches like the home rows: a track with edge arrows that fade in on
 *  hover and carry on past either end. The cards come in through the slot, so the caller decides
 *  whether a band holds poster cards, cast heads or stills. */
const props = withDefaults(defineProps<{ title?: string; count?: number }>(), { title: '', count: 0 });

const track = ref<HTMLElement | null>(null);
const atStart = ref(true);
const atEnd = ref(true);
const looped = ref(false);
let rail: LoopRail | null = null;

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
  const r = rail;
  looped.value = !!r?.looped;
  // A band that loops has no ends to report, and an arrow that goes nowhere is the one thing a loop
  // cannot leave behind.
  atStart.value = r?.looped ? false : el.scrollLeft <= 2;
  atEnd.value = r?.looped ? false : el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
}

/** Any scroll that ends is the truth about where the band sits, so a wheel or a fling that lands between two
 *  cards becomes the starting point of the next press instead of a stale target. */
function settle(): void {
  const el = track.value;
  if (!el) return;
  // Step over a copy before reading where the band landed: the offset the glide stopped at is a
  // position the reader was never shown, and the next press would build its target on it.
  rail?.normalize(true);
  want = el.scrollLeft;
  gliding = false;
}

function nudge(dir: number): void {
  const el = track.value;
  // One card's own width plus the gap, read off two adjacent cards. A share of the viewport would be
  // the wrong unit: it lands partway into a card, and nothing re-aligns the band any more.
  const r = rail;
  const p = r?.pitch() || 0;
  if (!el || p <= 0) return;
  const cards = Math.max(1, Math.round((el.clientWidth * RAIL_PRESS) / p));
  // The rail turns the ask into somewhere the band can actually be: the same card on the card grid,
  // and one whole band earlier when the press walks past the end of its copies — clamping there used to
  // park the band between two cards.
  const to = (gliding ? want : el.scrollLeft) + dir * cards * p;
  want = r ? r.place(to) : Math.max(0, Math.min(Math.round(to / p) * p, el.scrollWidth - el.clientWidth));
  gliding = true;
  if (r) r.glideTo(want);
  else el.scrollTo({ left: want, behavior: 'smooth' });
}

/** Pull one card into view, and leave the band alone when the card can already be read. The caller decides
 *  which card is worth the travel — the episode band opens on the one the viewer stopped in — so this only
 *  answers "is it where a reader looks". The window is the track's own box minus its padding, because the
 *  left padding is the tuck the art slides under the floating rail in: a card parked in it is not found.
 *  The destination is the same `want` a press builds on and the same ease, so a glide nobody asked for cannot
 *  eat the next arrow click.
 *  Answers whether the band is left in a state where that card can be read: false means there was no box to
 *  measure yet, which is the caller's cue to ask again once the band exists. */
function focusCard(i: number): boolean {
  const el = track.value;
  // Counted among the band's own cards: the copies a looping band keeps at either end are children of
  // the track too, and an index into `children` would hand back the wrong episode.
  const card = rail ? rail.cardAt(i) : (el?.children[i] as HTMLElement | undefined);
  if (!el || !el.clientWidth || !card) return false;
  const b = el.getBoundingClientRect();
  const r = card.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const viewL = b.left + (parseFloat(cs.paddingLeft) || 0);
  const viewR = b.right - (parseFloat(cs.paddingRight) || 0);
  if (r.left >= viewL + 2 && r.right <= viewR - 2) return true;
  const to = el.scrollLeft + (r.left + r.width / 2 - (viewL + viewR) / 2);
  // Asked of the rail, so a card the copies hold at the far end is reached by the copy the band can show.
  // Not snapped: this ask is a centring position, not a press's whole-card step.
  want = rail ? rail.place(to, false) : Math.max(0, Math.min(el.scrollWidth - el.clientWidth, Math.round(to)));
  gliding = true;
  if (rail) rail.glideTo(want);
  else el.scrollTo({ left: want, behavior: 'smooth' });
  return true;
}

defineExpose({ focusCard });

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
  rail = createLoopRail(el, { onChange: () => measure(), onShift: d => { want += d; } });
  ro = new ResizeObserver(measure);
  ro.observe(el);
  mo = new MutationObserver(measure);
  mo.observe(el, { childList: true });
});
onBeforeUnmount(() => {
  ro?.disconnect();
  mo?.disconnect();
  rail?.destroy();
  rail = null;
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
      <button class="edge left" :class="{ off: !looped && atStart }" aria-label="向左" @click="nudge(-1)">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
      <div ref="track" class="track" @scroll.passive="measure" @scrollend="settle">
        <slot />
      </div>
      <button class="edge right" :class="{ off: !looped && atEnd }" aria-label="向右" @click="nudge(1)">
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
