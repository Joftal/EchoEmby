<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { IpcResult, LibraryItem } from '../../shared/types';
import MediaCard from '../components/home/MediaCard.vue';
import ListCard from '../components/home/ListCard.vue';
import RowScroller from '../components/home/RowScroller.vue';
import FilterBar from '../components/browse/FilterBar.vue';
import { defaultSort, emptyFilters, filterParams, fromQuery, isFiltered, localSort, sortParams, toQuery, TYPE_OPTIONS, type Filters } from '../lib/filters';
import { embyCached } from '../lib/embycache';
import { resetPageScroll } from '../lib/scroll';
import { PLAYABLE, applyStop } from '../lib/resume';
import { useAppStore } from '../stores/app';
import { usePlayerStore } from '../stores/player';
import { paneDir } from '../router';

const store = useAppStore();
const player = usePlayerStore();
const route = useRoute();
const router = useRouter();

type Kind = 'resume' | 'favorites' | 'search' | 'view';

/** A search is ordered by hand over whatever we hold, so its first page has to be worth ordering. */
const PAGE = 48;
const SEARCH_PAGE = 200;
/** 在看 folds its rows into one card per show, and this server folds hard: measured 200 rows → 16 cards,
 *  400 → 21, 1200 → 25 (one show, 乡村爱情, holds 849 of the rows). 48 rows would have painted 13 cards and
 *  the next page would have added one or two. 200 rows is one request (~1.2s measured). */
const RESUME_PAGE = 200;

const kind = computed<Kind>(() => {
  const k = String(route.query.kind || '');
  if (k === 'resume' || k === 'favorites' || k === 'search') return k;
  return 'view';
});
const viewId = computed(() => String(route.query.view || ''));
const isSearch = computed(() => kind.value === 'search');
const pageSize = computed(() => (isSearch.value ? SEARCH_PAGE : kind.value === 'resume' ? RESUME_PAGE : PAGE));
/** 收藏 wears no filter bar, so it must not read the URL's filter keys either: an address left over from
 *  a filtered 搜索 or a library window would quietly narrow the list, with nothing on screen saying so and
 *  no 清空筛选 left to undo it. The sort stays the default one, which is what the page already wore. */
const readFilters = (): Filters =>
  kind.value === 'favorites' ? emptyFilters(defaultSort(isSearch.value)) : fromQuery(route.query, defaultSort(isSearch.value));
const filters = ref<Filters>(readFilters());
const term = ref(String(route.query.q || ''));

/** A language can only be answered by a row that owns audio streams, and a Series row owns none: measured on
 *  this gateway, `IncludeItemTypes=Series&AudioLanguages=jpn` answers 0 of 415 shows, while the same code on
 *  Episodes answers 9,854 of 18,243. So a page asked for a language reaches its shows through their episodes
 *  — the server filters the episodes, and the fold in `shown` turns the run back into one card per show. */
const langOn = computed(() => filters.value.langs.length > 0);
/** 电影 and 合集 have their own audio, so the detour is only for lists that can hold a show — and a library
 *  filed as films only holds none, so walking it would be a page of rows with nothing to fold. */
const libraryKind = computed(() => store.views.find(v => v.id === viewId.value)?.collectionType || '');
const showsWanted = computed(
  () =>
    filters.value.type !== 'Movie' &&
    filters.value.type !== 'BoxSet' &&
    libraryKind.value !== 'movies' &&
    libraryKind.value !== 'boxsets',
);
const titles: Record<Exclude<Kind, 'view'>, string> = {
  resume: '在看',
  favorites: '收藏',
  search: '搜索',
};
const title = computed(() => (kind.value === 'view' ? decodeURIComponent(String(route.query.name || '')) || '资源库' : titles[kind.value]));
/** 在看 is a playback queue and 收藏 is the list of titles already chosen: neither is a pool to narrow.
 *  The bar stays on 搜索 and on a library window, where the whole catalogue is on screen and a condition
 *  is the only way to get at one part of it. */
const showBar = computed(() => kind.value === 'search' || kind.value === 'view');
/** The two lists are horizontal cards, two or three across; a search and a library window are posters. */
const layout = computed<'list' | 'grid'>(() =>
  kind.value === 'resume' || kind.value === 'favorites' ? 'list' : 'grid',
);
/** 在看 drops the paragraph for a frame, a count and a bar, so it gets its own density of the same card. */
const rowVariant = computed<'row' | 'queue'>(() => (kind.value === 'resume' ? 'queue' : 'row'));

/** The gateway matches a title token by token, with its punctuation still inside the token: the
 *  「骗骗喜欢你」 nobody types quotes for cannot reach 「“骗骗”喜欢你」, but 「骗骗 喜欢你」 lands on it
 *  exactly. Measured here: opening the marks into a space found 14 of 14 real marked-up titles,
 *  deleting them found none, and a cut at every gap recovered 4 of 6 titles typed clean.
 *  Per-character cuts never match (「骗*骗*喜*欢*你」 answers with nothing), so the gaps are tried in
 *  order and capped: an empty page is worth a few asks, not a scan of the term. */
const MARKS = /[“”‘’「」『』《》〈〉（）()·．。，,！!？?：:；;—、\-~～\s]+/g;
const openMarks = (t: string): string => t.replace(MARKS, ' ').trim();
function retryShapes(t: string): string[] {
  const flat = openMarks(t);
  const out = flat && flat !== t ? [flat] : [];
  const tight = flat.replace(/ /g, '');
  for (let i = 1; i < tight.length && out.length < 8; i++) out.push(`${tight.slice(0, i)} ${tight.slice(i)}`);
  return out;
}
/** What the running search actually asked for: the typed term, or the shape that answered it. Keyed
 *  to the term, so re-sorting keeps the shape that got the rows while a new term starts fresh. */
let askedTerm = '';
let searchQuery = '';
function effectiveQuery(): string {
  const t = term.value.trim();
  if (t !== askedTerm) {
    askedTerm = t;
    searchQuery = t;
  }
  return searchQuery;
}

/** `q` overrides the term, which only the retry pass below does: it asks the same page again under another
 *  spelling of what was typed and has to travel through the same branching as a normal ask. */
