<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { take, type Handoff } from '../lib/handoff';

/** The hero art's crop, mirrored from DetailView's `.stage img`: the flight has to aim at it before the
 *  hero's own <img> exists, because that mounts only when the backdrop url arrives — after the flight
 *  is already under way. */
const HERO_POS = 'center 22%';
const DUR = 340;

const router = useRouter();
const el = ref<HTMLImageElement | null>(null);
const on = ref(false);
let anim: Animation | null = null;
let dropWait: (() => void) | null = null;
let stop: (() => void) | null = null;

onMounted(() => {
  stop = router.afterEach(() => {
    const h = take();
    if (!h || !h.url) return;
    void nextTick(() => void start(h));
  });
});
onBeforeUnmount(() => {
  stop?.();
  cancel();
});

function cancel(): void {
  anim?.cancel();
  anim = null;
  dropWait?.();
  dropWait = null;
  on.value = false;
}

async function start(h: Handoff): Promise<void> {
  cancel();
  // Two pages live in .content for the length of the wipe, and the one leaving is first in DOM order —
  // a bare querySelector landed on the lobby's hero, scrolled to -422, and flew the clone off the top
  // of the window. The entering page is the one carrying the enter class; outside a move it is the only
  // page there is.
  const pages = Array.from(document.querySelectorAll<HTMLElement>('.content > .page'));
  const page = pages.find(p => /-enter-active/.test(p.className)) || pages[pages.length - 1];
  const hero = page?.querySelector<HTMLElement>('.hero') || null;
  if (!page || !hero) return;
  const t = hero.getBoundingClientRect();
  on.value = true;
  await nextTick();
  const node = el.value;
  if (!node) return;
  node.src = h.url;
  const pos = getComputedStyle(hero).getPropertyValue('--hero-pos').trim() || HERO_POS;
  anim = node.animate(
    [
      { left: `${h.x}px`, top: `${h.y}px`, width: `${h.w}px`, height: `${h.h}px`, borderRadius: `${h.radius}px`, objectPosition: h.pos },
      { left: `${t.left}px`, top: `${t.top}px`, width: `${t.width}px`, height: `${t.height}px`, borderRadius: '0px', objectPosition: pos },
    ],
    { duration: DUR, easing: 'cubic-bezier(0.35, 0.05, 0.5, 0.9)', fill: 'forwards' },
  );
  anim.onfinish = () => land(page);
}

/** The clone holds the hero's rectangle until the hero's own frame has decoded, then dissolves into it.
 *  Fading earlier would uncover an empty band; the two are the same artwork at two crops, so the last
 *  140ms is a sharpening rather than a change of picture. A detail page opens on a skeleton hero that is
 *  a different element from the real one, so the wait watches the page rather than the hero it flew to. */
function land(page: HTMLElement): void {
  const node = el.value;
  if (!node) return;
  let settled = false;
  let obs: MutationObserver | null = null;
  const fade = (): void => {
    dropWait = null;
    const a = node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease' });
    a.onfinish = () => cancel();
  };
  function release(): void {
    if (settled) return;
    settled = true;
    obs?.disconnect();
    obs = null;
    window.clearTimeout(timer);
    fade();
  }
  function watch(): void {
    obs?.disconnect();
    obs = null;
    // A sibling switch cross-fades two frames inside the same band; waiting on the first one would
    // uncover a half-faded hero, so the clone holds until every frame in the band has decoded.
    const imgs = Array.from(page.querySelectorAll<HTMLImageElement>('.hero .stage img'));
    if (!imgs.length) {
      obs = new MutationObserver(watch);
      obs.observe(page, { childList: true, subtree: true });
      return;
    }
    const wait = imgs.find(i => !i.complete || !i.naturalWidth);
    if (!wait) {
      release();
      return;
    }
    wait.addEventListener('load', release, { once: true });
  }
  const timer = window.setTimeout(release, 1500);
  dropWait = (): void => {
    settled = true;
    obs?.disconnect();
    obs = null;
    window.clearTimeout(timer);
  };
  watch();
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
  will-change: left, top, width, height;
}
</style>
