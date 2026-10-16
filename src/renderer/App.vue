<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
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

function toggle(): void {
  collapsed.value = !collapsed.value;
  localStorage.setItem('echoemby.nav', collapsed.value ? 'min' : 'full');
}

onMounted(() => {
  document.documentElement.classList.toggle('overlay', overlay.value);
  void store.init();
});
</script>

<template>
  <div class="shell" :class="{ nav: showNav, min: collapsed }">
    <AppTitleBar v-if="!overlay" />
    <Transition name="rail">
      <AppSideNav v-if="showNav" :collapsed="collapsed" @toggle="toggle" />
    </Transition>
    <main class="content">
      <router-view v-slot="{ Component }">
        <!-- type="animation" because the move is keyframes, not a transition (see base.css). No mode:
             the arrival starts while the departure is still running, which is what puts a new page on
             screen immediately instead of 400ms of body wash. keep-alive covers the lobby only — it is
             the one page a reader returns to often and the one whose rebuild was measurable (scroll
             position, carousel slide and 157 card entrances all replayed). No :key on the component:
             DetailView reuses its instance across a sibling switch and that reuse is what lets the
             second title dissolve into the first instead of tearing the page down. -->
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
/* The content layer spans the whole window so hero art runs under the floating rail. */
.content {
  position: absolute;
  inset: 0;
}
.rail-enter-active {
  transition: opacity 0.4s var(--ease), transform 0.5s var(--ease-out);
}
.rail-enter-from {
  opacity: 0;
  transform: translate3d(-16px, 8px, 0);
}
</style>
