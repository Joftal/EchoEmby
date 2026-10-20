<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

/** One line of text longer than the line it sits in: the title is laid out twice side by side and the pair
 *  slides left by exactly one copy plus the gap, so the frame the loop ends on is pixel-for-pixel the frame it
 *  started on — no seam, no reversal. A line that loses less than a glyph keeps the caller's ellipsis and
 *  stays still.
 *
 *  The animation is made per line rather than written as CSS keyframes because the rest at each end is a fixed
 *  1.1s while the scroll is a fixed 48px a second: one percentage set cannot hold both, and a rest that grows
 *  with the line would park this row's longest title (355 characters, measured) for 19s at a stretch.
 *
 *  The caller keeps owning the type: `<LoopTitle class="etitle" :text="…">` falls through to this root, so its
 *  font, colour and `text-overflow` rule still apply. */
const props = defineProps<{ text: string }>();

const MIN_CUT = 14; // one 14px glyph. The lines below this in this row lost 3px and 10px: not worth a move.
const GAP = 44; // the breath between one copy's last stroke and the next copy's first
const SPEED = 48; // 3.4 glyphs a second — slow enough to read off the screen, one pace for every line
const REST = 1.1; // seconds standing at the head of the title, and again as the loop wraps

const line = ref<HTMLElement | null>(null);
const mq = ref<HTMLElement | null>(null);
const copy = ref<HTMLElement | null>(null);
const run = ref(false);
let anim: Animation | null = null;
let wide = 0;
let ro: ResizeObserver | null = null;

/** A Range, not `scrollWidth`: inside a box that clips, `scrollWidth` reports the clip. 第 8 集 lays out
 *  283px of glyphs in a 280px line and the box answers 280 — the cut would never be seen. */
function cut(): number {
  const el = line.value;
  if (!el) return 0;
  const r = document.createRange();
  r.selectNodeContents(el);
  return r.getBoundingClientRect().width - el.clientWidth;
}

function stop(): void {
  anim?.cancel();
  anim = null;
}

/** The distance is one copy plus the gap, read from the laid-out copy and not from the clip: a line that
 *  overflows by 50px still has to travel its whole length before its tail can be read.
 *
 *  `getBoundingClientRect`, because `offsetWidth` rounds — and a rounded distance wraps one pixel short of
 *  the copy's own left edge, which reads as a hitch every cycle. */
function start(): void {
  const el = mq.value;
  const c = copy.value;
  stop();
  if (!el || !c) return;
  const d = c.getBoundingClientRect().width + GAP;
  const travel = d / SPEED;
  const at = REST / (travel + 2 * REST);
  anim = el.animate(
    [
      { offset: 0, transform: 'translate3d(0, 0, 0)' },
      { offset: at, transform: 'translate3d(0, 0, 0)' },
      { offset: 1 - at, transform: `translate3d(${-d}px, 0, 0)` },
      { offset: 1, transform: `translate3d(${-d}px, 0, 0)` }
    ],
    { duration: (travel + 2 * REST) * 1000, iterations: Infinity, easing: 'linear' }
  );
}

function decide(): void {
  // This app's global block turns every animation into a 0.01ms flash; for a marquee that is a line that
  // never rests, so under that preference the ellipsis stays and nothing moves.
  run.value = !matchMedia('(prefers-reduced-motion: reduce)').matches && cut() >= MIN_CUT;
  if (run.value) void nextTick(start);
}

onMounted(() => {
  wide = line.value?.clientWidth ?? 0;
  decide();
  ro = new ResizeObserver(() => {
    const w = line.value?.clientWidth ?? 0;
    if (w === wide) return;
    wide = w;
    stop();
    run.value = false;
    void nextTick(decide);
  });
  if (line.value) ro.observe(line.value);
});

watch(
  () => props.text,
  () => {
    stop();
    run.value = false;
    nextTick(decide);
  }
);

onBeforeUnmount(() => {
  stop();
  ro?.disconnect();
});
</script>

<template>
  <p ref="line" class="loop-title" :class="{ run }" :style="{ '--mq-gap': GAP + 'px' }"><span v-if="run" ref="mq" class="mq"><span ref="copy" class="cp">{{ text }}</span><span class="cp" aria-hidden="true">{{ text }}</span></span><template v-else>{{ text }}</template></p>
</template>

<style scoped>
/* The mechanics this effect needs, so it works wherever it is dropped; the caller's class owns the type. */
.loop-title { white-space: nowrap; overflow: hidden; }
/* With the tail reachable by waiting, an ellipsis would claim the line ends where it does not. */
.loop-title.run { text-overflow: clip; }
.mq { display: flex; width: max-content; gap: var(--mq-gap, 44px); }
.cp { flex: none; }
</style>
