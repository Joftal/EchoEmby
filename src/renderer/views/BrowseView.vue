<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { LibraryItem } from '../../shared/types';
import MediaCard from '../components/home/MediaCard.vue';
import ListCard from '../components/home/ListCard.vue';
import { useAppStore } from '../stores/app';
import { usePlayerStore } from '../stores/player';

const store = useAppStore();
const player = usePlayerStore();
const route = useRoute();
const router = useRouter();

const PAGE = 48;
type Kind = 'resume' | 'unwatched' | 'favorites' | 'search' | 'view';
type Sort = 'name' | 'latest' | 'rating';

const SORTS: Record<Sort, Record<string, string>> = {
  name: { SortBy: 'SortName', SortOrder: 'Ascending' },
  latest: { SortBy: 'DateCreated', SortOrder: 'Descending' },
  rating: { SortBy: 'CommunityRating', SortOrder: 'Descending' },
};

const kind = computed<Kind>(() => {
  const k = String(route.query.kind || '');
  if (k === 'resume' || k === 'unwatched' || k === 'favorites' || k === 'search') return k;
  return 'view';
});
const viewId = computed(() => String(route.query.view || ''));
/** Alphabetical order puts this server's artless leftover episodes first, so 待看 leads with 最新. */
const sort = ref<Sort>('latest');
const term = ref(String(route.query.q || ''));

const titles: Record<Exclude<Kind, 'view'>, string> = {
  resume: '在看',
  unwatched: '待看',
  favorites: '收藏',
  search: '搜索',
};
const title = computed(() => (kind.value === 'view' ? decodeURIComponent(String(route.query.name || '')) || '资源库' : titles[kind.value]));
const sortable = computed(() => kind.value === 'view' || kind.value === 'unwatched' || kind.value === 'favorites');
const variant = computed(() => (kind.value === 'resume' ? 'still' : 'poster'));
/** Lists the reference shows as wide rows: the two watch-lists and search. */
const layout = computed<'list' | 'grid'>(() => (kind.value === 'resume' || kind.value === 'view' ? 'grid' : 'list'));

function params(startIndex: number): Record<string, string | number | boolean> {
  const s = sortable.value ? SORTS[sort.value] : {};
  const page = { StartIndex: startIndex, Limit: PAGE };
  if (kind.value === 'resume') return { Recursive: true, MediaTypes: 'Video', IsResumable: true, SortBy: 'DatePlayed', SortOrder: 'Descending', ...page };
  if (kind.value === 'unwatched') return { Recursive: true, MediaTypes: 'Video', Filters: 'IsUnplayed', ...s, ...page };
  if (kind.value === 'favorites') return { Recursive: true, Filters: 'IsFavorite', ...s, ...page };
  if (kind.value === 'search') return { Recursive: true, SearchTerm: term.value.trim(), ...page };
  return { ParentId: viewId.value, IncludeItemTypes: 'Movie|Series|BoxSet|Playlist|Video', Recursive: true, ...s, ...page };
}

const items = ref<LibraryItem[]>([]);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const hasMore = ref(false);

async function load(reset: boolean): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  if (reset) {
    loading.value = true;
    items.value = [];
    error.value = '';
  }
  const from = reset ? 0 : items.value.length;
  const r = await window.echoemby.emby.items(params(from));
  busy.value = false;
  loading.value = false;
  if (!r.ok) {
    error.value = r.error || '加载失败';
    return;
  }
  const batch = r.data || [];
  items.value = reset ? batch : [...items.value, ...batch];
  hasMore.value = batch.length === PAGE;
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
    const cur = router.currentRoute.value.query;
    if ((cur.q || '') !== q) void router.replace({ path: '/browse', query: { kind: 'search', ...(q ? { q } : {}) } });
    void load(true);
  }, 420);
});

watch(
  () => [route.fullPath, sort.value],
  () => {
    if (route.name !== 'browse') return;
    if (kind.value === 'search') term.value = String(route.query.q || '');
    void load(true);
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
  if (item.type === 'Series' || item.type === 'CollectionFolder' || item.type === 'BoxSet' || item.type === 'Playlist') {
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
        <div v-if="sortable" class="seg">
          <button v-for="s in (['name', 'latest', 'rating'] as const)" :key="s" :class="{ on: sort === s }" @click="sort = s">
            {{ s === 'name' ? '名称' : s === 'latest' ? '最新' : '评分' }}
          </button>
        </div>
      </div>
    </header>

    <div ref="wrapEl" class="body">
      <p v-if="error" class="err">{{ error }} <button @click="load(true)">重试</button></p>

      <div v-if="loading" class="grid sk" :class="{ list: layout === 'list' }" :style="gridStyle">
        <template v-if="layout === 'list'">
          <div v-for="n in 8" :key="n" class="cell list"><span></span></div>
        </template>
        <template v-else>
          <div v-for="n in 18" :key="n" class="cell" :class="{ wide: variant === 'still' }" :style="{ width: cardW + 'px' }"><span></span></div>
        </template>
      </div>

      <div v-else-if="items.length" class="grid in" :class="{ list: layout === 'list' }" :style="gridStyle">
        <template v-if="layout === 'list'">
          <ListCard v-for="(it, i) in items" :key="`${it.id}-${i}`" :item="it" :index="i % 12" />
        </template>
        <template v-else>
          <MediaCard
            v-for="(it, i) in items"
            :key="`${it.id}-${i}`"
            :item="it"
            :variant="variant"
            :width="cardW"
            :index="i % 12"
            @play="onPlay"
          />
        </template>
      </div>

      <p v-else-if="kind === 'search'" class="empty">{{ term.trim() ? '没有匹配的结果。' : '输入片名开始搜索。' }}</p>
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
.seg {
  display: inline-flex;
  gap: 2px;
  padding: 4px;
  border-radius: 999px;
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
}
.seg button {
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 13px;
  color: var(--text-dim);
  transition: color var(--hov) var(--ease), background var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.seg button:hover {
  color: var(--text);
}
.seg button.on {
  color: var(--text);
  font-weight: 600;
  background: var(--chip-hi);
}
.seg button:active {
  transform: scale(0.96);
  transition-duration: 0.1s;
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
}
.cell span {
  display: block;
  width: 100%;
  height: 100%;
  background: linear-gradient(100deg, #eeeef2 30%, #f7f7fa 50%, #eeeef2 70%);
  background-size: 220% 100%;
  animation: sh 1.4s linear infinite;
}
.sk .cell:nth-child(n + 13) {
  opacity: 0.5;
}
@keyframes sh {
  to {
    background-position: -220% 0;
  }
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
  transition: background var(--hov) var(--ease), color var(--hov) var(--ease), transform var(--hov) var(--ease-out), box-shadow var(--hov) var(--ease);
}
.more:hover {
  background: var(--ink);
  color: var(--on-ink);
  box-shadow: var(--shadow);
  transform: translate3d(0, -2px, 0);
}
.toast {
  position: fixed;
  left: 50%;
  bottom: 26px;
  z-index: var(--z-toast);
  transform: translateX(-50%);
  padding: 9px 18px;
  border-radius: 999px;
  font-size: 13px;
  color: var(--text);
  background: rgba(255, 255, 255, 0.86);
  border: 1px solid var(--line);
  backdrop-filter: blur(14px) saturate(180%);
  box-shadow: var(--shadow);
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.28s var(--ease), transform 0.34s var(--ease-out);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate3d(-50%, 14px, 0);
}
</style>
