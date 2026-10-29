import type { LibraryItem } from '../../shared/types';
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
  /** One company as the filter shows it: the ids the server answers for, and the name to print. Usually
   *  one id; several when two rows are the same service spelled twice (iQIYI and iQiyi), because
   *  `StudioIds` does read a comma list as an OR — measured: 32 + 21 titles asked together, 53 back. */
  studio: { ids: string[]; name: string } | null;
  langs: string[];
  sort: SortKey;
}

export interface Option {
  value: string;
  label: string;
}

/** The types this library actually holds. Episodes and Seasons ride along with their Series.
 *  合集 is the third: a `BoxSet` row is a real thing to search for and, since its page lists what it holds,
 *  a real place to land (measured: 2 on the gateway, 1 on nyamedia, and the filter answers with exactly
 *  those — `IncludeItemTypes=BoxSet` is honoured where `Playlist` is not, because the playlists on that
 *  server belong to other accounts and the app asks the user-scoped endpoint). */
export const TYPE_OPTIONS: Option[] = [
  { value: 'Movie', label: '电影' },
  { value: 'Series', label: '剧集' },
  { value: 'BoxSet', label: '合集' },
];

/** Emby stores audio languages as three-letter codes; the server accepts a comma list of them. The codes are
 *  what goes into the query, the words are `langName`'s — the same table the 技术信息 card and the player's
 *  track menu read, so the language a viewer ticks here is spelled the same way inside the title they open.
 *  The list is what the gateways actually tag, measured over both libraries with a 27-code sweep: 3,542 files
 *  in `eng`, 2,544 `chi`, 537 `jpn`, 245 `kor`, 184 `fre`, 185 `hin` — and the thirteen this filter used
 *  to offer left 粤语 (19 files), 阿拉伯语 (10), 瑞典语 (19), 荷兰语 (11), 波兰语 (34), 丹麦语 (14), 芬兰语 (4),
 *  挪威语 (9), 土耳其语 (18), 希伯来语 (1), 捷克语 (6), 匈牙利语 (8) and 乌克兰语 (4) unreachable. Ordered
 *  by how much the library holds, because the picker is a scroll and the first rows are the ones reached. */
export const LANG_OPTIONS: Option[] = [
  'chi', 'eng', 'jpn', 'kor', 'fre', 'hin', 'spa', 'ger', 'ita', 'por', 'rus', 'pol', 'tha', 'swe', 'yue',
  'tur', 'dan', 'dut', 'ara', 'nor', 'hun', 'cze', 'fin', 'ukr', 'vie', 'gre', 'heb',
].map(value => ({ value, label: langName(value) }));

/** A file the scraper never tagged. Measured on 600 films of 华语电影: 146 carry `und` and 65 carry no
 *  language at all — 211 films that every other row of this picker was unable to reach, because no code you
 *  could tick is equal to either. `AudioLanguages=und` does answer (439 films there), so the row asks a
 *  question the server can answer; the 65 with no code stay out of reach, and the label says so. */
LANG_OPTIONS.push({ value: 'und', label: '未定' });

/** The same language under its other ISO-639-2 spelling, which one library carries both of: a scraper writes
 *  whichever table it read, so 184 files are tagged `fre` beside 5 tagged `fra`, 62 `ger` beside 3 `deu`,
 *  6 `cze` beside 1 `ces`. Filtering on one spelling hides the other, and the picker can only show one row
 *  per language — so the chosen code is expanded to both at query time. This is also the reason the filter
 *  used to list `fra`: 184 部法语片 were simply not findable through it. */
const LANG_ALT: Record<string, string[]> = {
  chi: ['zho'], fre: ['fra'], ger: ['deu'], dut: ['nld'], cze: ['ces'], gre: ['ell'], per: ['fas'],
  may: ['msa'], nor: ['nob'], rum: ['ron'], slo: ['slv'], ice: ['isl'], baq: ['eus'], wel: ['cym'],
  alb: ['sqi'], arm: ['hye'], geo: ['kat'], bur: ['mya'], mac: ['mkd'],
};

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
    // 搜索 only. A library window is sorted by the server, and the only score it can sort on is
    // CommunityRating — which this gateway leaves on a placeholder 10 for a batch of titles, so the
    // order it answers cannot be checked against the ★ the cards print. Re-sorting the window here
    // instead would sort one page at a time and interleave them on 加载更多, which reads worse than
    // no option at all; 搜索 holds every row it will ever show, so it can sort them by the badge.
    searchOnly: true,
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

/** Years the library could plausibly hold, newest first. A year with no titles simply filters to empty.
 *  The floor is 1900, not 1970: measured on the main gateway, the oldest 电影 is 寻子遇仙记 (1921) and the
 *  oldest 剧集 is 星际迷航：原初 (1966), so a 1970 floor put both of them, and every silent film beside them,
 *  out of reach of the only control that can name a year. */
export const yearOptions = (): string[] => {
  const now = new Date().getFullYear();
  return Array.from({ length: now - 1899 }, (_, i) => String(now - i));
};

/** Everything except the sort: the separators differ per param and were measured on the gateway —
 *  Genres ORs on `|` (a comma asked for both at once and answered with nothing), the rest on `,`,
 *  and IncludeItemTypes is the one that must be a comma or the server ignores it entirely. */
export function filterParams(f: Filters): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.type) p.IncludeItemTypes = f.type;
  if (f.genres.length) p.Genres = genreQuery(f.genres);
  if (f.years.length) p.Years = [...f.years].sort().join(',');
  if (f.studio?.ids.length) p.StudioIds = f.studio.ids.join(',');
  if (f.langs.length) p.AudioLanguages = [...new Set(f.langs.flatMap(l => [l, ...(LANG_ALT[l] || [])]))].join(',');
  return p;
}

export function sortParams(f: Filters): Record<string, string> {
  const s = SORT_OPTIONS.find(x => x.value === f.sort)?.server;
  return s ? { SortBy: s.SortBy, SortOrder: s.SortOrder } : {};
}

/** Reorders the page we already hold. The default order is untouched, which is what 相关度 promises.
 *  `vote` is the number the card's badge prints (TMDB's average); 评分优先 prefers it over the server's
 *  CommunityRating, which this gateway leaves on a placeholder 10 for a batch of titles — an order the
 *  reader cannot check against the stars on screen. A row with neither falls to the bottom. */
export function localSort(items: LibraryItem[], key: SortKey, vote?: (it: LibraryItem) => number | null): LibraryItem[] {
  if (key === 'rating' && vote) {
    const score = (it: LibraryItem): number => vote(it) ?? it.communityRating ?? -1;
    return [...items].sort((a, b) => score(b) - score(a));
  }
  const cmp = SORT_OPTIONS.find(x => x.value === key)?.local;
  return cmp ? [...items].sort(cmp) : items;
}

/** Filters ride in the URL so a result page can be shared, reloaded, or gone back to. */
export function toQuery(f: Filters): Record<string, string> {
  const q: Record<string, string> = {};
  if (f.type) q.type = f.type;
  if (f.genres.length) q.genres = f.genres.join('|');
  if (f.years.length) q.years = f.years.join(',');
  if (f.studio?.ids.length) q.studio = `${f.studio.ids.join(',')}|${f.studio.name}`;
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
    studio: cut > 0 ? { ids: raw.slice(0, cut).split(',').filter(Boolean), name: raw.slice(cut + 1) } : null,
    langs: csv(q.langs),
    sort: SORT_OPTIONS.some(x => x.value === want) ? want : sort,
  };
}
