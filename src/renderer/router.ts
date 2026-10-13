import { createRouter, createWebHashHistory } from 'vue-router';
import LoginView from './views/LoginView.vue';
import HomeView from './views/HomeView.vue';
import DetailView from './views/DetailView.vue';
import PlayerView from './views/PlayerView.vue';
import BrowseView from './views/BrowseView.vue';
import ServersView from './views/ServersView.vue';
import SettingsView from './views/SettingsView.vue';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/player', name: 'player', component: PlayerView, meta: { overlay: true } },
    { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
    { path: '/', name: 'home', component: HomeView },
    { path: '/browse', name: 'browse', component: BrowseView },
    { path: '/servers', name: 'servers', component: ServersView },
    { path: '/settings', name: 'settings', component: SettingsView },
    { path: '/detail/:id', name: 'detail', component: DetailView, props: true },
  ],
});

export default router;

// The player route renders into a transparent window stacked on mpv's native
// surface; an opaque page background there hides the picture entirely.
router.afterEach(to => {
  document.documentElement.classList.toggle('overlay', !!to.meta.overlay);
});
