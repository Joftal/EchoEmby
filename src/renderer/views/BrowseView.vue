<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { IpcResult, LibraryItem, StudioRef } from '../../shared/types';
import MediaCard from '../components/home/MediaCard.vue';
import ListCard from '../components/home/ListCard.vue';
import RowScroller from '../components/home/RowScroller.vue';
import FilterBar from '../components/browse/FilterBar.vue';
import { defaultSort, filterParams, fromQuery, isFiltered, localSort, sortParams, toQuery, type Filters } from '../lib/filters';
import { embyCached } from '../lib/embycache';
import { PLAYABLE, applyStop } from '../lib/resume';
import { useAppStore } from '../stores/app';
import { usePlayerStore } from '../stores/player';

const store = useAppStore();
const player = usePlayerStore();
const route = useRoute();
const router = useRouter();

type Kind = 'resume' | 'unwatched' | 'favorites' | 'search' | 'view';

/** A search is ordered by hand over whatever we hold, so its first page has to be worth ordering. */
const PAGE = 48;
const SEARCH_PAGE = 200;
/** 在看 folds its rows into one card per show, and this server folds hard: measured 200 rows → 16 cards,
 *  400 → 21, 1200 → 25 (one show, 乡村爱情, holds 849 of the rows). 48 rows would have painted 13 cards and
 *  the next page would have added one or two. 200 rows is one request (~1.2s measured). */
const RESUME_PAGE = 200;

const kind = computed<Kind>(() => {
  const k = String(route.query.kind || '');
  if (k === 'resume' || k === 'unwatched' || k === 'favorites' || k === 'search') return k;
  return 'view';
});
const viewId = computed(() => String(route.query.view || ''));
const isSearch = computed(() => kind.value === 'search');
const pageSize = computed(() => (isSearch.value ? SEARCH_PAGE : kind.value === 'resume' ? RESUME_PAGE : PAGE));
const filters = ref<Filters>(fromQuery(route.query, defaultSort(isSearch.value)));
const term = ref(String(route.query.q || ''));

const titles: Record<Exclude<Kind, 'view'>, string> = {
  resume: '在看',
  unwatched: '待看',
  favorites: '收藏',
  search: '搜索',
};
const title = computed(() => (kind.value === 'view' ? decodeURIComponent(String(route.query.name || '')) || '资源库' : titles[kind.value]));
/** 在看 is a playback queue, not a shelf: nothing about it wants narrowing. */
const showBar = computed(() => kind.value !== 'resume');
const variant = computed(() => (kind.value === 'resume' ? 'still' : 'poster'));
/** The two watch-lists keep their wide rows; search joins the grid so the art reads under the filters. */
const layout = computed<'list' | 'grid'>(() => (kind.value === 'unwatched' || kind.value === 'favorites' ? 'list' : 'grid'));

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

function params(startIndex: number): Record<string, string | number | boolean> {
  const f = filterParams(filters.value);
  const s = sortParams(filters.value);
  const page = { StartIndex: startIndex, Limit: pageSize.value };
  // 在看 no longer sends this — `askRows` below answers the page from the lobby's row — but the shape stays
  // as the page's identity: `lastKey` compares it to decide whether a chip change is a new ask.
  if (kind.value === 'resume') return { Recursive: true, MediaTypes: 'Video', IsResumable: true, SortBy: 'DatePlayed', SortOrder: 'Descending', ...page };
  // `MediaTypes=Video` cannot carry a genre: measured on this gateway, adding Genres to it answers HTTP 500
  // for every label, while the same window asked by item type is byte-identical to it (48 of 48 rows, same
  // order, on both accounts) and does take Genres. 待看 has a 分类 dropdown, so it asks by type; 在看 has none
  // and keeps the media type, so it never sends the pair that breaks.
  if (kind.value === 'unwatched') return { Recursive: true, IncludeItemTypes: 'Movie,Episode,Video', Filters: 'IsUnplayed', ...f, ...s, ...page };
  // Measured: this server answers an IsFavorite query with nothing at all unless it is told which
  // kinds to look for, so 收藏 carries its own default list rather than relying on the server's.
  if (kind.value === 'favorites') return { Recursive: true, Filters: 'IsFavorite', IncludeItemTypes: 'Movie,Series,Episode,Video,BoxSet,Playlist', ...f, ...s, ...page };
  // Without this the search answers with Folder, Studio and Person rows: 「"骗骗"喜欢你」 showed up
  // twice because the library's container folder and the movie inside it are two different items.
  // The list has to be comma-joined here too — asked as `A|B` this server ignores it outright.
  if (kind.value === 'search')
    return { Recursive: true, SearchTerm: effectiveQuery(), IncludeItemTypes: 'Movie,Series,Episode,Video,BoxSet,Playlist', ...f, ...page };
  return { ParentId: viewId.value, IncludeItemTypes: 'Movie,Series,BoxSet,Playlist,Video', Recursive: true, ...f, ...s, ...page };
}

