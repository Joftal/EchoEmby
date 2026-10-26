<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppSideNav from './components/AppSideNav.vue';
import AppTitleBar from './components/AppTitleBar.vue';
import { pageDir } from './router';
import { useAppStore } from './stores/app';

const route = useRoute();
const store = useAppStore();
const overlay = computed(() => route.meta.overlay === true);
const collapsed = ref(localStorage.getItem('echoemby.nav') === 'min');

const showNav = computed(() => !overlay.value && route.name !== 'login' && !!store.account);

/** The rail's width is what every page insets itself by, and it is unknown until the session read lands.
 *  Left alone, that read drags the whole page 223px sideways on every start and every login, because each
 *  inset tweens its own margin over --rail-dur (measured: content at x 3, rail already at 226, both
 *  crawling for 440ms). The tween belongs to the collapse button, not to a restore, so the gutter is held
 *  still until the rail has actually been on screen for a frame. */
const booted = ref(false);
watch(showNav, async (on) => {
  if (!on) { booted.value = false; return; }
  if (booted.value) return;
  await nextTick();
  requestAnimationFrame(() => requestAnimationFrame(() => { booted.value = true; }));
}, { immediate: true });

function toggle(): void {
  collapsed.value = !collapsed.value;
  localStorage.setItem('echoemby.nav', collapsed.value ? 'min' : 'full');
}

onMounted(() => {
  document.documentElement.classList.toggle('overlay', overlay.value);
  void store.init();
  // The player window runs this same file, and it is the one place that must not listen: it has no
  // lobby to write back into, and a subscriber there would re-ask the resume row on every stop.
  if (!overlay.value) store.watchPlayback();
});
</script>

<template>
  <div class="shell" :class="{ nav: showNav, min: collapsed, booted }">
    <AppTitleBar v-if="!overlay" />
    <Transition name="rail">
      <AppSideNav v-if="showNav" :collapsed="collapsed" @toggle="toggle" />
    </Transition>
    <main class="content">
      <router-view v-slot="{ Component }">
        <!-- type="animation" because the move is keyframes, not a transition (see base.css). No mode:
             both pages are on screen for the length of the push, which is the whole effect — one page
             carries the other off. `pageDir` (router.ts) picks the direction, and its 'flat' is the hard
             cut kept for the one swap that must not travel: out of the transparent player window. A
             navigation that keeps this component instance gets no classes at all, since there is no
             element to swap. keep-alive covers the lobby
             only: it is the one page a reader returns to often, and the one whose rebuild was
             measurable (scroll position, carousel slide and 157 card entrances all replayed). No :key
             on the component: DetailView reuses its instance across a sibling switch and that reuse is
             what lets the second title fade over the first instead of tearing the page down. -->
        <transition :name="overlay ? 'fade' : pageDir" type="animation">
          <keep-alive include="HomeView">
            <component :is="Component" />
          </keep-alive>
        </transition>
      </router-view>
    </main>
  </div>
</template>

<style scoped>
/* --nav-w is deliberately left unregistered: interpolating it document-wide cost about half the
   frame rate on a 156-card page (measured 19fps vs 35fps on Chromium 130). It snaps, and each
   element that insets itself by it tweens its own padding/offset instead, which is cheaper and
   lands on the same curve as the rail. */
.shell {
  --nav-w: 0px;
  position: relative;
  height: 100%;
}
/* Closing: the labels have nowhere left to sit, so they dissolve on the same sweep the width takes
   instead of leading it, and the wipe-in delay only applies when opening. CSS reads transition
   timing off the after-change style, so flipping these here covers every descendant at once. */
.shell.min {
  --fade-t: 0.32s;
  --fade-d: 0s;
}
.shell.nav {
  --nav-w: 226px;
}
.shell.nav.min {
  --nav-w: 84px;
}
/* Every gutter-driven inset is written as `transition: margin-left/padding var(--rail-dur)`, so zeroing
   the clock here holds the whole page still while the session read lands. See `booted` above. */
.shell:not(.booted) {
  --rail-dur: 0s;
}
/* The content layer spans the whole window so hero art runs under the floating rail.
   It clips the push: a page travelling in from the right is 100% wider than the window for as long as it
   moves, and without this the overflow region grows and the frame can scroll sideways. The ground the two
   pages slide past each other on belongs to base.css, where the move is, and is painted only while one is
   running — so the player window, which never pushes, stays transparent over mpv. */
.content {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.rail-enter-active {
  transition: opacity 0.4s var(--ease), transform 0.5s var(--ease-out);
}
.rail-enter-from {
  opacity: 0;
  transform: translate3d(-16px, 8px, 0);
}
</style>