function params(startIndex: number, q?: string): Record<string, string | number | boolean> {
  const f = filterParams(filters.value);
  const s = sortParams(filters.value);
  const page = { StartIndex: startIndex, Limit: pageSize.value };
  // 在看 no longer sends this — `askRows` below answers the page from the lobby's row — but the shape stays
  // as the page's identity: `lastKey` compares it to decide whether a chip change is a new ask.
  if (kind.value === 'resume') return { Recursive: true, MediaTypes: 'Video', IsResumable: true, SortBy: 'DatePlayed', SortOrder: 'Descending', ...page };
  // Measured: this server answers an IsFavorite query with nothing at all unless it is told which
  // kinds to look for, so 收藏 carries its own default list rather than relying on the server's.
  if (kind.value === 'favorites') return { Recursive: true, Filters: 'IsFavorite', IncludeItemTypes: 'Movie,Series,Episode,Video,BoxSet,Playlist', ...s, ...page };
  // Without this the search answers with Folder, Studio and Person rows: 「"骗骗"喜欢你」 showed up
  // twice because the library's container folder and the movie inside it are two different items.
  // The list has to be comma-joined here too — asked as `A|B` this server ignores it outright.
  // 作品名 only: an Episode row means the server matched a *分集* title (「巨人」 on this server is eight
  // episodes — 名侦探柯南/圣斗士星矢/哆啦A梦… — and zero works named that), and folding those into their
  // shows turned one two-character search into eight unrelated cards. 合集 stays: its own title is a
  // title, and 类型=合集 then narrows to it. 在看/收藏 keep their own lists below — only search narrows.
  if (kind.value === 'search')
    return { Recursive: true, SearchTerm: q ?? effectiveQuery(), IncludeItemTypes: 'Movie,Series,BoxSet', ...f, ...page };
  const p: Record<string, string | number | boolean> = { ParentId: viewId.value, IncludeItemTypes: 'Movie,Series,BoxSet,Playlist,Video', Recursive: true, ...f, ...s, ...page };
  // A library window narrows by type through this same key, so 剧集 has to become Episode here or the ask
  // would be for the one row kind no language can match.
  if (langOn.value && showsWanted.value && typeof p.IncludeItemTypes === 'string') p.IncludeItemTypes = String(p.IncludeItemTypes).replace('Series', 'Episode');
  return p;
}

/** 在看 does not read the raw list: `IsResumable=true` on these forks says the *file* can be resumed, not
 *  that anything was stopped in it — measured, 33 of the 60 rows bangumi answers that way are already
 *  Played, so the shelf filled with finished episodes wearing no 看到 time. The lobby's merged row knows
 *  where each title actually continues, and it is the same two asks the rail already makes. */
/** A search for a language, in three parts that go out together. The films half keeps the server's own
 *  filter, since a film owns its audio. The shows half must go without it — the server answers 0 shows for
 *  any language — and the episodes half is only there to say which of those shows owns a matching file: its
 *  rows never reach the grid, so 「巨人」 still means a work named 巨人 and not the eight episodes whose own
 *  titles hold that name (the fix that made 作品名 only the rule here). Measured on the gateway:
 *  `SearchTerm=无职转生&IncludeItemTypes=Episode` answers 61 episodes of exactly that show. */
/** Whether either half of a split ask filled its window. The composed page holds fewer rows than the
 *  windows it came from (shows are dropped when none of their episodes is in the language), so counting the
 *  composed rows would hide 加载更多 while the server still had more to give. */
let splitMore = false;

async function askSearchSplit(startIndex: number, q: string): Promise<IpcResult<LibraryItem[]>> {
  const f = filterParams(filters.value);
  const noLang = { ...f };
  delete noLang.AudioLanguages;
  const page = { Recursive: true, SearchTerm: q, StartIndex: startIndex, Limit: pageSize.value };
  const type = filters.value.type;
  const shows = type !== 'Movie' && type !== 'BoxSet';
  const films = type === 'Series' ? '' : type || 'Movie,BoxSet';
  const [filmRes, seriesRes, epRes] = await Promise.all([
    films ? window.echoemby.emby.items({ ...page, ...f, IncludeItemTypes: films }) : null,
    shows ? window.echoemby.emby.items({ ...page, ...noLang, IncludeItemTypes: 'Series' }) : null,
    // Its own window: this is an index of the shows that own a file in the language, not a page of cards.
    shows ? window.echoemby.emby.items({ ...page, ...f, StartIndex: 0, Limit: 400, IncludeItemTypes: 'Episode' }) : null,
  ]);
  const filmRows = filmRes?.ok ? filmRes.data || [] : [];
  splitMore = filmRows.length >= pageSize.value || (seriesRes?.ok ? (seriesRes.data || []).length : 0) >= pageSize.value;
  const rows = [...filmRows];
  if (seriesRes?.ok && epRes?.ok) {
    const withLang = new Set((epRes.data || []).map(x => x.parentId || '').filter(Boolean));
    for (const s of seriesRes.data || []) if (withLang.has(s.id)) rows.push(s);
  }
  if (rows.length) return { ok: true, data: rows };
  const bad = [filmRes, seriesRes, epRes].find(x => x && !x.ok);
  return bad ? { ok: false, data: [], error: bad.error } : { ok: true, data: rows };
}

/** A library window narrowed by language is a walk, not one ask. The episode rows that answer it arrive in
 *  the library's own order and each show contributes a run of them: measured on 国产电视剧, the 200 newest
 *  Chinese-audio episodes belong to 7 shows, so a single window paints seven cards and 加载更多 is the only
 *  way forward. The walk keeps asking until the cards on hand fill a page or its budget runs out; the sort
 *  is applied to the cards afterwards, so the order these rows arrive in never reaches the grid. */
const LANG_CHUNK = 600;
const LANG_BUDGET = 2400;
let langSeek = 0;
let langMore = false;
/** Rows the last page walked past but did not paint. They belong to the next one: the walk stops on a whole
 *  chunk, and asking again from the far side of it would lose whatever that chunk held past the cut. */
let langRest: LibraryItem[] = [];

async function askLibraryLang(rewind: boolean): Promise<IpcResult<LibraryItem[]>> {
  const ask: Record<string, string | number | boolean> = {
    ParentId: viewId.value,
    IncludeItemTypes: 'Movie,Episode,BoxSet,Playlist,Video',
    Recursive: true,
    ...filterParams(filters.value),
    ...sortParams(filters.value),
  };
  if (rewind) {
    langSeek = 0;
    langRest = [];
  }
  const want = pageSize.value;
  const rows: LibraryItem[] = langRest;
  const shows = new Set(rows.map(it => (it.type === 'Episode' ? it.parentId : it.id) || ''));
  langRest = [];
  let seek = langSeek;
  const from = seek;
  let more = false;
  // The budget is per page, not per list: 加载更多 continues the walk from where the last one stopped.
  while (seek - from < LANG_BUDGET && rows.length < want) {
    const take = Math.min(LANG_CHUNK, from + LANG_BUDGET - seek);
    const r = await window.echoemby.emby.items({ ...ask, StartIndex: seek, Limit: take });
    if (!r.ok) return rows.length ? { ok: true, data: rows } : { ok: false, data: [], error: r.error };
    const batch = r.data || [];
    for (const it of batch) {
      if (it.type !== 'Episode') {
        rows.push(it);
        continue;
      }
      const id = it.parentId || '';
      if (!id || shows.has(id)) continue;
      shows.add(id);
      rows.push(it);
    }
    seek += batch.length;
    // A short window is the end of the list; a full one that fills the page leaves the rest to 加载更多.
    if (batch.length < take) break;
    if (shows.size >= want || rows.length >= want) {
      more = true;
      break;
    }
  }
  if (seek - from >= LANG_BUDGET) more = true;
  langSeek = seek;
  // A films-only window hands back every row of its chunk; the page still holds one screenful of cards,
  // and the rest waits for the next one instead of being asked for a second time.
  if (rows.length > want) {
    more = true;
    langRest = rows.slice(want);
    rows.length = want;
  }
  langMore = more;
  return { ok: true, data: rows };
}
async function askRows(startIndex: number, q?: string): Promise<IpcResult<LibraryItem[]>> {
  if (kind.value !== 'resume') {
    if (isSearch.value && langOn.value) return askSearchSplit(startIndex, q ?? effectiveQuery());
    if (kind.value === 'view' && langOn.value && showsWanted.value) return askLibraryLang(startIndex === 0);
    return window.echoemby.emby.items(params(startIndex, q));
  }
  const r = await window.echoemby.emby.resumeRow(pageSize.value);
  return { ok: r.ok, data: r.ok ? r.data?.items || [] : undefined, error: r.error };
}

