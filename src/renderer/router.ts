import { createRouter, createWebHashHistory } from 'vue-router';
import { ref } from 'vue';
import LoginView from './views/LoginView.vue';
import HomeView from './views/HomeView.vue';
import DetailView from './views/DetailView.vue';
import PlayerView from './views/PlayerView.vue';
import BrowseView from './views/BrowseView.vue';
import ServersView from './views/ServersView.vue';
import SettingsView from './views/SettingsView.vue';

/** Which way the arriving page travels. Depth decides the axis, and depth is the one thing the reader
 *  can verify on screen: 详情 is a level under the shelves, so going in comes from the right and coming
 *  back from the left, while two shelves — or two titles inside 详情 — have nothing between them and
 *  only cross over. History position was the other candidate and it disagrees with what is on screen:
 *  the title bar's Esc pushes 首页 rather than going back, and a rail switch to 设置 is a 「forward」
 *  that arrives from nowhere. */
export const pageDir = ref<'push' | 'pop' | 'flat'>('flat');

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/player', name: 'player', component: PlayerView, meta: { overlay: true } },
    { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
    { path: '/', name: 'home', component: HomeView },
    { path: '/browse', name: 'browse', component: BrowseView },
    { path: '/servers', name: 'servers', component: ServersView },
    { path: '/settings', name: 'settings', component: SettingsView },
    { path: '/detail/:id', name: 'detail', component: DetailView, props: true, meta: { tier: 1 } },
  ],
});

export default router;

router.beforeEach((to, from) => {
  const step = Number(to.meta.tier ?? 0) - Number(from.meta.tier ?? 0);
  pageDir.value = step > 0 ? 'push' : step < 0 ? 'pop' : 'flat';
});

// The player route renders into a transparent window stacked on mpv's native
// surface; an opaque page background there hides the picture entirely.
router.afterEach(to => {
  document.documentElement.classList.toggle('overlay', !!to.meta.overlay);
});
