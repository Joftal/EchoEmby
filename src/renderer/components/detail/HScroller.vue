<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

/** A horizontal band that switches like the home rows: a snap track with edge arrows that fade in on
 *  hover and hide themselves at either end. The cards come in through the slot, so the caller decides
 *  whether a band holds poster cards, cast heads or stills. */
const props = withDefaults(defineProps<{ title?: string; count?: number }>(), { title: '', count: 0 });

const track = ref<HTMLElement | null>(null);
const atStart = ref(true);
const atEnd = ref(true);

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

onMounted(() => {
  measure();
  window.addEventListener('resize', measure);
});
onBeforeUnmount(() => window.removeEventListener('resize', measure));
</script>

<template>
  <section class="hrow">
    <header v-if="title">
      <h2>{{ title }}</h2>
      <span v-if="count" class="count">{{ count }}</span>
    </header>
    <div class="wrap">
      <button class="edge left" :class="{ off: atStart }" aria-label="向左" @click="nudge(-1)">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
      <div ref="track" class="track" @scroll.passive="measure">
        <slot />
      </div>
      <button class="edge right" :class="{ off: atEnd }" aria-label="向右" @click="nudge(1)">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
    </div>
  </section>
</template>

<style scoped>
.hrow header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 14px;
}
h2 {
  font-size: 16px;
  font-weight: 650;
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
  scroll-snap-type: x proximity;
  padding: 4px 0 8px;
  scrollbar-width: none;
}
.track::-webkit-scrollbar {
  height: 0;
}
.track > :deep(*) {
  scroll-snap-align: start;
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
  left: 6px;
}
.edge.right {
  right: 6px;
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