const items = ref<LibraryItem[]>([]);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const hasMore = ref(false);

/** The Series behind a run of matching episodes, by series id. A list row for an Episode carries
 *  「S01E05 …」 and the episode's own still, so the folded card cannot be built from it. */
const seriesById = ref<Record<string, LibraryItem>>({});
let seriesAccount = '';

const episodeShows = (batch: LibraryItem[]): string[] => {
  const ids = new Set<string>();
  for (const it of batch) if (it.type === 'Episode' && it.parentId) ids.add(it.parentId);
  return [...ids];
};

async function rememberSeries(ids: string[]): Promise<void> {
  const account = store.account?.accountId || '';
  // Ids are per-server, so a cache kept across an account switch would dress a show in the wrong art.
  if (account !== seriesAccount) {
    seriesById.value = {};
    seriesAccount = account;
  }
  const need = ids.filter(id => !seriesById.value[id]);
  if (!need.length) return;
  const r = await window.echoemby.emby.items({ Ids: need.join(','), Limit: need.length });
  const found = r.ok ? r.data || [] : [];
  // Measured on bangumi: a show filed under two libraries exists as two Series rows there, and only
  // one of them answers an Ids query — the item endpoint resolves both. So the misses get asked one
  // by one, which keeps the batch for the servers that do answer it.
  const missed = need.filter(id => !found.some(x => x.id === id));
  const singles = await Promise.all(
    missed.map(id => embyCached('item', id, () => window.echoemby.emby.item(id)).then(x => (x.ok ? x.data : null))),
  );
  const next = { ...seriesById.value };
  for (const it of [...found, ...singles.filter((x): x is LibraryItem => !!x)]) next[it.id] = it;
  seriesById.value = next;
}

/** Two library folders can hold the same show twice (measured on bangumi: 鬼灭之刃 as four Series
 *  rows, three of which never answer an Ids query), so a second copy of the same card drops out.
 *  A show merges on its name alone — the duplicate rows disagree about the year, one carrying none.
 *  A film keeps the year, because 活着 (1994) and 活着 (2020) are two different films. */
const cardKey = (x: LibraryItem): string => (x.type === 'Series' ? `S|${x.name}` : `${x.type}|${x.name}|${x.productionYear || ''}`);

/** Which show a 在看 row belongs to. Name, not the server's series id: the library holds some shows
 *  twice under two ids (measured on bangumi: 鬼灭之刃 as four Series rows), and one card is one show. */
const resumeKey = (x: LibraryItem): string => (x.type === 'Episode' ? `S|${x.seriesName || x.parentId || x.id}` : x.id);

/* 在看 needs one thing more than a row carries: how many episodes the season the stop sits in actually
   holds, which is the denominator of its bar. The episode row cannot say it — measured on nyamedia, it
   answers a stop for 15 of the page's 94 rows and nothing at all for the other 79 — while the *season* row
   answers `ChildCount` for every one of them, and one batched `Items?Ids=` over 40 season ids comes back
   40/40. So the page asks once for the seasons its cards name. */
const seasonRows = ref<Record<string, { total?: number }>>({});
let seasonAsk = '';

async function askSeasons(batch: LibraryItem[]): Promise<void> {
  const ids = [...new Set(batch.filter(x => x.type === 'Episode' && x.seasonId).map(x => x.seasonId as string))].sort();
  const key = `${store.account?.accountId || ''}|${ids.join(',')}`;
  if (key === seasonAsk) return;
  seasonAsk = key;
  const out: Record<string, { total?: number }> = {};
  // Chunked because the id list rides the query string, and 94 of them is a URL this gateway has never seen.
  for (let i = 0; i < ids.length; i += 60) {
    const chunk = ids.slice(i, i + 60);
    const r = await window.echoemby.emby.items({ Ids: chunk.join(','), Limit: chunk.length, Fields: 'ChildCount' });
    if (key !== seasonAsk) return;
    for (const s of r.ok ? r.data || [] : []) out[s.id] = { total: s.childCount };
  }
  if (key !== seasonAsk) return;
  seasonRows.value = out;
}

const seasonOf = (it: LibraryItem) => seasonRows.value[it.seasonId || ''] || null;

/** 87 episodes of one show arrived as 87 cards. A library catalogue answers a title once, so an
 *  episode run folds into its Series card; 在看 folds too, but keeps the episode — the card is the
 *  thing to resume, so its art, its position and its play button all come from that row.
 *  The sort runs over the cards, not the rows they came from: an episode's own rating and name are
 *  not what the card displays, and sorting first put ★8.1 above the ★8.2 card that followed it. */
const shown = computed<LibraryItem[]>(() => {
  const src = items.value;
  if (kind.value === 'resume') {
    // Newest-played first, so the first row of a show is the episode to resume — the home rail's rule.
    const once = new Set<string>();
    return src.filter(it => {
      const k = resumeKey(it);
      if (once.has(k)) return false;
      once.add(k);
      return true;
    });
  }
  // A library window folds only when a language is on: that is the one condition the server cannot answer
  // on a Series row, so the page behind it is a run of episodes and its cards have to be rebuilt from them.
  if (!isSearch.value && kind.value !== 'favorites' && !(kind.value === 'view' && langOn.value)) return src;
  const onScreen = new Set(src.filter(x => x.type !== 'Episode').map(x => x.id));
  const taken = new Set<string>();
  const once = new Set<string>();
  const cards: LibraryItem[] = [];
  for (const it of src) {
    let card = it;
    const seriesId = it.type === 'Episode' ? it.parentId : '';
    if (seriesId) {
      if (onScreen.has(seriesId) || taken.has(seriesId)) continue;
      taken.add(seriesId);
      card = seriesById.value[seriesId] || it;
    }
    const key = cardKey(card);
    if (once.has(key)) continue;
    once.add(key);
    cards.push(card);
  }
  // 收藏 already arrived in the server's DateCreated order; folding must not move the works that
  // were not touched, so the raw order stands rather than a re-sort of the Series rows' own dates.
  return kind.value === 'favorites' ? cards : localSort(cards, filters.value.sort);
});

