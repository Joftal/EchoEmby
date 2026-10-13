<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();
const maximized = ref(false);

const send = (action: 'minimize' | 'maximize' | 'close') => {
  window.echoemby.ui.window(action);
};

const onMax = () => {
  send('maximize');
  maximized.value = !maximized.value;
};

let handler: ((e: KeyboardEvent) => void) | null = null;
onMounted(() => {
  handler = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && router.currentRoute.value.name !== 'login') void router.push('/');
  };
  window.addEventListener('keydown', handler);
});
onUnmounted(() => {
  if (handler) window.removeEventListener('keydown', handler);
});
</script>

<template>
  <header class="bar drag">
    <div class="wins no-drag">
      <button class="icon" @click="send('minimize')">
        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 12h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
      </button>
      <button class="icon" @click="onMax">
        <svg v-if="!maximized" viewBox="0 0 24 24" width="13" height="13"><rect x="5" y="5" width="14" height="14" rx="2.5" stroke="currentColor" stroke-width="1.6" fill="none" /></svg>
        <svg v-else viewBox="0 0 24 24" width="13" height="13"><rect x="7" y="7" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6" fill="none" /><path d="M10 7V5.5A1.5 1.5 0 0 1 11.5 4H18a2 2 0 0 1 2 2v6.5A1.5 1.5 0 0 1 18.5 14H17" stroke="currentColor" stroke-width="1.6" fill="none" /></svg>
      </button>
      <button class="icon close" @click="send('close')">
        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.bar {
  position: absolute;
  /* Starts at the rail's gutter, not at x=0: the nav panel now begins 16px from the window's top, so
     a full-width strip would paint its drag region over the wordmark and the search button (the bar
     is --z-bar, above the rail's --z-rail) and both would stop responding. --nav-w is 0 without a
     rail, so the login and overlay pages still drag across the whole width. */
  top: 0;
  right: 0;
  left: var(--nav-w);
  z-index: var(--z-bar);
  height: var(--titlebar-h);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 8px 0 16px;
  /* --nav-w snaps (it is deliberately unregistered in App.vue), so without this the drag band's left
     edge jumps to 84 while the rail is still 202 wide, and for the rest of the sweep the panel's
     right half swallows clicks into window-dragging. Same duration and curve as the rail's own
     margin, so the two stay 12px apart the whole way. */
  transition: left var(--rail-dur) var(--rail-ease);
}
.wins {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 2px;
}
.icon {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: var(--radius);
  color: var(--text-dim);
  transition: background var(--hov) var(--ease), color var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.icon:hover {
  background: var(--bg-elev-2);
  color: var(--text);
}
.icon:active {
  transform: scale(0.92);
}
.icon.close:hover {
  background: #e11d48;
  color: #fff;
}
</style>
