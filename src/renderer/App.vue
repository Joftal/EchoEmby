<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppSideNav from './components/AppSideNav.vue';
import AppTitleBar from './components/AppTitleBar.vue';
import PageRefresh from './components/PageRefresh.vue';
import PageTop from './components/PageTop.vue';
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
  if (!overlay.value) {
    store.watchPlayback();
    // 关键数据的自动更新: the main process retires a library the moment it sees one move, but the renderer keeps
    // its own ten-minute memo, so the find only becomes visible through this window.
    onBeforeUnmount(window.echoemby.cache.onStale(() => store.libraryChanged()));
  }
});
</script>

<template>
  <div class="shell" :class="{ nav: showNav, min: collapsed, booted }">
    <AppTitleBar v-if="!overlay" />
    <PageRefresh v-if="!overlay" />
    <PageTop v-if="!overlay" />
    <Transition name="rail">
      <AppSideNav v-if="showNav" :collapsed="collapsed" @toggle="toggle" />
    </Transition>
    <main class="content">
      <router-view v-slot="{ Component }">
        <!-- type="animation" because the move is keyframes, not a transition (see base.css). No mode:
             both pages are on screen for the length of the push, which is the whole effect — one page
             carries the other off. `pageDir` (router.ts) picks the direction, and its 'flat' is the hard
             cut kept for the one swap that must not travel: out of the transparent player window.
             The key is the path, so a page is rebuilt whenever the thing it is about changes — a 相似卡
             that opens another 详情, one work to the next — which is what gives those pairs the same push
             every other pair has. It is deliberately not `fullPath`: the 在看/收藏/资源库 shelves are one
             component answering a query, and keying on the query would tear the whole shelf down for what
             the pane layer inside it already slides. keep-alive covers the lobby only: it is the one page a
             reader returns to often, and the one whose rebuild was measurable (scroll position, carousel
             slide and 157 card entrances all replayed). -->
        <transition :name="overlay ? 'fade' : pageDir" type="animation">
          <!-- 刷新当前页 appends the tick to the key, so the page is rebuilt instead of reused: a new key
               also misses the keep-alive entry, which is the only way the lobby re-reads its rows. The note
               sits outside the wrapper on purpose - a comment inside it counts as a second child. -->
          <keep-alive include="HomeView">
            <component :is="Component" :key="route.path + ':' + store.reloadTick" />
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