/** The empty search page is a shop window, not a blank one. Two asks fill it: the films, and the
 *  shows, which split into 剧集 and 番剧 by the genre each row already carries. The split has to be
 *  local — ExcludeGenres is silently ignored on this gateway, measured byte-identical to asking
 *  without it — and it is free, because 100 of 100 of the newest Series rows on both hosts answer
 *  with their genres filled in. */
const SHELF_WINDOW = 100;
const SHELF_CARDS = 18;
const isAnime = (x: LibraryItem): boolean => (x.genres || []).some(g => /动画|动漫|Anime/i.test(g));

const shelves = ref<{ key: string; title: string; items: LibraryItem[] }[]>([]);
const shelvesLoading = ref(false);
/** Which ask still owns the page: two filter chips clicked in a row put two windows in flight, and
 *  the slower one would otherwise land last and dress the shelves in the conditions just dropped. */
let shelfSeq = 0;

async function loadShelves(): Promise<void> {
  const seq = ++shelfSeq;
  shelvesLoading.value = true;
  const picked = filters.value;
  const base = { ...filterParams(picked), Recursive: true, SortBy: 'PremiereDate', SortOrder: 'Descending', Limit: SHELF_WINDOW };
  const ask = (types: string) => window.echoemby.emby.items({ ...base, IncludeItemTypes: types });
  // 类型 picks which shelves are on the topic at all, so the other one is not even asked for.
  const [films, shows] = await Promise.all([
    picked.type === 'Series' ? Promise.resolve(null) : ask('Movie'),
    picked.type === 'Movie' ? Promise.resolve(null) : ask('Series'),
  ]);
  if (seq !== shelfSeq) return;
  shelvesLoading.value = false;
  // A term typed while the landing was still in flight owns the page now.
  if (isSearch.value && term.value.trim()) return;
  const series = shows?.ok ? shows.data || [] : [];
  const rows = [
    { key: 'movie', title: '电影', items: films?.ok ? films.data || [] : [] },
    { key: 'series', title: '剧集', items: series.filter(x => !isAnime(x)) },
    { key: 'anime', title: '番剧', items: series.filter(x => isAnime(x)) },
  ];
  shelves.value = rows.filter(r => r.items.length).map(r => ({ ...r, items: r.items.slice(0, SHELF_CARDS) }));
  if (!films?.ok && !shows?.ok) error.value = films?.error || shows?.error || '加载失败';
}

/** Which library narrows the two facet lists. A window asks for its own (the gateway honours
 *  `/Genres?ParentId=` and `/Studios?ParentId=`), a search reaches across the account and asks for all.
 *  The difference is what turns dead entries into answers: 27 genre labels against 华语电影's own 24 rows left
 *  eight that emptied the page, and the company list narrows from 8,185 rows to that library's 1,386. */
const facetScope = computed(() => (kind.value === 'view' ? viewId.value : ''));

/** The /Genres facet lives in the store, so a server that was slow on the first ask gets asked again. */
const genreOptions = computed(() => store.genres);
/** 公司 is a facet of the library, not of the page: read from /Studios through the store, the same shape
 *  分类 takes from /Genres. Building it out of the rows on screen is what made a search page with no rows
 *  yet show no 公司 pill at all, and a page of 48 films offer the twelve companies behind them. */
const studioOptions = computed(() => store.studios);

/** Prefetched as soon as the bar is on screen, so the panel is already full the first time it is opened;
 *  the ask is one per account and cached, so a page that never opens 公司 costs one request per session. */
function prefetchStudios(): void {
  if (showBar.value) void store.loadStudios(facetScope.value);
}

/** The types this window can actually answer with. Measured: a film library holds no Series, a television
 *  library no Movie, and 合集 lives in a library of its own — so those entries were controls whose only
 *  outcome was an empty page. A mixed library keeps all three. */
const typeOptions = computed(() => {
  const lib = store.views.find(v => v.id === viewId.value);
  const holds = lib?.collectionType || '';
  if (holds === 'movies') return TYPE_OPTIONS.filter(o => o.value === 'Movie');
  if (holds === 'tvshows') return TYPE_OPTIONS.filter(o => o.value === 'Series');
  if (holds === 'boxsets') return TYPE_OPTIONS.filter(o => o.value === 'BoxSet');
  return TYPE_OPTIONS;
});

/** 搜索 reaches only the spelling the library filed the work under, and this is the renderer's half of the
 *  fix: TMDB knows every name of a work (through `meta.tmdbTitles`), this library does not, and
 *  `AnyProviderIdEquals` lets the library be asked by the work's own id — measured to answer on both
 *  gateways the exact row that 「進擊的巨人」 and 「진격의 거인」 cannot reach from a name alone. */
async function aliasIds(): Promise<string[]> {
  const r = await window.echoemby.meta.tmdbTitles(effectiveQuery());
  return r.ok && r.data ? r.data : [];
}

/** The rows behind those ids that the typed term did not already find. They are appended rather than sorted
 *  in: the term's own hits are what the viewer typed, and a work the library spells natively must not be
 *  pushed down by one it spells in another language. */
async function aliasRows(ids: string[], batch: LibraryItem[]): Promise<LibraryItem[]> {
  if (!ids.length) return [];
  const p = params(0);
  /* The two parameters cannot ride together — measured, `AnyProviderIdEquals` beside a `SearchTerm` answers
     with nothing at all — so the id ask is its own query. The page's filters do apply to it, which is what
     keeps a name lookup from smuggling a 电影 into a list typed at 剧集. */
  delete p.SearchTerm;
  const r = await window.echoemby.emby.items({ ...p, AnyProviderIdEquals: ids.join(','), Limit: ids.length * 2 });
  if (!r.ok) return [];
  const known = new Set(batch.map(x => x.id));
  return (r.data || []).filter(x => !known.has(x.id));
}

/** The query this load was for; a route change that lands on the same query is only a re-order. */
let lastKey = '';
/** Rows the server has actually answered, which is what pages its window. Kept apart from `items` because
 *  a first page also carries the rows the name lookup added below: those were never part of the 200 the
 *  server just sent, and counting them would push every later page's StartIndex past a row. */
let paged = 0;
/** A reset asked for while a request is still in flight. Dropping it leaves the URL saying one term
 *  over the previous term's grid, which is what a fast 加载更多-then-retype did on the live app. */
let queued = false;