/** 在看 does not read the raw list: `IsResumable=true` on these forks says the *file* can be resumed, not
 *  that anything was stopped in it — measured, 33 of the 60 rows bangumi answers that way are already
 *  Played, so the shelf filled with finished episodes wearing no 看到 time. The lobby's merged row knows
 *  where each title actually continues, and it is the same two asks the rail already makes. */
async function askRows(startIndex: number): Promise<IpcResult<LibraryItem[]>> {
  if (kind.value !== 'resume') return window.echoemby.emby.items(params(startIndex));
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
  if (!isSearch.value) return src;
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
  return localSort(cards, filters.value.sort);
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

/** The /Genres facet lives in the store, so a server that was slow on the first ask gets asked again. */
const genreOptions = computed(() => store.genres);
/** Companies come from the results themselves: they are the only ids the 公司 filter can be given,
 *  and remembering them only while unfiltered keeps a picked genre from emptying the dropdown. */
const studioOptions = ref<StudioRef[]>([]);

function rememberStudios(batch: LibraryItem[], reset: boolean): void {
  const map = new Map<string, StudioRef>(reset ? [] : studioOptions.value.map(s => [s.id || s.name, s]));
  for (const it of batch) for (const s of it.studios || []) if (s.id) map.set(s.id, s);
  studioOptions.value = [...map.values()];
}

/** The query this load was for; a route change that lands on the same query is only a re-order. */
let lastKey = '';
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
    studioOptions.value = [];
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
    }
    const from = reset ? 0 : items.value.length;
    let r = await askRows(from);
    let batch = r.ok ? r.data || [] : [];
    // One retry pass, and only on an empty first page, so a term that already answers costs one request.
    // The shapes go out together: measured on this gateway, eight of them come back in 198ms while
    // asking one at a time takes 1380ms, and a dead-end query is what usually lands here.
    if (isSearch.value && from === 0 && r.ok && !batch.length) {
      const shapes = retryShapes(effectiveQuery());
      const tries = await Promise.all(shapes.map(q => window.echoemby.emby.items({ ...params(0), SearchTerm: q })));
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
    // Before the rows go on screen: the fold has to be settled or the episode card would swap into a
    // show card under the user's cursor a beat after the grid paints.
    if (isSearch.value) await rememberSeries(episodeShows(batch));
    items.value = reset ? batch : [...items.value, ...batch];
    hasMore.value = batch.length === pageSize.value;
    if (!isFiltered(filters.value)) rememberStudios(batch, reset);
    // The facet is allowed to fail with the server: once rows are in, the library is answering.
    if (batch.length) void store.loadGenres();
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
  hasMore.value = batch.length === pageSize.value;
}

