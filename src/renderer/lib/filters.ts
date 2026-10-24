import type { LibraryItem, StudioRef } from '../../shared/types';
import { langName } from './format';
import { genreLabel, genreQuery } from './genres';

/** Which sort is active. `relevance` means "leave the server's own order alone", which is the only
 *  sensible answer for a search: this server ignores SortBy the moment a SearchTerm is present. */
export type SortKey = 'relevance' | 'latest' | 'rating' | 'premiere' | 'name';

export interface Filters {
  /** '' = 全部; otherwise an Emby type, Movie or Series. */
  type: string;
  /** Chinese genre labels, folded by lib/genres; the query re-expands them to every spelling. */
  genres: string[];
  /** Four-digit years, in the order the user ticked them. */
  years: string[];
  /** One production company. Single because the server's OR separator for this param is the one
   *  thing the gateway never answered for: both `a|b` and `a,b` came back empty on its busiest id. */
  studio: StudioRef | null;
  langs: string[];
  sort: SortKey;
}

export interface Option {
  value: string;
  label: string;
}

/** The two types this library actually holds. Episodes and Seasons ride along with their Series. */
export const TYPE_OPTIONS: Option[] = [
  { value: 'Movie', label: '电影' },
  { value: 'Series', label: '剧集' },
];

/** Emby stores audio languages as three-letter codes; the server accepts a comma list of them. The codes are
 *  what goes into the query, the words are `langName`'s — the same table the 技术信息 card and the player's
 *  track menu read, so the language a viewer ticks here is spelled the same way inside the title they open. */
export const LANG_OPTIONS: Option[] = ['chi', 'eng', 'jpn', 'kor', 'fra', 'ger', 'spa', 'ita', 'rus', 'por', 'tha', 'vie', 'hin'].map(
  value => ({ value, label: langName(value) }),
);

export interface SortOption extends Option {
  value: SortKey;
  /** SortBy/SortOrder for the queries that honour them. Absent means local-only. */
  server?: { SortBy: string; SortOrder: string };
  /** Only a search has a relevance order to fall back on. */
  searchOnly?: boolean;
  /** How to order the window we already fetched, when the server cannot be asked. */
  local?: (a: LibraryItem, b: LibraryItem) => number;
}

const str = (x?: string): string => x || '';

export const SORT_OPTIONS: SortOption[] = [
  { value: 'relevance', label: '相关度', searchOnly: true },
  {
    value: 'latest',
    label: '最近加入',
    server: { SortBy: 'DateCreated', SortOrder: 'Descending' },
    local: (a, b) => str(b.dateCreated).localeCompare(str(a.dateCreated)),
  },
  {
    value: 'rating',
    label: '评分优先',
    server: { SortBy: 'CommunityRating', SortOrder: 'Descending' },
    local: (a, b) => (b.communityRating ?? -1) - (a.communityRating ?? -1),
  },
  {
    value: 'premiere',
    label: '按上映',
    server: { SortBy: 'PremiereDate', SortOrder: 'Descending' },
    local: (a, b) => str(b.premiereDate).localeCompare(str(a.premiereDate)),
  },
  {
    value: 'name',
    label: '名称',
    server: { SortBy: 'SortName', SortOrder: 'Ascending' },
    local: (a, b) => a.name.localeCompare(b.name, 'zh'),
  },
];

/** A browse page has no relevance to fall back on, so its first option is 最近加入. */
export const defaultSort = (isSearch: boolean): SortKey => (isSearch ? 'relevance' : 'latest');

export const emptyFilters = (sort: SortKey): Filters => ({ type: '', genres: [], years: [], studio: null, langs: [], sort });

export const isFiltered = (f: Filters): boolean =>
  !!f.type || !!f.genres.length || !!f.years.length || !!f.studio || !!f.langs.length;

/** Years the library could plausibly hold, newest first. A year with no titles simply filters to empty. */
export const yearOptions = (): string[] => {
  const now = new Date().getFullYear();
  return Array.from({ length: now - 1969 }, (_, i) => String(now - i));
};

/** Everything except the sort: the separators differ per param and were measured on the gateway —
 *  Genres ORs on `|` (a comma asked for both at once and answered with nothing), the rest on `,`,
 *  and IncludeItemTypes is the one that must be a comma or the server ignores it entirely. */
export function filterParams(f: Filters): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.type) p.IncludeItemTypes = f.type;
  if (f.genres.length) p.Genres = genreQuery(f.genres);
  if (f.years.length) p.Years = [...f.years].sort().join(',');
  if (f.studio?.id) p.StudioIds = f.studio.id;
  if (f.langs.length) p.AudioLanguages = f.langs.join(',');
  return p;
}

export function sortParams(f: Filters): Record<string, string> {
  const s = SORT_OPTIONS.find(x => x.value === f.sort)?.server;
  return s ? { SortBy: s.SortBy, SortOrder: s.SortOrder } : {};
}

/** Reorders the page we already hold. The default order is untouched, which is what 相关度 promises. */
export function localSort(items: LibraryItem[], key: SortKey): LibraryItem[] {
  const cmp = SORT_OPTIONS.find(x => x.value === key)?.local;
  return cmp ? [...items].sort(cmp) : items;
}

/** Filters ride in the URL so a result page can be shared, reloaded, or gone back to. */
export function toQuery(f: Filters): Record<string, string> {
  const q: Record<string, string> = {};
  if (f.type) q.type = f.type;
  if (f.genres.length) q.genres = f.genres.join('|');
  if (f.years.length) q.years = f.years.join(',');
  if (f.studio?.id) q.studio = `${f.studio.id}|${f.studio.name}`;
  if (f.langs.length) q.langs = f.langs.join(',');
  q.sort = f.sort;
  return q;
}

export function fromQuery(q: Record<string, unknown>, sort: SortKey): Filters {
  const list = (v: unknown): string[] => (typeof v === 'string' && v ? v.split('|').filter(Boolean) : []);
  const csv = (v: unknown): string[] => (typeof v === 'string' && v ? v.split(',').filter(Boolean) : []);
  const raw = typeof q.studio === 'string' ? q.studio : '';
  const cut = raw.indexOf('|');
  const want = typeof q.sort === 'string' ? (q.sort as SortKey) : sort;
  return {
    type: typeof q.type === 'string' ? q.type : '',
    genres: list(q.genres).map(genreLabel),
    years: csv(q.years),
    studio: cut > 0 ? { id: raw.slice(0, cut), name: raw.slice(cut + 1) } : null,
    langs: csv(q.langs),
    sort: SORT_OPTIONS.some(x => x.value === want) ? want : sort,
  };
}
