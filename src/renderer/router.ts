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
import DanmakuDebugView from './views/DanmakuDebugView.vue';

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
    // 弹幕调试 is opened from 设置 and, like it, is a page you leave back onto the shelves: one rank deeper than
    // 设置 so going in travels forward and coming back travels home.
    { path: '/danmaku', name: 'danmaku', component: DanmakuDebugView, meta: { rank: 4 } },
    { path: '/detail/:id', name: 'detail', component: DetailView, props: true, meta: { rank: 10 } },
    // A work keyed by its TMDB id rather than by a row this server holds, so the two pages sit at the same
    // depth: neither one is inside the other, so the move between them is the plain sideways one a rank
    // difference cannot describe — 详情 -> 作品页 arrives from the right, and history back returns from the left.
    { path: '/work/:kind/:tmdbId', name: 'work', component: WorkView, props: true, meta: { rank: 10 } },
  ],
});

export default router;

/** The `position` vue-router stamped on the history entry the app is standing on, refreshed in
 *  `afterEach`.
 *  It is the one fact that separates a traversal from a push, and the move needs it because a rank cannot
 *  see a traversal and a URL can lie. A push runs its guards while the browser still stands on the page
 *  being left — the URL only moves once they pass — so the state read in the guard is that page's own and
 *  its position is still this one. A back or forward has already landed the browser on the destination's
 *  entry before the guard runs, so its position is a different number. */
let herePos = 0;

router.beforeEach((to, from) => {
  const h = window.history.state as { back?: string | null; forward?: string | null; position?: number } | null;
  // Read a traversal off the position rather than off the URLs. The URL pair cannot tell 「回到我来时的
  // 那页」 from 「再进一次刚离开的那页」: 设置 -> 弹幕调试 -> 管理 -> 弹幕调试 walks a push whose target
  // happens to be the entry behind, and `back === to.fullPath` read that as a return and slid the page in
  // from the left twice in a row (measured: the second 打开调试 played `pop` at position 6, forward=null).
  const pos = typeof h?.position === 'number' ? h.position : herePos;
  const moved: 'back' | 'forward' | null = pos === herePos ? null : pos < herePos ? 'back' : 'forward';
  // The pane layer keeps the URL test: the shelves are one component answering a query, so a rail click
  // onto the shelf behind us (在看 -> 收藏 -> 在看) is a *push* whose target is that shelf — the position
  // cannot see it, and the shelf must still slide in from the left the way it left. Measured before this
  // split: that click reads `back=/browse?kind=favorites` at the guard, the click ahead of it `back=/`.
  // A traversal into such a shelf is a return for both layers, which is what the `moved` term adds.
  const behind = moved === 'back' || h?.back === to.fullPath || h?.forward === from.fullPath;
  paneDir.value = behind ? 'pop' : 'push';
  // The overlay is the one exception the rank cannot see through: the player window is transparent over
  // mpv's picture, so it must neither travel nor be travelled to.
  if (to.meta.overlay === true || from.meta.overlay === true) pageDir.value = 'flat';
  else if (moved === 'back') pageDir.value = 'pop';
  else if (moved === 'forward') pageDir.value = 'push';
  else pageDir.value = Number(to.meta.rank ?? 0) >= Number(from.meta.rank ?? 0) ? 'push' : 'pop';
});

// The player route renders into a transparent window stacked on mpv's native
// surface; an opaque page background there hides the picture entirely.
router.afterEach((to, _from, failure) => {
  // The move is over; the entry the app now stands on is the one the next guard measures against. A
  // cancelled navigation never got there, so it leaves the number alone.
  if (!failure) herePos = (window.history.state as { position?: number } | null)?.position ?? herePos;
  document.documentElement.classList.toggle('overlay', !!to.meta.overlay);
});
