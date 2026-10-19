import { createRouter, createWebHashHistory } from 'vue-router';
import { ref } from 'vue';
import LoginView from './views/LoginView.vue';
import HomeView from './views/HomeView.vue';
import DetailView from './views/DetailView.vue';
import WorkView from './views/WorkView.vue';
import PlayerView from './views/PlayerView.vue';
import BrowseView from './views/BrowseView.vue';
import ServersView from './views/ServersView.vue';
import SettingsView from './views/SettingsView.vue';

/** Which way the arriving page travels, and the answer is the stack rather than the map: a page you go
 *  into comes from the right and the page you came from leaves to the left, and a page you come back to
 *  comes from the left again — the way out is the way you came in.
 *  A navigation the history did not produce (a rail button, a poster card, the title bar's Esc) is
 *  placed by rank: 详情 sits past every shelf it can be opened from, and the shelves sit in the order
 *  the rail lists them, so 首页 -> 设置 reads as going forward and Esc back to 首页 as going home. */
export const pageDir = ref<'push' | 'pop' | 'flat'>('flat');

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/player', name: 'player', component: PlayerView, meta: { overlay: true } },
    { path: '/login', name: 'login', component: LoginView, meta: { rank: -1 } },
    { path: '/', name: 'home', component: HomeView, meta: { rank: 0 } },
    { path: '/browse', name: 'browse', component: BrowseView, meta: { rank: 1 } },
    { path: '/servers', name: 'servers', component: ServersView, meta: { rank: 2 } },
    { path: '/settings', name: 'settings', component: SettingsView, meta: { rank: 3 } },
    { path: '/detail/:id', name: 'detail', component: DetailView, props: true, meta: { rank: 10 } },
    // A work keyed by its TMDB id rather than by a row this server holds, so the two pages sit at the same
    // depth: moving between them is a title changing, not going somewhere deeper or shallower.
    { path: '/work/:kind/:tmdbId', name: 'work', component: WorkView, props: true, meta: { rank: 10 } },
  ],
});

export default router;

router.beforeEach((to, from) => {
  // vue-router keeps the entries either side of the current one on the history state, so a navigation
  // whose target is the entry behind us is a back — the only honest reading of 「哪里来哪里去」, and one
  // no rank can give: 在看 -> 详情 -> back lands on a shelf whose rank is lower than 详情 either way,
  // but 在看 -> 详情 -> 设置 -> back has to arrive from the right, because that is where it came from.
  const h = window.history.state as { back?: string | null; forward?: string | null } | null;
  const step = Number(to.meta.rank ?? 0) - Number(from.meta.rank ?? 0);
  pageDir.value =
    h?.back === to.fullPath ? 'pop' : h?.forward === to.fullPath ? 'push' : step > 0 ? 'push' : step < 0 ? 'pop' : 'flat';
});

// The player route renders into a transparent window stacked on mpv's native
// surface; an opaque page background there hides the picture entirely.
router.afterEach(to => {
  document.documentElement.classList.toggle('overlay', !!to.meta.overlay);
});
