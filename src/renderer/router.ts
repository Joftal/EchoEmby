import { createRouter, createWebHashHistory } from 'vue-router';
import { ref } from 'vue';
import LoginView from './views/LoginView.vue';
import HomeView from './views/HomeView.vue';
import DetailView from './views/DetailView.vue';
import WorkView from './views/WorkView.vue';
import PlayerView from './views/PlayerView.vue';
import BrowseView from './views/BrowseView.vue';
import CalendarView from './views/CalendarView.vue';
import ServersView from './views/ServersView.vue';
import SettingsView from './views/SettingsView.vue';

/** Which way the arriving page travels, and the answer is the stack rather than the map: a page you go
 *  into comes from the right and the page you came from leaves to the left, and a page you come back to
 *  comes from the left again — the way out is the way you came in.
 *  A navigation the history did not produce (a rail button, a poster card, the title bar's Esc) is
 *  placed by rank: 详情 sits past every shelf it can be opened from, and the shelves sit in the order
 *  the rail lists them, so 首页 -> 设置 reads as going forward and Esc back to 首页 as going home.
 *  `flat` is only the transparent player window: it sits over mpv's picture, so it must neither travel nor
 *  be travelled to. Every other pair is two pages, including the ones that share a route — 详情 to 详情 and
 *  one work to the next now rebuild the page (App.vue keys the component on the path), so they travel like
 *  everything else. Two shelves in two components (在看 and 追剧日历) are two pages too, whatever their ranks
 *  say. */
export const pageDir = ref<'push' | 'pop' | 'flat'>('flat');

/** Which way the panes *inside* one page travel. The 在看/收藏/资源库 shelves are one component answering a
 *  query, so switching between them never reaches `pageDir` — the element that would move is the same
 *  element. BrowseView reads this instead and moves its own pane with the same clock. The outer layer and
 *  this one cannot both run: a navigation that swaps the component has no pane to swap, and one that keeps
 *  it has no page. */
export const paneDir = ref<'push' | 'pop'>('push');

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/player', name: 'player', component: PlayerView, meta: { overlay: true } },
    { path: '/login', name: 'login', component: LoginView, meta: { rank: -1 } },
    { path: '/', name: 'home', component: HomeView, meta: { rank: 0 } },
    { path: '/browse', name: 'browse', component: BrowseView, meta: { rank: 1 } },
    // Same depth as the shelves: the calendar is another way to look at what 收藏 and 在看 already list,
    // so moving between them travels sideways across one window rather than going deeper.
    { path: '/calendar', name: 'calendar', component: CalendarView, meta: { rank: 1 } },
    { path: '/servers', name: 'servers', component: ServersView, meta: { rank: 2 } },
    { path: '/settings', name: 'settings', component: SettingsView, meta: { rank: 3 } },
    { path: '/detail/:id', name: 'detail', component: DetailView, props: true, meta: { rank: 10 } },
    // A work keyed by its TMDB id rather than by a row this server holds, so the two pages sit at the same
    // depth: neither one is inside the other, so the move between them is the plain sideways one a rank
    // difference cannot describe — 详情 -> 作品页 arrives from the right, and history back returns from the left.
    { path: '/work/:kind/:tmdbId', name: 'work', component: WorkView, props: true, meta: { rank: 10 } },
  ],
});

export default router;

router.beforeEach((to, from) => {
  // vue-router keeps the entry behind the current one on the history state, so a navigation whose target is
  // the page we came from is a return — the only honest reading of 「哪里来哪里去」, and one no rank can give:
  // 在看 -> 收藏 -> 在看 walks the rail back onto the shelf behind us, and it arrives from the left even
  // though both shelves sit at rank 1. Measured here: that click reads `back=/browse?kind=favorites` at the
  // guard and lands as a pop, while the click ahead of it reads `back=/` and lands as a push.
  // A navigation the browser produced (Alt+←, a page's own 返回) is the case where the guard already runs
  // with the *destination's* state, whose `back` names the entry one further along. That state does carry one
  // true fact: its `forward` is the entry the browser just left. So `forward === from` reads a return too —
  // measured on 详情 2735 -> 2493 by 返回, where the destination's state is `back=/browse?kind=favorites`
  // (useless) and `forward=/detail/2735` (exactly the page being left). This is what puts the equal-rank
  // pairs the rank cannot separate — 在看 <-> 追剧日历, 详情 <-> 作品页, and now 详情 <-> 详情 — on the
  // right side on the way back. A programmatic push can never satisfy it: the source's `forward` is the
  // entry ahead of it, never itself.
  const h = window.history.state as { back?: string | null; forward?: string | null } | null;
  const back = h?.back === to.fullPath || h?.forward === from.fullPath;
  paneDir.value = back ? 'pop' : 'push';
  // The overlay is the one exception the rank cannot see through: the player window is transparent over
  // mpv's picture, so it must neither travel nor be travelled to.
  if (to.meta.overlay === true || from.meta.overlay === true) pageDir.value = 'flat';
  else if (back) pageDir.value = 'pop';
  else if (h?.forward === to.fullPath) pageDir.value = 'push';
  else pageDir.value = Number(to.meta.rank ?? 0) >= Number(from.meta.rank ?? 0) ? 'push' : 'pop';
});

// The player route renders into a transparent window stacked on mpv's native
// surface; an opaque page background there hides the picture entirely.
router.afterEach(to => {
  document.documentElement.classList.toggle('overlay', !!to.meta.overlay);
});
