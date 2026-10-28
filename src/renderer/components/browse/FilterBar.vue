<script setup lang="ts">
import { computed } from 'vue';
import type { FacetOption, StudioRef } from '../../../shared/types';
import { emptyFilters, isFiltered, LANG_OPTIONS, SORT_OPTIONS, TYPE_OPTIONS, yearOptions, type Filters, type SortKey } from '../../lib/filters';
import { genreFacet } from '../../lib/genres';
import FilterSelect from './FilterSelect.vue';

const props = defineProps<{
  filters: Filters;
  /** The library's own genre labels, from the /Genres facet. */
  genreOptions: FacetOption[];
  /** Companies seen on the results already loaded: the only ids this server will filter by. */
  studioOptions: StudioRef[];
  isSearch: boolean;
}>();
const emit = defineEmits<{ (e: 'change', next: Filters): void }>();

const years = yearOptions().map(y => ({ value: y, label: `${y} 年` }));
const langs = computed(() => LANG_OPTIONS);
const types = computed(() => TYPE_OPTIONS);
const sorts = computed(() => SORT_OPTIONS.filter(o => props.isSearch || !o.searchOnly));
const studios = computed(() => props.studioOptions.filter(s => s.id).map(s => ({ value: `${s.id}|${s.name}`, label: s.name })));
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
  patch({ studio: cut > 0 ? { id: raw.slice(0, cut), name: raw.slice(cut + 1) } : null });
}
</script>

<template>
  <div class="bar">
    <!-- One row, not two: the three types are the shortest list in the bar and a wrapped panel read as a
         matrix of four slots with one dangling — the panel is as wide as its cells say it is. -->
    <FilterSelect label="类型" :options="types" :model-value="filters.type" :cell="56" :cols="3" @update:model-value="setType" />
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
      v-if="studios.length"
      label="公司"
      :options="studios"
      :model-value="filters.studio?.id ? `${filters.studio.id}|${filters.studio.name}` : ''"
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
