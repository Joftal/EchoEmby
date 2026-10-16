<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { take, type Handoff } from '../lib/handoff';

const DUR = 340;
const DISSOLVE = 120;
/** The ceiling on waiting for the plate's own <img> to paint. It carries the same url the clone has been
 *  drawing, so this is a cache hit and a decode, not a fetch. */
const LAND_WAIT = 240;

const router = useRouter();
const el = ref<HTMLImageElement | null>(null);
const on = ref(false);
let stop: (() => void) | null = null;
let anim: Animation | null = null;
/** The dissolve is a second animation on the same node, and it ends at opacity 0 with `fill: forwards`.
 *  Left running it wins over the next flight forever, so every clone after the first one flies invisibly —
 *  measured: the second click on 新加入 showed nothing until the dissolve brought the opacity back up. */
let fade: Animation | null = null;
let landTimer: number | null = null;

onMounted(() => {
  stop = router.afterEach(() => {
    const h = take();
    if (h && h.url) void nextTick(() => void start(h));
  });
});
onBeforeUnmount(() => {
  stop?.();
  cancel();
});

function cancel(): void {
  anim?.cancel();
  anim = null;
  fade?.cancel();
  fade = null;
  if (landTimer !== null) {
    window.clearTimeout(landTimer);
    landTimer = null;
  }
  on.value = false;
}

/** The rectangle the plate will occupy once the page carrying it has finished moving.
 *
 *  A page arrival translates its children in from the side (`arrive-right` in styles/base.css), so the
 *  plate's rect read mid-move sits ~57px to the right of where it lands — the measured error the flight
 *  used to finish with, the clone parked beside a poster that had since slid out from under it. Every
 *  transform in this chain is a translation (the page move and the hero's own scroll parallax), so
 *  subtracting their offsets leaves the resting rectangle. */
function restRect(el: HTMLElement, page: HTMLElement): { left: number; top: number; width: number; height: number } {
  const r = el.getBoundingClientRect();
  let x = 0;
  let y = 0;
  for (let n: HTMLElement | null = el; n && n !== page; n = n.parentElement) {
    const m = new DOMMatrix(getComputedStyle(n).transform);
    x += m.m41;
    y += m.m42;
  }
  return { left: r.left - x, top: r.top - y, width: r.width, height: r.height };
}

async function start(h: Handoff): Promise<void> {
  cancel();
  // The page move honours prefers-reduced-motion through base.css; a WAAPI duration is not CSS and would
  // keep flying a 340ms poster across a window the user asked to hold still.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // Two pages live in .content for the length of the wipe, and the one leaving is first in DOM order —
  // a bare querySelector landed on the lobby's hero and flew the clone off the top of the window. The
  // entering page is the one carrying the enter class; outside a move it is the only page there is.
  const pages = Array.from(document.querySelectorAll<HTMLElement>('.content > .page'));
  const page = pages.find(p => /-enter-active/.test(p.className)) || pages[pages.length - 1];
  const plate = page?.querySelector<HTMLElement>('.hero .art');
  if (!page || !plate) return;
  const t = restRect(plate, page);
  if (!t.width || !t.height) return;

  const node = el.value;
  if (!node) return;
  node.src = h.url;
  // Laid out once, at the destination, and then moved with a transform: left/top/width/height are layout
  // and cost a reflow per frame, which is what made the old flight stutter. transform-origin 0 0 is what
  // lets the translate and the scale be read off the two rectangles' top-left corners.
  node.style.left = `${t.left}px`;
  node.style.top = `${t.top}px`;
  node.style.width = `${t.width}px`;
  node.style.height = `${t.height}px`;
  const sx = h.w / t.width;
  const sy = h.h / t.height;
  const radius = parseFloat(getComputedStyle(plate).borderRadius) || 0;
  on.value = true;
  anim = node.animate(
    [
      {
        transform: `translate3d(${h.x - t.left}px, ${h.y - t.top}px, 0) scale(${sx}, ${sy})`,
        borderRadius: `${h.radius / sx}px`,
      },
      { transform: 'translate3d(0, 0, 0) scale(1, 1)', borderRadius: `${radius}px` },
    ],
    { duration: DUR, easing: 'cubic-bezier(0.35, 0.05, 0.5, 0.9)', fill: 'forwards' },
  );
  anim.onfinish = () => land(plate);
}

/** The clone hands the same pixels to the plate's own <img> and goes away. */
function land(plate: HTMLElement): void {
  const node = el.value;
  if (!node) return;
  const target = plate.querySelector('img');
  let released = false;
  const release = (): void => {
    // One shot: the waiting path calls this from a load listener, an error listener and a timeout, and a
    // second pass would restart the dissolve from the middle.
    if (released) return;
    released = true;
    if (landTimer !== null) {
      window.clearTimeout(landTimer);
      landTimer = null;
    }
    target?.removeEventListener('load', release);
    target?.removeEventListener('error', release);
    fade = node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DISSOLVE, easing: 'ease', fill: 'forwards' });
    fade.onfinish = () => cancel();
  };
  // A plate with no <img> of its own is the loading dent, and the clone is what the user sees in it; hold
  // until the real art mounts rather than dissolving into nothing.
  if (!target) {
    landTimer = window.setTimeout(release, LAND_WAIT);
    return;
  }
  if (target.complete && target.naturalWidth) {
    release();
    return;
  }
  target.addEventListener('load', release, { once: true });
  target.addEventListener('error', release, { once: true });
  landTimer = window.setTimeout(release, LAND_WAIT);
}
</script>

<template>
  <img v-show="on" ref="el" class="flyart" alt="" />
</template>

<style scoped>
.flyart {
  position: fixed;
  z-index: var(--z-fly);
  pointer-events: none;
  object-fit: cover;
  transform-origin: 0 0;
  will-change: transform;
}
</style>
