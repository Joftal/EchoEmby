import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { AppConfig, FacetOption, LibraryItem, LibraryRow, SettingsPatch, TmdbEpisodeRow, TmdbStills, WatchedRecord } from '../../shared/types';
import { clearEmbyCache, embyCached, patchItem, rescope } from '../lib/embycache';
import { applyStop } from '../lib/resume';
import { stoppedAtMs } from '../lib/format';
import { tmdbKind } from '../lib/scores';

/** One subscription per window, made the first time a window reads the block. */
let listening = false;

export const useAppStore = defineStore('app', () => {
  const config = ref<AppConfig | null>(null);
  const rows = ref<LibraryRow[]>([]);
  const views = ref<LibraryItem[]>([]);
  const genres = ref<FacetOption[]>([]);
  /** Which library the two facet lists on screen were narrowed to, and what each library answered. Keeping
   *  the answer per scope means walking 华语电影 → 搜索 → 华语电影 does not re-read the list, and switching
   *  scope paints a library's own list immediately instead of the previous library's for a second. */
  let genreScope = '';
  const genreCache = new Map<string, FacetOption[]>();
  let studioScope = '';
  const studioCache = new Map<string, FacetOption[]>();
  /** Every company the library credits, with the ids 公司 filters by. Held like `genres` because it is the
   *  same kind of answer: one per account, not one per page. */
  const studios = ref<FacetOption[]>([]);
  /** True while the company facet is on its way. The bar uses it to hold 公司's place instead of letting
   *  the pill pop in a second later and shove 语言 sideways. */
  const studiosLoading = ref(false);
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
    // Every 设置 row has a twin in another surface: the player's panel writes 硬件解码, 画面适配 and 动态范围 while
    // the sheet is closed, and the sheet writes the same three while the player runs. The main process now
    // pushes the merged block, so both surfaces answer for the file rather than for the read at launch.
    if (!listening) {
      listening = true;
      window.echoemby.app.onSettings(s => {
        if (config.value) config.value = { ...config.value, settings: s };
      });
    }
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
    genreFlights.clear();
    facetEpoch += 1;
    genreScope = '';
    genreCache.clear();
    studios.value = [];
    studioFlights.clear();
    studioScope = '';
    studioCache.clear();
    studiosLoading.value = false;
    // A server with no stops is only a promise for *this* server, so the switch hands the ask back.
    resumeAsked = false;
    resumeAwaited = null;
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

  /** The player's own panel writes 画面适配 and 硬件解码 while the sheet is not on screen, and a write in
   *  another window is not pushed here. So a sheet that opens later re-reads the block instead of showing
   *  the reading taken at launch — otherwise it prints a value the file no longer holds. */
  async function refreshSettings(): Promise<void> {
    const r = await window.echoemby.app.getConfig();
    if (r.ok && r.data && config.value) config.value = { ...config.value, settings: r.data.settings };
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

  /** One in-flight ask per scope, not one per loader. A single slot ate the second library's
   *  answer: landing on 搜索 and then on a library within a second left 公司 missing for good —
   *  the global /Studios ask (about a second on the gateway) was still in flight, so the
   *  library's ask was never sent, and the answer that did arrive was thrown away as another
   *  scope's. Both are fixed by keying the flight on the scope it belongs to. */
  const genreFlights = new Map<string, Promise<void>>();

  const studioFlights = new Map<string, Promise<void>>();

  /** Answers that were in flight when the account changed belong to the old account: same id, other
   *  server, so they may not land in this account's caches. Bumped by invalidate(). */
  let facetEpoch = 0;

  /** The 分类 dropdown reads the library's own genre labels. Held here rather than in the view so a
   *  server that was slow on the first ask gets asked again on the next page, not never again.
   *  `scope` is a library id: the gateway answers that library's own genres, and the difference is the
   *  point — 27 labels against 华语电影's 24 rows left eight entries that answered nothing there. */
  function loadGenres(scope = ''): Promise<void> {
    if (scope !== genreScope) {
      genreScope = scope;
      genres.value = genreCache.get(scope) || [];
    }
    if (genres.value.length) return Promise.resolve();
    let flight = genreFlights.get(scope);
    if (!flight) {
      const mine = facetEpoch;
      flight = embyCached('genres', scope, () => window.echoemby.emby.genres(scope))
        .then(r => {
          if (mine !== facetEpoch) return;
          if (r.ok) {
            genreCache.set(scope, r.data || []);
            // A page that has already moved on keeps the answer for its own library, not this one.
            if (scope === genreScope) genres.value = r.data || [];
          }
        })
        .finally(() => {
          genreFlights.delete(scope);
        });
      genreFlights.set(scope, flight);
    }
    return flight;
  }

  /** The 公司 dropdown needs the library's whole company list, not the companies behind the rows on
   *  screen — that list is what made a fresh search page show no 公司 pill at all. One ask per account
   *  (1.9 MB on the gateway, 316 KB on nyamedia), cached by the same TTL as every other Emby answer. */
  function loadStudios(scope = ''): Promise<void> {
    if (scope !== studioScope) {
      studioScope = scope;
      studios.value = studioCache.get(scope) || [];
      // A list already held for this library needs no 正在载入 row, so the bar can print the pill at once.
      studiosLoading.value = !studios.value.length;
    }
    if (studios.value.length) return Promise.resolve();
    let flight = studioFlights.get(scope);
    if (!flight) {
      studiosLoading.value = true;
      const mine = facetEpoch;
      flight = embyCached('studios', scope, () => window.echoemby.emby.studios(scope))
        .then(r => {
          if (mine !== facetEpoch) return;
          if (r.ok) {
            studioCache.set(scope, r.data || []);
            if (scope === studioScope) studios.value = r.data || [];
          }
        })
        .finally(() => {
          studioFlights.delete(scope);
          // Only the scope on screen may retire the 正在载入 row; another library's answer
          // must not blank the pill that is still waiting for its own list.
          if (scope === studioScope) studiosLoading.value = false;
        });
      studioFlights.set(scope, flight);
    }
    return flight;
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

  /** The same ranking for a work this server does not hold. It is handed to `logoCandidates` as a one-field
   *  item because that is the shape the ranking already walks: the only difference is there is no server
   *  Logo tag to fall back to, and the dedup key cannot collide with a real item id. */
  function workLogos(kind: 'movie' | 'tv', tmdbId: string): Promise<string[]> {
    return logoCandidates({ id: `tmdb:${kind}:${tmdbId}`, type: kind === 'movie' ? 'Movie' : 'Series', providers: { tmdb: tmdbId } } as LibraryItem);
  }

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

  /** TMDB's row for one episode. One ask per (series, season) no matter how many episodes of it a page
   *  shows: the 在看 window is 48 artless episodes over 6 seasons, and TMDB answers a season at a time.
   *  The same reply carries the episode's title, so a card that wanted its frame gets its name for free —
   *  and a card that had a frame of its own is the only one that pays for the ask. */
  async function tmdbEpisode(item: LibraryItem): Promise<TmdbEpisodeRow | null> {
    const sid = item.parentId;
    const season = item.parentIndexNumber;
    const ep = item.indexNumber;
    if (!sid || season == null || ep == null) return null;
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
    if (!/^\d{1,8}$/.test(showId)) return null;
    const key = `${acct}${showId}/${season}`;
    let stills = seasonStills.get(key);
    if (!stills) {
      stills = window.echoemby.meta
        .tmdbStills({ tmdbId: showId, season })
        .then(x => (x.ok && x.data ? x.data : {}))
        .catch(() => ({} as TmdbStills));
      seasonStills.set(key, stills);
    }
    return (await stills)[ep] || null;
  }

  /** What TMDB calls this episode: its own title in Chinese, then in whatever else it files the work, then
   *  nothing — the same ladder the synopsis rides, and the reason a card stops wearing a release group's
   *  label. Empty is the cue for the surface to fall back to the server's row. */
  async function episodeTitle(item: LibraryItem): Promise<string> {
    const r = await tmdbEpisode(item);
    return r?.nZh || r?.nOther || '';
  }

  /** TMDB's paragraph for one episode, same ladder and same single ask per season. Empty is the cue for the
   *  surface to fall back to the server's line, which for a lot of this library's episodes is English. */
  async function episodeOverview(item: LibraryItem): Promise<string> {
    const r = await tmdbEpisode(item);
    return r?.ovZh || r?.ovOther || '';
  }

  async function episodeStill(item: LibraryItem): Promise<string> {
    const p = (await tmdbEpisode(item))?.p;
    // w500 is the size the detail page already uses for these; a card is 300 css px = 375 device px here.
    return p ? `https://image.tmdb.org/t/p/w500${p}` : '';
  }

  /** An Episode rarely has art of its own here: measured on the 在看 row, 48 of 60 rows carry no Primary tag
   *  and asking the server for one answers 500. Two stand-ins, best first: TMDB has the episode's own still
   *  (measured on that page: 21 of those 48; the 27 misses are 物语系列, whose seasons this server numbers
   *  11-13 while TMDB stops at 5), and the series above them always has a backdrop and a poster, which this
   *  gateway serves without ever needing a tag. So a 16:9 frame asks for its own still and falls back to the
   *  series backdrop, a 2:3 frame takes the series poster, and the letter placeholder is the last resort.
   *
   *  Every rung is returned, not just the best one, because the best one is a URL the gateway can mint and
   *  then fail to render — measured: an episode's own Primary answers 500 while the card still has TMDB's
   *  still behind it. A card that sees its picture refuse to decode has to be able to step down without
   *  asking again. */
  async function itemArt(item: LibraryItem, width: number, wide = false): Promise<string[]> {
    const rungs: string[] = [];
    if (item.primaryImageTag) rungs.push(await imageUrl(item, width));
    if (item.type === 'Episode' && item.parentId) {
      const still = wide ? await episodeStill(item) : '';
      if (still) rungs.push(still);
      rungs.push(wide ? await backdropUrl({ id: item.parentId }, width) : await imageUrl({ id: item.parentId }, width));
    }
    return [...new Set(rungs.filter(Boolean))];
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
   *  Asked alone it is two round trips; the lobby's other rows are library ingest order. */
  async function refreshResume(): Promise<boolean> {
    const r = await window.echoemby.emby.resumeRow();
    if (!r.ok) return false;
    const at = rows.value.findIndex(x => x.key === 'resume');
    if (!r.data) {
      if (at >= 0) rows.value.splice(at, 1);
      return true;
    }
    if (at >= 0) rows.value.splice(at, 1, r.data);
    else rows.value.unshift(r.data);
    return true;
  }

  /** The 在看 row on its own, for a page that reads a stop before the lobby has ever been opened: the
   *  detail page opens on the episode 在看 names, and a window restored on another shelf holds no rows
   *  yet. At most one ask in flight, and a server with no stops is not asked again this session;
   *  `refreshResume` stays free to re-ask after every stop. */
  let resumeAsked = false;
  let resumeAwaited: Promise<void> | null = null;
  function ensureResumeRow(): Promise<void> {
    if (resumeAsked || rows.value.some(r => r.key === 'resume')) return Promise.resolve();
    if (!resumeAwaited) {
      resumeAwaited = refreshResume()
        .then(ok => {
          if (ok) resumeAsked = true;
        })
        .finally(() => {
          resumeAwaited = null;
        });
    }
    return resumeAwaited;
  }

  /** The last stop the server accepted. Write-back covers every copy this app holds, but one browse
   *  list answers from the server instead — 在看 orders titles by when they were last opened — and its
   *  rows are not in the shared cache, so nothing patches them. It re-reads on this: a replaced object
   *  fires the watcher even when the same episode stops twice at the same number. */
  const lastStop = ref<WatchedRecord | null>(null);

  async function rememberPlayback(w: WatchedRecord): Promise<void> {
    writeBack(w.itemId, it => applyStop(it, w));
    lastStop.value = w;
    await refreshResume();
    // The re-read can come back holding less than the stop it was just given: the row is built from the
    // resume endpoint, and a title whose offset the gateway has not folded in yet lands there with no
    // position at all (measured: bangumi rewrites a live session's item to the number its own start
    // carried, about a minute in — which can be after this call). The player's own number is the better
    // witness of where the viewer stopped, so the row keeps it.
    const held = rows.value.find(r => r.key === 'resume')?.items.find(x => x.id === w.itemId);
    if (held && stoppedAtMs(held.userData, held.runTimeTicks) < w.positionMs) applyStop(held, w);
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

  return { config, account, rows, views, genres, studios, studiosLoading, loading, error, ready, counts, lastStop, init, login, switchTo, remove, update, saveSettings, refreshSettings, loadCounts, loadHome, loadViews, loadGenres, loadStudios, ensureResumeRow, imageUrl, backdropUrl, logoCandidates, workLogos, itemArt, episodeTitle, episodeOverview, setFavorite, watchPlayback };
});