async function load(reset: boolean): Promise<void> {
  if (busy.value) {
    queued = reset || queued;
    return;
  }
  // An empty SearchTerm is not 「搜这个空字符串」 but 「没有这个条件」: the gateway treats it as
  // unfiltered and dumps the library, which is what filled 搜索 with 「#活着」 before I typed a name.
  if (isSearch.value && !term.value.trim()) {
    items.value = [];
    hasMore.value = false;
    error.value = '';
    loading.value = false;
    lastKey = JSON.stringify(params(0));
    void loadShelves();
    return;
  }
  shelves.value = [];
  busy.value = true;
  try {
    if (reset) {
      loading.value = true;
      items.value = [];
      error.value = '';
      lastKey = JSON.stringify(params(0));
      paged = 0;
    }
    const from = reset ? 0 : paged;
    /* Sent beside the library ask rather than after it: the TMDB hop and the library request are
       independent, and a Japanese or Romanized term should not cost two waits in a row. Only a first page
       asks — 加载更多 continues a list whose work the first page already named. */
    const aliasAsk = isSearch.value && from === 0 ? aliasIds() : null;
    let r = await askRows(from);
    let batch = r.ok ? r.data || [] : [];
    // One retry pass, and only on an empty first page, so a term that already answers costs one request.
    // The shapes go out together: measured on this gateway, eight of them come back in 198ms while
    // asking one at a time takes 1380ms, and a dead-end query is what usually lands here.
    if (isSearch.value && from === 0 && r.ok && !batch.length) {
      // The retry travels through the same branch as the ask it stands in for, or a corrected spelling would
      // come back with films only and lose every show the language filter was meant to reach.
      const shapes = retryShapes(effectiveQuery()).slice(0, langOn.value ? 4 : 8);
      const tries = await Promise.all(shapes.map(q => askRows(0, q)));
      const hit = tries.findIndex(x => x.ok && (x.data || []).length > 0);
      if (hit >= 0) {
        searchQuery = shapes[hit];
        lastKey = JSON.stringify(params(0));
        r = tries[hit];
        batch = r.data || [];
      }
    }
    if (!r.ok) {
      error.value = r.error || '加载失败';
      return;
    }
    paged += batch.length;
    /* Only a thin first page asks: 40 cards already name the work the viewer meant, and the extra query is
       what a term with a handful of hits (or none at all) needs most. */
    const direct = batch.length;
    if (aliasAsk && direct < 40) {
      const extra = await aliasRows(await aliasAsk, batch);
      if (extra.length) batch = [...batch, ...extra];
    }
    // Before the rows go on screen: the fold has to be settled or the episode card would swap into a
    // show card under the user's cursor a beat after the grid paints.
    if (isSearch.value) await rememberSeries(episodeShows(batch));
    else if (kind.value === 'view' && langOn.value) {
      // Same fold as 收藏: the run of episodes has to be dressed as its show before it paints, and a Series
      // row already in the list is its own card.
      const onScreen = new Set([...items.value, ...batch].filter(x => x.type !== 'Episode').map(x => x.id));
      await rememberSeries(episodeShows(batch).filter(id => !onScreen.has(id)));
    } else if (kind.value === 'favorites') {
      // 收藏 is a list of works: an Episode row is folded into its Series before paint. A Series
      // already accumulated is its own card, so only the orphan parents are asked for.
      const onScreen = new Set([...items.value, ...batch].filter(x => x.type !== 'Episode').map(x => x.id));
      await rememberSeries(episodeShows(batch).filter(id => !onScreen.has(id)));
    }
    items.value = reset ? batch : [...items.value, ...batch];
    // Off the direct rows, not the merged ones: an alias row has no place in the server's 200-row window.
    hasMore.value =
      isSearch.value && langOn.value ? splitMore
      : kind.value === 'view' && langOn.value && showsWanted.value ? langMore
      : direct === pageSize.value;
    if (kind.value === 'resume') void askSeasons(items.value);
    // The facet is allowed to fail with the server: once rows are in, the library is answering.
    if (batch.length) void store.loadGenres(facetScope.value);
  } finally {
    busy.value = false;
    loading.value = false;
  }
  if (queued) {
    const again = queued;
    queued = false;
    void load(again);
  }
}

/** Re-ask the window of rows the page already shows, without emptying it first. Used for a refresh the
 *  user did not ask for — the rows on screen are not wrong yet, and swapping them under the cursor is
 *  cheaper than a skeleton that blinks for nothing. */
async function sync(): Promise<void> {
  if (busy.value) return;
  const r = await askRows(0);
  if (!r.ok) return;
  const batch = r.data || [];
  items.value = batch;
  hasMore.value = kind.value === 'view' && langOn.value && showsWanted.value ? langMore : batch.length === pageSize.value;
  if (kind.value === 'resume') void askSeasons(batch);
}

