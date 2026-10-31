<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { outermostScroller, pageScroller, topVisible } from '../lib/pageScroll';

const route = useRoute();
const box = ref<HTMLElement | null>(null);

/** Home waited for 420px; a page that is only 1100px tall can never reach that, so the threshold
 *  shrinks with the page (never below 120px, never above 420px). */
function showsAt(el: HTMLElement): number {
  const room = el.scrollHeight - el.clientHeight;
  return Math.min(420, Math.max(120, room * 0.2));
}

function read(el: HTMLElement | null): void {
  box.value = el;
  topVisible.value = !!el && el.isConnected && el.scrollTop > showsAt(el);
}

/** The scroller this page answers for. A page may scroll an inner list while the page itself does not
 *  scroll at all (the 弹幕 console does), and 回到顶部 must not ride along with such a list. */
let current: HTMLElement | null = null;

/** True while a navigation is still swapping pages: the leaving page keeps firing scroll events, and it is
 *  still in the DOM, so anything read now would belong to the page the reader just left. */
let booting = false;

function adopt(): void {
  current = pageScroller();
  read(current);
}

function onScroll(e: Event): void {
  if (booting) return;
  if (!(e.target instanceof Element) || !e.target.isConnected) return;
  if (!current || !current.isConnected) current = pageScroller();
  const el = outermostScroller(e.target);
  if (!el || el !== current) return;
  read(el);
}

function toTop(): void {
  box.value?.scrollTo({ top: 0, behavior: 'smooth' });
}

let settle = 0;
watch(
  () => route.fullPath,
  () => {
    topVisible.value = false;
    box.value = null;
    current = null;
    booting = true;
    window.clearTimeout(settle);
    // 页面刚挂上时可能还没长到能滚；700ms 也越过了 380ms 的翻页动画，这时离开的页面已经不在 DOM 里
    settle = window.setTimeout(() => {
      booting = false;
      adopt();
    }, 700);
  },
);

onMounted(() => {
  document.addEventListener('scroll', onScroll, true);
  adopt();
});

onBeforeUnmount(() => {
  document.removeEventListener('scroll', onScroll, true);
  window.clearTimeout(settle);
});
</script>

<template>
  <Transition name="fade">
    <button v-if="topVisible" class="to-top no-drag" aria-label="回到顶部" title="回到顶部" @click="toTop">
      <svg viewBox="0 0 24 24" width="17" height="17">
        <path d="M12 19V6M6 12l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  </Transition>
</template>

<style scoped>
/* Same surface as the refresh button above it: the two are one stack in every page. */
.to-top {
  position: fixed;
  right: var(--side, clamp(10px, 1.8vw, 26px));
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
.to-top:hover {
  background: var(--ink);
  color: #fff;
  transform: translate3d(0, -2px, 0);
}
.to-top:active {
  transform: scale(0.9);
}
</style>
