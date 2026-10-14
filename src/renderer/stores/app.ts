import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { AppConfig, FacetOption, LibraryItem, LibraryRow, Settings, TmdbStills } from '../../shared/types';

export const useAppStore = defineStore('app', () => {
  const config = ref<AppConfig | null>(null);
  const rows = ref<LibraryRow[]>([]);
  const views = ref<LibraryItem[]>([]);
  const genres = ref<FacetOption[]>([]);
  const loading = ref(false);
  const error = ref('');
  const ready = ref(false);

  const account = computed(() => {
    const c = config.value;
    if (!c) return null;
    return c.accounts.find(a => a.accountId === c.activeAccountId) || null;
  });

  const imgCache = new Map<string, string>();

  async function init(): Promise<void> {
    const r = await window.echoemby.app.getConfig();
    if (r.ok && r.data) config.value = r.data;
    ready.value = true;
  }

  async function login(baseUrl: string, username: string, password: string): Promise<boolean> {
    error.value = '';
    const r = await window.echoemby.app.login({ baseUrl, username, password });
    if (!r.ok) {
      error.value = r.error || '登录失败';
      return false;
    }
    invalidate();
    await init();
    return true;
  }

  /** Item ids are per-server and collide across them, so nothing may survive a switch. */
  function invalidate(): void {
    imgCache.clear();
    rows.value = [];
    views.value = [];
    viewsPromise = null;
    genres.value = [];
    genresPromise = null;
  }

  async function switchTo(accountId: string): Promise<boolean> {
    const r = await window.echoemby.app.switchAccount(accountId);
    if (!r.ok) {
      error.value = r.error || '切换失败';
      return false;
    }
    invalidate();
    await init();
    return true;
  }

  /** Removing the active account makes the main process fall back to any remaining one. */
  async function remove(accountId: string): Promise<string | null> {
    const r = await window.echoemby.app.removeAccount(accountId);
    if (!r.ok) {
      error.value = r.error || '移除失败';
      return null;
    }
    invalidate();
    await init();
    return r.data ?? null;
  }

  async function update(input: { accountId: string; label?: string; baseUrl: string; username: string; password?: string }): Promise<boolean> {
    error.value = '';
    const r = await window.echoemby.app.updateAccount(input);
    if (!r.ok) {
      error.value = r.error || '保存失败';
      return false;
    }
    invalidate();
    // The address or credentials changed, so any totals on file belong to another library.
    counts.value = Object.fromEntries(Object.entries(counts.value).filter(([id]) => id !== input.accountId));
    await init();
    return true;
  }

  /** The main process answers with the whole merged block, so the page reads back what it wrote. */
  async function saveSettings(patch: Partial<Settings>): Promise<boolean> {
    error.value = '';
    const r = await window.echoemby.app.setSettings(patch);
    if (!r.ok) {
      error.value = r.error || '保存失败';
      return false;
    }
    if (r.data && config.value) config.value = { ...config.value, settings: r.data };
    return true;
  }

  let viewsPromise: Promise<void> | null = null;

  const counts = ref<Record<string, { movies: number; series: number }>>({});
  const countsInFlight = new Set<string>();

  /** Library totals per server: asked once per account, kept for the session. */
  async function loadCounts(accountId: string): Promise<void> {
    if (counts.value[accountId] || countsInFlight.has(accountId)) return;
    countsInFlight.add(accountId);
    const r = await window.echoemby.app.accountCounts(accountId);
    countsInFlight.delete(accountId);
    if (r.ok && r.data) counts.value = { ...counts.value, [accountId]: r.data };
  }

  /** The rail lists the libraries on routes that never touch the home rows. */
  function loadViews(): Promise<void> {
    if (views.value.length) return Promise.resolve();
    if (!viewsPromise) {
      viewsPromise = (async () => {
        const r = await window.echoemby.emby.views();
        if (!r.ok) return;
        const all = r.data || [];
        /** Views answers with every library the account may see, and a library that holds nothing
         *  looks identical to one that is merely quiet (measured: 播放列表 is empty on both gateways).
         *  Ask the same question the browse page will ask, and drop the ones that answer with nothing.
         *  A failed probe keeps the library: only a proven-empty answer may hide it. */
        const filled = await Promise.all(
          all.map(v =>
            window.echoemby.emby
              .items({ ParentId: v.id, IncludeItemTypes: 'Movie,Series,BoxSet,Playlist,Video', Recursive: true, Limit: 1 })
              .then(x => (x.ok ? (x.data || []).length > 0 : true))
              .catch(() => true),
          ),
        );
        views.value = all.filter((_, i) => filled[i]);
      })().finally(() => {
        viewsPromise = null;
      });
    }
    return viewsPromise;
  }

  let genresPromise: Promise<void> | null = null;

  /** The 分类 dropdown reads the library's own genre labels. Held here rather than in the view so a
   *  server that was slow on the first ask gets asked again on the next page, not never again. */
  function loadGenres(): Promise<void> {
    if (genres.value.length) return Promise.resolve();
    if (!genresPromise) {
      genresPromise = window.echoemby.emby
        .genres()
        .then(r => {
          if (r.ok) genres.value = r.data || [];
        })
        .finally(() => {
          genresPromise = null;
        });
    }
    return genresPromise;
  }

  async function loadHome(): Promise<void> {
    if (loading.value) return;
    loading.value = true;
    error.value = '';
    // The rail's list comes from loadViews, not the raw Views reply: that one still carries the
    // empty libraries, and writing it here would put them back after the rail had hidden them.
    const [, rowsRes] = await Promise.all([loadViews(), window.echoemby.emby.homeRows()]);
    if (rowsRes.ok) rows.value = rowsRes.data || [];
    else error.value = rowsRes.error || '加载失败';
    loading.value = false;
  }

  /** Image URLs carry the session token, so they are minted in the main process. */
  async function imageUrl(item: { id: string; primaryImageTag?: string }, width = 320): Promise<string> {
    const key = `${account.value?.accountId}|primary:${item.id}:${width}`;
    const hit = imgCache.get(key);
    if (hit) return hit;
    const r = await window.echoemby.emby.imageUrl({ id: item.id, tag: item.primaryImageTag, width });
    const url = r.ok && r.data ? r.data : '';
    if (url) imgCache.set(key, url);
    return url;
  }

  async function backdropUrl(item: { id: string; backdropImageTag?: string }, width = 1600): Promise<string> {
    const key = `${account.value?.accountId}|backdrop:${item.id}:${width}`;
    const hit = imgCache.get(key);
    if (hit) return hit;
    const r = await window.echoemby.emby.imageUrl({ id: item.id, tag: item.backdropImageTag, width, type: 'backdrop' });
    const url = r.ok && r.data ? r.data : '';
    if (url) imgCache.set(key, url);
    return url;
  }

  // Item ids are per-server, so both maps are keyed by account: a cache kept across a switch would
  // dress one server's episode in another server's still.
  const seriesTmdb = new Map<string, Promise<string>>();
  const seasonStills = new Map<string, Promise<TmdbStills>>();

  /** The episode's own frame from TMDB. One ask per (series, season) no matter how many episodes of it a
   *  page shows: the 在看 window is 48 artless episodes over 6 seasons, and TMDB answers a season at a time. */
  async function episodeStill(item: LibraryItem): Promise<string> {
    const sid = item.parentId;
    const season = item.parentIndexNumber;
    const ep = item.indexNumber;
    if (!sid || season == null || ep == null) return '';
    const acct = `${account.value?.accountId}|`;
    let tmdbId = seriesTmdb.get(acct + sid);
    if (!tmdbId) {
      tmdbId = window.echoemby.emby
        .item(sid)
        .then(r => (r.ok ? r.data?.providers?.tmdb || '' : ''))
        .catch(() => '');
      seriesTmdb.set(acct + sid, tmdbId);
    }
    const showId = await tmdbId;
    // This gateway writes the string "None" for a provider it does not have, so only digits are an id.
    if (!/^\d{1,8}$/.test(showId)) return '';
    const key = `${acct}${showId}/${season}`;
    let stills = seasonStills.get(key);
    if (!stills) {
      stills = window.echoemby.meta
        .tmdbStills({ tmdbId: showId, season })
        .then(x => (x.ok && x.data ? x.data.value : {}))
        .catch(() => ({} as TmdbStills));
      seasonStills.set(key, stills);
    }
    const path = (await stills)[ep];
    // w500 is the size the detail page already uses for these; a card is 300 css px = 375 device px here.
    return path ? `https://image.tmdb.org/t/p/w500${path}` : '';
  }

  /** An Episode rarely has art of its own here: measured on the 在看 row, 48 of 60 rows carry no Primary tag
   *  and asking the server for one answers 500. Two stand-ins, best first: TMDB has the episode's own still
   *  (measured on that page: 21 of those 48; the 27 misses are 物语系列, whose seasons this server numbers
   *  11-13 while TMDB stops at 5), and the series above them always has a backdrop and a poster, which this
   *  gateway serves without ever needing a tag. So a 16:9 frame asks for its own still and falls back to the
   *  series backdrop, a 2:3 frame takes the series poster, and the letter placeholder is the last resort. */
  async function itemArt(item: LibraryItem, width: number, wide = false): Promise<string> {
    if (item.primaryImageTag) return imageUrl(item, width);
    if (item.type !== 'Episode' || !item.parentId) return '';
    if (wide) return (await episodeStill(item)) || backdropUrl({ id: item.parentId }, width);
    return imageUrl({ id: item.parentId }, width);
  }

  return { config, account, rows, views, genres, loading, error, ready, counts, init, login, switchTo, remove, update, saveSettings, loadCounts, loadHome, loadViews, loadGenres, imageUrl, backdropUrl, itemArt };
});