const wrapEl = ref<HTMLElement | null>(null);
const cols = ref(6);
const cardW = ref(190);
function fit(): void {
  const w = wrapEl.value?.clientWidth || 0;
  if (!w) return;
  const gap = 16;
  const min = layout.value === 'list' ? 400 : 172;
  const floor = layout.value === 'list' ? 1 : 2;
  // Three across at most. A horizontal row is the one shape that stops gaining something useful at about
  // 400px: below that the frame and the count line start competing for the same pixels.
  const cap = layout.value === 'list' ? 3 : 99;
  const c = Math.min(cap, Math.max(floor, Math.floor((w + gap) / (min + gap))));
  cols.value = c;
  cardW.value = Math.floor((w - (c - 1) * gap) / c);
  void fitSkeleton();
}
let ro: ResizeObserver | null = null;
const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${cols.value}, ${layout.value === 'list' ? 'minmax(0, 1fr)' : cardW.value + 'px'})`,
}));

/* How many tiles the loading grid draws. It used to be a literal — 8 rows-tiles for the list, 18 posters for
   the grid — and at a short window the list left a third of the page bare while at a tall one the posters ran
   past the fold into a scrollbar. The count is now measured off the tiles themselves: one row's pitch times
   the rows that fit between the grid's top edge and the bottom of the page. */
const skEl = ref<HTMLElement | null>(null);
const skCells = ref(12);
async function fitSkeleton(): Promise<void> {
  await nextTick();
  const el = skEl.value;
  const one = el?.firstElementChild as HTMLElement | null;
  if (!el || !one) return;
  const page = el.closest('.page') as HTMLElement | null;
  // One row's pitch is the distance between the first cell and the cell directly under it, so a placeholder
  // that carries a margin for the label lines under it (the poster tile does) is counted at the height the
  // grid actually advances by. Height + gap alone would under-count that row and push an extra one past the fold.
  const kids = el.children;
  const step = kids.length > cols.value
    ? kids[cols.value].getBoundingClientRect().top - kids[0].getBoundingClientRect().top
    : (one.getBoundingClientRect().height + 16);
  const pitch = step > 0 ? step : one.getBoundingClientRect().height + 16;
  const top = el.getBoundingClientRect().top - (page?.getBoundingClientRect().top || 0) + (page?.scrollTop || 0);
  const rows = Math.max(1, Math.ceil(((page?.clientHeight || window.innerHeight) - top) / pitch));
  skCells.value = Math.min(60, rows * cols.value);
}
watch(loading, () => void fitSkeleton());
// The rail can be mid-transition when the kind changes, so re-measure once the new layout is on screen.
watch(layout, async () => {
  await nextTick();
  fit();
});

let deb: number | null = null;
watch(term, () => {
  if (kind.value !== 'search') return;
  if (deb !== null) window.clearTimeout(deb);
  deb = window.setTimeout(() => {
    const q = term.value.trim();
    if ((router.currentRoute.value.query.q || '') !== q) void go({ q });
  }, 420);
});

/** The URL is the one source of truth for what is on screen, so both the filters and the term
 *  move by rewriting it and letting the route watcher do the fetching. */
function go(part: Record<string, string>): void {
  void router.replace({ path: '/browse', query: { ...route.query, ...part } });
}

function onFilters(next: Filters): void {
  filters.value = next;
  // The old filter keys have to come off the query, not just be overwritten: clearing a filter
  // writes fewer keys than it removes, and a merge would leave the ones it no longer mentions.
  const { type, genres, years, studio, langs, sort, ...rest } = route.query;
  void router.replace({ path: '/browse', query: { ...rest, ...toQuery(next) } });
}

/** The rail's 在看/收藏 and each library window are ONE instance of this page, so nothing is torn down
 *  between them and the reader's place in the list they were reading survives as a place in the list they
 *  never asked for: measured, a 1200-row list scrolled to its end landed on 收藏 at 197 — that is just the
 *  shorter page clamping the old offset, not a reset.
 *  One instance also means the page-level push has nothing to move: the element Vue would swap IS the
 *  element that stays. So the shelves slide as panes of this page instead, and `shelf` is what says which
 *  shelf owns the screen. A typed term and a filter chip are deliberately NOT in it — they move by
 *  `router.replace`, they re-ask the same shelf, and a slide per keystroke would be a strobe. */
watch(facetScope, () => {
  if (!showBar.value) return;
  void store.loadGenres(facetScope.value);
  void store.loadStudios(facetScope.value);
});

const shelf = computed(() => `${kind.value}|${viewId.value}`);
/** The last shelf this page actually owned, for the way out. `kind` and `viewId` are read off
 *  `route.query`, so walking to 设置 empties them and the key changes on the way: the page then runs a pane
 *  swap underneath its own page push, and the two layers travel opposite ways — measured, 收藏 leaving right
 *  and 在看 entering left inside a window that was itself leaving left. Out of the route there is no shelf
 *  to swap, so the key that rides out is the one the reader was on. */
const lastShelf = ref(shelf.value);
watch(shelf, v => {
  if (route.name === 'browse') lastShelf.value = v;
});
const paneKey = computed(() => (route.name === 'browse' ? shelf.value : lastShelf.value));
/** Which way that shelf travels: the history is the only thing that knows whether the shelf behind us is
 *  the one we are landing on (a 返回) or the one we are leaving. */
const paneMove = computed(() => (paneDir.value === 'pop' ? 'pane-pop' : 'pane-push'));

/* The two shelves share one scroller, so the reset that puts the arriving one at its beginning drags the one
   still on screen along with it: a 在看 list read down to 2400px jumped its first row from y=-2265 to y=135
   in 32ms and only then slid away. The offset is taken here, one statement before the reset, and the leaving
   shelf pays it back as `--pin` so it slides out from where the reader actually was. */
let panePin = 0;
function pinLeavingPane(el: Element): void {
  (el as HTMLElement).style.setProperty('--pin', `${-panePin}px`);
}

const pageEl = ref<HTMLElement | null>(null);
watch(
  () => route.fullPath,
  () => {
    if (route.name !== 'browse') return;
    if (kind.value === 'search') term.value = String(route.query.q || '');
    filters.value = readFilters();
    // Picking a sort on a search only re-orders the window we hold; the query is unchanged.
    if (JSON.stringify(params(0)) === lastKey) return;
    panePin = pageEl.value?.scrollTop || 0;
    resetPageScroll(pageEl.value);
    void load(true);
  },
);

/** Closing the player moves rows that no write-back can reach: 在看 re-orders by when a title was last
 *  opened, and gains one that was never in it. That is the server's answer, not a copy of one, so the
 *  page is re-asked — and only for 在看: a pause-and-close writes the stop onto every other list's row. */
watch(
  () => store.lastStop,
  w => {
    if (!w) return;
    if (kind.value === 'resume') void sync();
    // 搜索 and a library window hold their own rows too, and a film in one of them wears the same 看到
    // chip. A stop moves neither list's order, so the number is written onto the row instead of re-asked.
    else for (const it of items.value) if (it.id === w.itemId) applyStop(it, w);
  },
);

function open(item: LibraryItem): void {
  const target = item.type === 'Episode' ? item.parentId : item.id;
  if (target) router.push(`/detail/${target}`);
}

const toast = ref('');
let toastTimer: number | null = null;
function say(msg: string): void {
  toast.value = msg;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.value = ''), 3600);
}

async function onPlay(item: LibraryItem): Promise<void> {
  // One table for the whole app: this branch used to re-list the types by hand and had already lost
  // `Season`, so a season card would have been handed to the player as if it named a file.
  if (!PLAYABLE.includes(item.type)) {
    open(item);
    return;
  }
  const ok = await player.play(item.id);
  if (!ok) say(player.error || '无法开始播放');
}

onMounted(async () => {
  if (!store.ready) await store.init();
  if (!store.account) {
    router.replace('/login');
    return;
  }
  void store.loadViews();
  void store.loadGenres(facetScope.value);
  prefetchStudios();
  await nextTick();
  fit();
  // The observer lives on `.panes`, the box the shelves are stacked in, not on a shelf itself: switching
  // 在看 to 收藏 remounts that subtree, and an observer bound to the first one's element would keep
  // measuring a detached node — the card width would simply stop following the window.
  if (window.ResizeObserver && wrapEl.value) {
    ro = new ResizeObserver(fit);
    ro.observe(wrapEl.value);
  }
  void load(true);
});

onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
  if (deb !== null) window.clearTimeout(deb);
  if (toastTimer !== null) window.clearTimeout(toastTimer);
});
</script>

<template>
  <div ref="pageEl" class="page">
    <div ref="wrapEl" class="panes">
      <transition :name="paneMove" type="animation" @before-leave="pinLeavingPane">
        <div :key="paneKey" class="pane">
          <header class="head">
            <h1>{{ title }}</h1>

            <div class="tools">
              <label v-if="kind === 'search'" class="field">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                  <path d="M11 4.6a6.4 6.4 0 1 0 0 12.8 6.4 6.4 0 0 0 0-12.8Z" />
                  <path d="M19.4 19.4 15.6 15.6" />
                </svg>
                <input v-model="term" type="search" placeholder="搜索片名、剧集" spellcheck="false" />
              </label>
            </div>
          </header>

          <FilterBar
            v-if="showBar"
            class="fbar"
            :filters="filters"
            :genre-options="genreOptions"
            :studio-options="studioOptions"
            :studios-loading="store.studiosLoading"
            :is-search="isSearch"
            :type-options="typeOptions"
            @change="onFilters"
          />

          <div class="body">
            <p v-if="error" class="err">{{ error }} <button @click="load(true)">重试</button></p>

            <div v-if="loading" ref="skEl" class="grid sk" :class="{ list: layout === 'list' }" :style="gridStyle">
              <template v-if="layout === 'list'">
                <div v-for="n in skCells" :key="n" class="cell list" :class="{ queue: rowVariant === 'queue' }">
                  <span class="th"></span>
                  <span class="bd">
                    <i class="k1"></i><i class="k2"></i>
                    <template v-if="rowVariant !== 'queue'">
                      <i class="o"></i><i class="o"></i><i class="o"></i>
                      <span class="gs"><i></i><i></i></span>
                    </template>
                    <template v-else>
                      <i class="qc"></i>
                    </template>
                  </span>
                </div>
              </template>
              <template v-else>
                <div v-for="n in skCells" :key="n" class="cell" :style="{ width: cardW + 'px' }"><span></span></div>
              </template>
            </div>

            <div v-else-if="shown.length" class="grid in" :class="{ list: layout === 'list' }" :style="gridStyle">
              <template v-if="layout === 'list'">
                <ListCard
                  v-for="(it, i) in shown"
                  :key="`${it.id}-${i}`"
                  :item="it"
                  :index="i % 12"
                  :variant="rowVariant"
                  :season="seasonOf(it)"
                  @play="onPlay"
                />
              </template>
              <template v-else>
                <MediaCard
                  v-for="(it, i) in shown"
                  :key="`${it.id}-${i}`"
                  :item="it"
                  variant="poster"
                  :width="cardW"
                  :index="i % 12"
                  @play="onPlay"
                />
              </template>
            </div>

            <div v-else-if="shelvesLoading" class="shelves">
              <div v-for="n in 2" :key="n" class="rsk">
                <div class="hd"></div>
                <div class="cards"><span v-for="m in 8" :key="m" class="cd"></span></div>
              </div>
            </div>

            <div v-else-if="isSearch && !term.trim() && shelves.length" class="shelves">
              <RowScroller v-for="r in shelves" :key="r.key" :title="r.title" :items="r.items" :count="false" @play="onPlay" />
            </div>

            <p v-else-if="kind === 'search'" class="empty">
              {{ isFiltered(filters) ? '这个筛选条件下没有内容。' : term.trim() ? '没有匹配的结果。' : '输入片名开始搜索。' }}
            </p>
            <p v-else-if="isFiltered(filters)" class="empty">这个筛选条件下没有内容。</p>
            <p v-else class="empty">
              {{ kind === 'favorites' ? '还没有收藏的内容。' : '这个列表目前是空的。' }}
            </p>

            <!-- Stays in the layout while the batch is in flight and goes grey instead of disappearing:
                 that took its own 67px box (41 tall + 26 margin) out of the scroll height, so the browser
                 clamped scrollTop by the same amount (3132 -> 3065) and never gave it back — every
                 加载更多 nudged the page up once before the new rows arrived. A reset is the one case
                 that may drop it, and the skeleton has already replaced the grid it belongs to. -->
            <button v-if="hasMore && !loading" class="more" :disabled="busy" @click="load(false)">加载更多</button>
          </div>

        </div>
      </transition>
    </div>
    <Transition name="toast">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.page {
  --side: clamp(10px, 1.8vw, 26px);
  --gutter: calc(var(--nav-w) + var(--side));
  position: relative;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  /* Only the left side pays for the overlay sidebar; padding the right the same way shoved the page off-centre. */
  padding: calc(var(--titlebar-h) + 22px) var(--side) 46px var(--gutter);
  transition: padding var(--rail-dur) var(--rail-ease);
}
/* The shelves inside this page travel the way two pages do, because switching between them swaps no
   element: this one component answers 在看, 收藏, 搜索 and every 资源库 window, so the router has no page
   transition to run. `.panes` is a single grid cell with each shelf stacked in it, which keeps the pair
   from doubling the page's height for the length of the move, and the keyframes are the window's own
   (base.css): same shape, same clock, same ease as the push between two pages. */
.panes {
  display: grid;
  grid-template-columns: 100%;
  align-items: start;
}
.pane {
  grid-area: 1 / 1;
  min-width: 0;
}
/* The pointer is deaf to both of them mid-move, since neither shelf is where it is going to be, and the
   arrival paints on top so the two edges meet on a sub-pixel rather than the leaving shelf drawing over
   the one being entered. No alpha anywhere: the page's own ground stays put under both. */
.pane-push-enter-active,
.pane-push-leave-active,
.pane-pop-enter-active,
.pane-pop-leave-active {
  pointer-events: none;
  will-change: transform;
}
.pane-push-enter-active,
.pane-pop-enter-active {
  z-index: 2;
}
/* The shelf that is leaving pays for the shared scroller's trip back to the top: `--pin` is the offset it
   was read at, so `top` puts it back there and it slides out from the rows the reader was looking at rather
   than from its own beginning. Relative rather than a transform, because the transform belongs to the slide,
   and only the leaving shelf carries it: the arriving one does begin at its top. */
.pane-push-leave-active,
.pane-pop-leave-active {
  --pin: 0px;
  z-index: 1;
  position: relative;
  top: var(--pin);
}
.pane-push-enter-active {
  animation: page-in-right var(--page-dur) var(--rail-ease) both;
}
.pane-push-leave-active {
  animation: page-out-left var(--page-dur) var(--rail-ease) both;
}
.pane-pop-enter-active {
  animation: page-in-left var(--page-dur) var(--rail-ease) both;
}
.pane-pop-leave-active {
  animation: page-out-right var(--page-dur) var(--rail-ease) both;
}
.head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 22px;
  flex-wrap: wrap;
  margin-bottom: 22px;
}
h1 {
  margin: 0;
  font-size: clamp(22px, 2.6vw, 30px);
  font-weight: 700;
  letter-spacing: -0.3px;
  color: var(--text);
}
.tools {
  display: flex;
  align-items: center;
  gap: 12px;
}
.field {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 13px;
  border-radius: 999px;
  color: var(--text-dim);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
  transition: border-color var(--hov) var(--ease), box-shadow var(--hov) var(--ease);
}
.field:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.field input {
  width: 260px;
  border: 0;
  outline: 0;
  background: none;
  font-size: 14px;
  color: var(--text);
}
/* The bar sits where the old three-button sort switch sat, so the header keeps its breathing room. */
.fbar {
  margin: -14px 0 20px;
}

/* The landing shelves are the lobby's rows, which lay themselves out from --gutter/--tuck/--rail-x and
   assume their container starts at the window edge — so this box pays the page padding back with
   negative margins. --rail-x goes to 0 rather than the lobby's 12px: this page's content line already
   sits a --side past the rail, and that is the line the title and the first poster have to meet. */
.shelves {
  --tuck: 214px;
  --rail-x: 0px;
  margin: 0 calc(0px - var(--side)) 0 calc(0px - var(--gutter));
}
.rsk {
  /* Same split as the real row: 16 above the header, the header's 27.9 line box plus its 11 margin,
     the track's 6 above the cards, 24 below them. */
  padding: 16px var(--side) 24px calc(var(--gutter) - var(--rail-x));
}
.rsk .hd {
  width: 150px;
  height: 15px;
  border-radius: var(--r-badge);
  margin: 6.5px 0 17.4px;
  background: var(--shimmer);
  background-size: var(--sk-tile) 100%;
  animation: sh 1.3s linear infinite;
}
.rsk .cards {
  display: flex;
  gap: 14px;
  padding-top: 6px;
  overflow: hidden;
}
.rsk .cd {
  width: 190px;
  flex: none;
  aspect-ratio: 2 / 3;
  /* .label's 9px of padding plus two text lines. */
  margin-bottom: 49.3px;
  border-radius: var(--radius);
  background: var(--shimmer);
  background-size: var(--sk-tile) 100%;
  animation: sh 1.3s linear infinite;
}
.rsk .cd:nth-child(n + 7) {
  opacity: 0.55;
}

.grid {
  display: grid;
  justify-content: start;
  gap: 16px;
  align-items: start;
}
/* Two rows side by side read as a table, so the pair keeps one height. */
.grid.list {
  align-items: stretch;
}
.grid > * {
  min-width: 0;
}
.cell {
  aspect-ratio: 2 / 3;
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg-elev);
  border: 1px solid var(--line);
}
/* The queue tile is the card's own box model rather than a shape that approximates it: a 16:9 frame at the
   card's width — `height: auto`, so the frame drives the tile the way it drives the real card instead of the
   tile stretching the frame — and the three lines are the card's three line boxes: 24 for the 15.5px title,
   20.1 for the two 13px lines, 5px apart, the count pushed to the bottom edge by `margin-top: auto` exactly
   as `.foot` pushes it. Only the glyph band inside each box shimmers (15.5 and 13 tall, centred in the box),
   so nothing moves when the text lands. The widths are the medians measured across the first 20 filled cards
   — 77 / 153 / 95 of a 314.2 column — where the old 46 / 88 / 44% stood two lines in a row too long.
   The progress pill on the frame needs no placeholder: a shimmering frame already covers it. */
.cell.list.queue {
  height: auto;
}
.cell.list.queue > .th {
  width: clamp(150px, 35%, 178px);
  aspect-ratio: 16 / 9;
}
.cell.list.queue .bd .k1,
.cell.list.queue .bd .k2,
.cell.list.queue .bd .qc {
  display: flex;
  align-items: center;
  background: none;
  animation: none;
}
.cell.list.queue .bd .k1 {
  width: 25%;
  height: 24px;
}
.cell.list.queue .bd .k2 {
  width: 49%;
  height: 20.1px;
  margin-top: 5px;
}
.cell.list.queue .bd .qc {
  width: 30%;
  height: 20.1px;
  margin-top: auto;
}
.cell.list.queue .bd .k1::after,
.cell.list.queue .bd .k2::after,
.cell.list.queue .bd .qc::after {
  content: '';
  display: block;
  width: 100%;
  height: 13px;
  border-radius: 6px;
  background: var(--shimmer);
  background-size: var(--sk-tile) 100%;
  animation: sh 1.3s linear infinite;
}
.cell.list.queue .bd .k1::after {
  height: 15px;
}
.cell.list {
  aspect-ratio: auto;
  height: 186px;
  border-radius: var(--r-tile);
  /* The row drawn from the inside rather than as one slab. What a real list row is while it fills in: a
     panel holding a 92-wide thumb (the only part of it that shimmers, because that is the only part of it
     that has an image to wait for) and four text rows — the title, the meta line, the synopsis, the badge
     row. Measured off the real card: head 23, +5 meta 20, +9 and 20.8 a line for three, +11 badges 26 =
     156.4 against this tile's own 156 of content.
     The height keeps the tall shape because a list puts two rows on a grid line and the line takes the
     taller of the pair (measured over 48 rows: 26 at 168, 22 at 184-186, so the pitch the grid answers for is
     the tall one) — and a thumb stretched to the line is what the short row shows there too. */
  display: flex;
  gap: 14px;
  padding: 14px;
}
.cell.list > .th {
  width: 92px;
  height: auto;
  flex: none;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius);
}
.cell.list > .bd {
  width: auto;
  height: auto;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  /* `span` is the shimmer selector in this block, and the two boxes that hold the bars must not take it
     themselves: a sweep behind the whole text column is the slab this shape replaces. */
  background: none;
  animation: none;
}
.bd i {
  display: block;
  border-radius: 6px;
  background: var(--shimmer);
  background-size: var(--sk-tile) 100%;
  animation: sh 1.3s linear infinite;
}
.bd .k1 {
  width: 46%;
  height: 23px;
}
.bd .k2 {
  width: 88%;
  height: 20px;
  margin-top: 5px;
}
.bd .o {
  width: 100%;
  height: 20.8px;
  margin-top: 9px;
}
.bd .o + .o {
  margin-top: 0;
}
.bd .o:last-of-type {
  width: 72%;
}
/* The two badges the row actually carries here: 「看到」 and the runtime, 41 and 56 wide on the real card. */
.cell.list .gs {
  width: auto;
  height: 26px;
  display: flex;
  gap: 7px;
  margin-top: 11px;
  background: none;
  animation: none;
}
.gs i:first-child {
  width: 42px;
}
.gs i:last-child {
  width: 58px;
}
.cell span {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--shimmer);
  background-size: var(--sk-tile) 100%;
  animation: sh 1.3s linear infinite;
}
.sk .cell:nth-child(n + 13) {
  opacity: 0.5;
}
/* The tile these stand in for is the art plus its two label lines, so the bare 2/3 box is 50px short
   per row and the whole grid lifts as real cards land (measured: 204x306 cell against a 204x356 card). */
.sk .cell:not(.list) {
  margin-bottom: 49.3px;
}

.err,
.empty {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 26px 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-dim);
}
.err {
  color: var(--danger);
}
.err button {
  padding: 5px 13px;
  border-radius: 999px;
  background: var(--bg-elev);
  border: 1px solid var(--line);
  color: var(--text);
  font-size: 13px;
}
.err button:hover {
  background: var(--ink);
  border-color: transparent;
  color: var(--on-ink);
}
.more {
  display: block;
  margin: 26px auto 0;
  padding: 9px 22px;
  border-radius: 999px;
  font-size: 13.5px;
  color: var(--text);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
  animation: fade-in 0.3s var(--ease) both;
  transition: background var(--hov) var(--ease), color var(--hov) var(--ease), transform var(--hov) var(--ease-out), box-shadow var(--hov) var(--ease);
}
.more:hover {
  background: var(--ink);
  color: var(--on-ink);
  box-shadow: var(--shadow);
  transform: translate3d(0, -2px, 0);
}
/* The same dead-while-it-runs reading as the calendar's 刷新: grey, and the hover lift stays off, which
   Chromium would otherwise still apply to a disabled button. */
.more:disabled {
  opacity: 0.55;
}
.more:disabled:hover {
  background: var(--bg-elev);
  color: var(--text);
  box-shadow: var(--shadow-sm);
  transform: none;
}
</style>
