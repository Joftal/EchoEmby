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
    // 刷新 moved to the corner (components/PageRefresh.vue) and took F5 with it; what is left here is the
    // window's own key.
    if (e.key === 'Escape' && router.currentRoute.value.name !== 'login') void router.push('/');
  };
  window.addEventListener('keydown', handler);
});
onUnmounted(() => {
  if (handler) window.removeEventListener('keydown', handler);
});
</script>

<template>
  <!-- Two layers instead of one strip that tried to do both jobs.
       .grip is the draggable band and it paints *below* the page on purpose. The regions are merged in
       paint order — drag unions, no-drag subtracts — so a band that paints last re-covers everything
       under it and the whole top 44px of the window answers the mouse as window-drag no matter what is
       drawn there (measured on 浏览: a poster scrolled up to y=0 had 33% of its visible box dead). Painted
       first, every control's no-drag subtract lands after it and keeps its own box, while the band still
       drags wherever nothing interactive is painted — hero art, page background, headings.
       .bar is only the window buttons and keeps the --z-bar seat, because the page ground is opaque and
       would otherwise hide them. -->
  <div class="grip drag" />
  <header class="bar">
    <!-- 刷新当前页 lives in the corner now (components/PageRefresh.vue): it is about the page, not the window,
         and a chip up here read as one more piece of window chrome. -->
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
  </header>
</template>

<style scoped>
.grip {
  position: absolute;
  /* Starts at the rail's gutter, not at x=0: the nav panel begins 16px from the window's top, so a
     full-width band would put its region over the wordmark and the search button and both would stop
     responding. --nav-w is 0 without a rail, so the login page still drags across the whole width. */
  top: 0;
  right: 0;
  left: var(--nav-w);
  z-index: -1;
  height: var(--titlebar-h);
  /* --nav-w snaps (it is deliberately unregistered in App.vue), so without this the band's left edge
     jumps to 84 while the rail is still 202 wide, and for the rest of the sweep the panel's right half
     swallows clicks into window-dragging. Same duration and curve as the rail's own margin. */
  transition: left var(--rail-dur) var(--rail-ease);
}
.bar {
  position: absolute;
  top: 0;
  right: 0;
  z-index: var(--z-bar);
  height: var(--titlebar-h);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 8px;
  /* The box is 98x44 and only three 30px squares inside it are inked, so as a hit target it was a
     transparent plate laid over whatever scrolls past the top-right corner (measured: the last 浏览
     poster lost 14% of its painted box to this padding and the gaps between the buttons). Hand the
     mouse to the buttons only.
     It deliberately does not carry no-drag: the plate subtracted a 98px hole out of the band, and the
     buttons lose their own 30px squares by the global rule in base.css instead. */
  pointer-events: none;
}
.icon {
  pointer-events: auto;
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
