<script setup lang="ts">
import { computed } from 'vue';
import type { FacetOption } from '../../../shared/types';
import { emptyFilters, isFiltered, LANG_OPTIONS, SORT_OPTIONS, yearOptions, type Filters, type Option, type SortKey } from '../../lib/filters';
import { genreFacet } from '../../lib/genres';
import { studioLabel, studioRenamed } from '../../../shared/studio-names';
import FilterSelect from './FilterSelect.vue';

const props = defineProps<{
  filters: Filters;
  /** The library's own genre labels, from the /Genres facet. */
  genreOptions: FacetOption[];
  /** The library's whole company list, from the /Studios facet — the same kind of answer as the genres
   *  above, so 公司 means the same thing on an empty search page as inside a library. */
  studioOptions: FacetOption[];
  /** The facet is still on its way (it is one 1.9 MB answer). 公司 keeps its place in the bar meanwhile,
   *  rather than appearing a second late and pushing 语言 along. */
  studiosLoading: boolean;
  isSearch: boolean;
  /** The types this page can actually answer with. A film library holds no Series, so 剧集 there is a
   *  control whose only outcome is an empty page; the same goes for 电影 inside a television library. */
  typeOptions: Option[];
}>();
const emit = defineEmits<{ (e: 'change', next: Filters): void }>();

const years = yearOptions().map(y => ({ value: y, label: `${y} 年` }));
const langs = computed(() => LANG_OPTIONS);
const types = computed(() => props.typeOptions);
const sorts = computed(() => SORT_OPTIONS.filter(o => props.isSearch || !o.searchOnly));
/** One row per name the filter should print. The server credits the same service under more than one
 *  spelling (iQIYI and iQiyi, 腾讯视频 and Tencent Video), so rows that print the same name are merged and
 *  all their ids ride along: picking 爱奇艺 has to mean 爱奇艺, not whichever row happened to be first. */
const studios = computed(() => {
  const groups = new Map<string, { ids: string[]; hint: string[] }>();
  for (const s of props.studioOptions) {
    if (!s.id) continue;
    const label = studioLabel(s.name);
    const g = groups.get(label) || { ids: [], hint: [] };
    g.ids.push(s.id);
    if (studioRenamed(s.name)) g.hint.push(s.name);
    groups.set(label, g);
  }
  // Sorted, because the facet arrives in the library's own id order, which reads as no order at all once
  //  the list is 8185 rows long; the panel is searchable, so the sort is mainly what makes scrolling sane.
  //  Leading punctuation is skipped when comparing, or the first screen of an alphabetical list is nothing
  //  but 「(not) HEROINE movies」and 「. 北京国立常升」.
  const key = (s: string): string => s.replace(/^[^0-9A-Za-z\u3400-\u9fff]+/, '');
  // Chinese names first, then Latin, then everything else: this library is mostly Chinese after the company
  //  renaming, and collation alone put Arabic and Korean studios above 爱奇艺 on the first screen.
  const rank = (s: string): number => (/^[\u3400-\u9fff]/.test(s) ? 0 : /^[0-9A-Za-z]/.test(s) ? 1 : 2);
  return [...groups.entries()]
    .map(([label, g]) => ({ value: `${g.ids.join(',')}|${label}`, label, hint: g.hint.join(' ') || undefined }))
    .sort((a, b) => rank(key(a.label)) - rank(key(b.label)) || key(a.label).localeCompare(key(b.label), 'zh'));
});
const genres = computed(() => genreFacet(props.genreOptions.map(g => g.name)));

function patch(part: Partial<Filters>): void {
  emit('change', { ...props.filters, ...part });
}

/** The single-choice controls answer with a string, the multi ones with a list. */
function setType(v: string | string[]): void {
  patch({ type: typeof v === 'string' ? v : '' });
}
function setSort(v: string | string[]): void {
  patch({ sort: (typeof v === 'string' ? v : '') as SortKey });
}
function setStudio(v: string | string[]): void {
  const raw = typeof v === 'string' ? v : '';
  const cut = raw.indexOf('|');
  patch({ studio: cut > 0 ? { ids: raw.slice(0, cut).split(',').filter(Boolean), name: raw.slice(cut + 1) } : null });
}
</script>

<template>
  <div class="bar">
    <!-- One row, not two: the types are the shortest list in the bar and a wrapped panel read as a
         matrix of slots with one dangling — the panel is as wide as its cells say it is. The row is four
         wide because 不限 now sits beside the three types. -->
    <FilterSelect label="类型" :options="types" :model-value="filters.type" :cell="56" :cols="4" @update:model-value="setType" />
    <FilterSelect
      label="分类"
      :options="genres"
      :model-value="filters.genres"
      multi
      searchable
      @update:model-value="patch({ genres: Array.isArray($event) ? $event : [] })"
    />
    <FilterSelect
      label="年份"
      :options="years"
      :model-value="filters.years"
      multi
      searchable
      :cell="76"
      @update:model-value="patch({ years: Array.isArray($event) ? $event : [] })"
    />
    <FilterSelect
      label="排序"
      :options="sorts"
      :model-value="filters.sort"
      neutral
      :cell="76"
      :cols="3"
      @update:model-value="setSort"
    />
    <FilterSelect
      v-if="studioOptions.length || studiosLoading"
      label="公司"
      :chunk="120"
      :busy="!studioOptions.length"
      :options="studios"
      :model-value="filters.studio?.ids.length ? `${filters.studio.ids.join(',')}|${filters.studio.name}` : ''"
      searchable
      @update:model-value="setStudio"
    />
    <FilterSelect
      label="语言"
      :options="langs"
      :model-value="filters.langs"
      multi
      :cell="76"
      @update:model-value="patch({ langs: Array.isArray($event) ? $event : [] })"
    />

    <button v-if="isFiltered(filters)" class="clear" type="button" @click="emit('change', emptyFilters(filters.sort))">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
        <path d="M6 6 18 18 M18 6 6 18" />
      </svg>
      清空筛选
    </button>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.clear {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 34px;
  padding: 0 12px;
  border-radius: var(--radius);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-dim);
  transition: color var(--hov) var(--ease), background var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.clear:hover {
  color: var(--text);
  background: var(--chip);
}
.clear:active {
  transform: scale(0.96);
  transition-duration: 0.1s;
}
</style>