const wrapEl = ref<HTMLElement | null>(null);
const cols = ref(6);
const cardW = ref(190);
function fit(): void {
  const w = wrapEl.value?.clientWidth || 0;
  if (!w) return;
  const gap = 16;
  const min = layout.value === 'list' ? 400 : variant.value === 'still' ? 300 : 172;
  const floor = layout.value === 'list' ? 1 : 2;
  // The reference lays the rows out two across and never narrower than that.
  const cap = layout.value === 'list' ? 2 : 99;
  const c = Math.min(cap, Math.max(floor, Math.floor((w + gap) / (min + gap))));
  cols.value = c;
  cardW.value = Math.floor((w - (c - 1) * gap) / c);
}
let ro: ResizeObserver | null = null;
const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${cols.value}, ${layout.value === 'list' ? 'minmax(0, 1fr)' : cardW.value + 'px'})`,
}));
// The rail can be mid-transition when the kind changes, so re-measure once the new layout is on screen.
watch([layout, variant], async () => {
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

watch(
  () => route.fullPath,
  () => {
    if (route.name !== 'browse') return;
    if (kind.value === 'search') term.value = String(route.query.q || '');
    filters.value = fromQuery(route.query, defaultSort(isSearch.value));
    // Picking a sort on a search only re-orders the window we hold; the query is unchanged.
    if (JSON.stringify(params(0)) === lastKey) return;
    void load(true);
  },
);

/** Closing the player moves rows that no write-back can reach: 在看 re-orders by when a title was last
 *  opened (and gains one that was never in it), 待看 loses the item that just finished. Both are the
 *  server's answer, not a copy of one, so they are re-asked — and only a finished item changes 待看,
 *  so a pause-and-close on a half-watched one asks for nothing. */
watch(
  () => store.lastStop,
  w => {
    if (!w) return;
    if (kind.value === 'resume' || (kind.value === 'unwatched' && w.played)) void sync();
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
  void store.loadGenres();
  await nextTick();
  fit();
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
  <div class="page">
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
      :is-search="isSearch"
      @change="onFilters"
    />

    <div ref="wrapEl" class="body">
      <p v-if="error" class="err">{{ error }} <button @click="load(true)">重试</button></p>

      <div v-if="loading" class="grid sk" :class="{ list: layout === 'list' }" :style="gridStyle">
        <template v-if="layout === 'list'">
          <div v-for="n in 8" :key="n" class="cell list">
            <span class="th"></span>
            <span class="bd">
              <i class="k1"></i><i class="k2"></i><i class="o"></i><i class="o"></i><i class="o"></i>
              <span class="gs"><i></i><i></i></span>
            </span>
          </div>
        </template>
        <template v-else>
          <div v-for="n in 18" :key="n" class="cell" :class="{ wide: variant === 'still' }" :style="{ width: cardW + 'px' }"><span></span></div>
        </template>
      </div>

      <div v-else-if="shown.length" class="grid in" :class="{ list: layout === 'list' }" :style="gridStyle">
        <template v-if="layout === 'list'">
          <ListCard v-for="(it, i) in shown" :key="`${it.id}-${i}`" :item="it" :index="i % 12" :matched-genres="filters.genres" />
        </template>
        <template v-else>
          <MediaCard
            v-for="(it, i) in shown"
            :key="`${it.id}-${i}`"
            :item="it"
            :variant="variant"
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
        <RowScroller v-for="r in shelves" :key="r.key" :title="r.title" :items="r.items" @play="onPlay" />
      </div>

      <p v-else-if="kind === 'search'" class="empty">
        {{ isFiltered(filters) ? '这个筛选条件下没有内容。' : term.trim() ? '没有匹配的结果。' : '输入片名开始搜索。' }}
      </p>
      <p v-else-if="isFiltered(filters)" class="empty">这个筛选条件下没有内容。</p>
      <p v-else class="empty">
        {{ kind === 'favorites' ? '还没有收藏的内容。' : '这个列表目前是空的。' }}
      </p>

      <button v-if="hasMore && !busy && !loading" class="more" @click="load(false)">加载更多</button>
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
.cell.wide {
  aspect-ratio: 16 / 9;
  border-radius: var(--radius);
}
.cell.list {
  aspect-ratio: auto;
  height: 186px;
  border-radius: var(--r-tile);
  /* The row drawn from the inside rather than as one slab. What a real 待看 row is while it fills in: a
     panel holding a 92-wide thumb (the only part of it that shimmers, because that is the only part of it
     that has an image to wait for) and four text rows — the title, the meta line, the synopsis, the badge
     row. Measured off the real card: head 23, +5 meta 20, +9 and 20.8 a line for three, +11 badges 26 =
     156.4 against this tile's own 156 of content.
     The height keeps the tall shape because 待看 puts two rows on a grid line and the line takes the taller
     of the pair (26 of 48 rows measure 168, 22 measure 184-186, so the pitch the grid really answers for is
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
</style>
