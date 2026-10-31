<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { topVisible } from '../lib/pageScroll';
import { useAppStore } from '../stores/app';

const store = useAppStore();

/** F5 is what every browser taught the hand to press for 「this page is stale」, and this app builds its pages
 *  from a disk cache, so a plain reload would only re-read the same answers. The shortcut lives beside the
 *  button because both answer the same question, and the window keeps only its own Escape. */
let onKey: ((e: KeyboardEvent) => void) | null = null;
onMounted(() => {
  onKey = (e: KeyboardEvent) => {
    if (e.key !== 'F5' || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    void store.refreshPage();
  };
  window.addEventListener('keydown', onKey);
});
onUnmounted(() => {
  if (onKey) window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <!-- The corner stack: when the page can scroll back, 回到顶部 appears at the bottom and this button rises one
       button + one gap so the two read as a pair on the same right edge. Out of the title bar because a chip
       between 最小化 and 最大化 reads as window furniture — the corner is where this app already puts 「about
       this page」 things. -->
  <button class="refresh no-drag" :class="{ busy: store.refreshing, stacked: topVisible }" title="刷新当前页（F5）" aria-label="刷新当前页" @click="store.refreshPage()">
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 4.6v4.2h-4.2" />
    </svg>
  </button>
</template>

<style scoped>
/* Sits where 回到顶部 sits when that button is away (22px), and rises one button + one 10px gap when it
   appears. Same surface as PageTop so the two read as a pair. */
/* --side is set per view (every page root carries the same clamp), and this button is a sibling of the view,
   not a child, so it cannot inherit one: the fallback repeats the same expression. Without it the declaration
   is invalid at computed-value time and the circle lands at the window's left edge. */
.refresh {
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
  transition: background var(--hov) var(--ease), color var(--hov) var(--ease), transform var(--hov) var(--ease-out),
    bottom 200ms var(--ease);
}
.refresh.stacked {
  bottom: 70px;
}
.refresh:hover {
  background: var(--ink);
  color: #fff;
  transform: translate3d(0, -2px, 0);
}
.refresh:active {
  transform: scale(0.9);
}
/* Busy is the one state that may differ from 回到顶部: the ring turns and takes the accent, so a slow server
   answers 「it heard you」 instead of looking dead. */
.refresh.busy {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 40%, var(--line));
}
.refresh.busy svg {
  animation: spin 900ms linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
