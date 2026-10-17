import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { AppConfig, FacetOption, LibraryItem, LibraryRow, SettingsPatch, TmdbStills, WatchedRecord } from '../../shared/types';
import { clearEmbyCache, embyCached, patchItem, rescope } from '../lib/embycache';
import { tmdbKind } from '../lib/scores';

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
    // Every Emby answer on file is keyed by account, so the cache follows the same pointer.
    rescope(account.value?.accountId || '');
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
    clearEmbyCache();
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
  async function saveSettings(patch: SettingsPatch): Promise<boolean> {
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
      viewsPromise = embyCached('views', null, () => window.echoemby.emby.views())
        .then(r => {
          // The empty folders are already gone: the main process probes them once per account, because
          // the lobby has to ask the same question to name its rows.
          if (r.ok) views.value = r.data || [];
        })
        .finally(() => {
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
      genresPromise = embyCached('genres', null, () => window.echoemby.emby.genres())
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
    // Both asks land on the same Views answer, which the main process now holds for the account, so the
    // rail does not have to wait for the rows and neither pays for the folder list twice.
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

  async function logoUrl(item: { id: string; logoImageTag?: string }, width = 900): Promise<string> {
    const key = `${account.value?.accountId}|logo:${item.id}:${width}`;
    const hit = imgCache.get(key);
    if (hit) return hit;
    const r = await window.echoemby.emby.imageUrl({ id: item.id, tag: item.logoImageTag, width, type: 'logo' });
    const url = r.ok && r.data ? r.data : '';
    if (url) imgCache.set(key, url);
    return url;
  }

  /* A ranked list rather than one URL, because the top candidate can still fail to load: TMDB hosts a
     treatment its CDN then answers with a 404, and a server Logo tag can outlive the file. The caller
     walks it — 简体中文, 繁体中文, 英文, the work's own language, any other, the server's own Logo, and
     finally nothing, which is where the text title comes back. */
  const logoAsk = new Map<string, Promise<string[]>>();

  /* TMDB files `original` logo PNGs at print resolution — measured on 玩具总动员5, 8,199,244 bytes and
     4363x5329 for a treatment the hero shows at 520 CSS px (650 device px on this machine's DPR 1.25
     screen). `w500` is the CDN's largest logo step — w1000 and above answer 400 for this file type — so
     a raster treatment is shown at a mild upscale rather than paid for at megabytes a slide. */
  const tmdbLogoUrl = (path: string): string =>
    `https://image.tmdb.org/t/p/${path.endsWith('.svg') ? 'original' : 'w500'}${path}`;

  function logoCandidates(item: LibraryItem): Promise<string[]> {
    const key = `${account.value?.accountId}|${item.id}`;
    const hit = logoAsk.get(key);
    if (hit) return hit;
    const ask = (async () => {
      const out: string[] = [];
      const kind = tmdbKind(item);
      const tmdbId = item.providers?.tmdb;
      if (kind && tmdbId) {
        const r = await window.echoemby.meta.tmdbLogos({ kind, tmdbId });
        if (r.ok && r.data) out.push(...r.data.map(tmdbLogoUrl));
      }
      if (item.logoImageTag) {
        const u = await logoUrl(item);
        if (u) out.push(u);
      }
      return out;
    })();
    logoAsk.set(key, ask);
    return ask;
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
      tmdbId = embyCached('item', sid, () => window.echoemby.emby.item(sid))
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
        .then(x => (x.ok && x.data ? x.data : {}))
        .catch(() => ({} as TmdbStills));
      seasonStills.set(key, stills);
    }
    const row = (await stills)[ep];
    // w500 is the size the detail page already uses for these; a card is 300 css px = 375 device px here.
    return row?.p ? `https://image.tmdb.org/t/p/w500${row.p}` : '';
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

  /* ---------------------------------------------------------- writes that come back

     Two facts change while the app is open and were only ever re-read from the server: where a title
     stopped, and whether it is a favourite. Closing the player used to mean the whole lobby (fifteen
     round trips) or nothing at all, depending on which page happened to be watching. These write the
     accepted change onto every copy in hand, and re-ask only the one row whose membership really is
     the server's decision. */

  function userDataOf(it: LibraryItem): NonNullable<LibraryItem['userData']> {
    return it.userData || (it.userData = {});
  }

  /** Both places a page can be holding this item: the cached answers (the detail page's own item, the
   *  season's episode rows) and the lobby's rows, which come back on a channel of their own. */
  function writeBack(id: string, edit: (item: LibraryItem) => void): void {
    patchItem(id, edit);
    for (const row of rows.value) for (const it of row.items) if (it.id === id) edit(it);
  }

  /** The row a stopped film can move, and the only one a write-back cannot produce: a title watched past
   *  the server's cutoff leaves 继续观看, a new one enters at the top, and both orders are the server's.
   *  Asked alone it is one round trip; the lobby's other rows are library ingest order. */
  async function refreshResume(): Promise<void> {
    const r = await window.echoemby.emby.resumeRow();
    if (!r.ok) return;
    const at = rows.value.findIndex(x => x.key === 'resume');
    if (!r.data) {
      if (at >= 0) rows.value.splice(at, 1);
      return;
    }
    if (at >= 0) rows.value.splice(at, 1, r.data);
    else rows.value.unshift(r.data);
  }

  async function rememberPlayback(w: WatchedRecord): Promise<void> {
    const pct = w.durationMs > 0 ? Math.min(100, (w.positionMs / w.durationMs) * 100) : 0;
    writeBack(w.itemId, it => {
      const u = userDataOf(it);
      u.positionMs = w.positionMs;
      u.playedPercentage = Math.round(pct * 10) / 10;
    });
    await refreshResume();
  }

  async function setFavorite(id: string, on: boolean): Promise<boolean> {
    const r = await window.echoemby.emby.favorite({ id, on });
    if (r.ok)
      writeBack(id, it => {
        userDataOf(it).isFavorite = on;
      });
    return !!r.ok;
  }

  let offWatched: (() => void) | null = null;

  /** Subscribe in the window that owns the lobby, once. The player runs this same bundle in a window of
   *  its own; a subscriber there would have no rows to patch and would ask for the resume row a second
   *  time on every stop. */
  function watchPlayback(): void {
    if (offWatched) return;
    offWatched = window.echoemby.player.onWatched(w => void rememberPlayback(w));
  }

  return { config, account, rows, views, genres, loading, error, ready, counts, init, login, switchTo, remove, update, saveSettings, loadCounts, loadHome, loadViews, loadGenres, imageUrl, backdropUrl, logoCandidates, itemArt, setFavorite, watchPlayback };
});
