/** Emby keeps a genre as free text on each item and `/Genres` only echoes the distinct strings it found, so a
 *  library scraped from more than one source holds 动作, Action and アニメーション for the same thing. Measured on
 *  the gateway: 50 facet labels — 23 中文, 25 English, 2 Japanese — and 动作 alone leaves 33 titles hiding behind
 *  the Action spelling. Everything the user reads is folded onto one Chinese label; the query is then expanded
 *  back to the whole family, which costs nothing: `动作|Action` answers with the exact union (2336 = 2303 + 33,
 *  no overlap). A server label this table does not know rides through untouched. */
const ALIAS: Record<string, string> = {
  Action: '动作',
  'Action & Adventure': '动作冒险',
  Adventure: '冒险',
  Anime: '动画',
  Animation: '动画',
  Children: '儿童',
  Comedy: '喜剧',
  Crime: '犯罪',
  Documentary: '纪录',
  ドラマ: '剧情',
  Drama: '剧情',
  Family: '家庭',
  Fantasy: '奇幻',
  History: '历史',
  Horror: '恐怖',
  'Martial Arts': '武术',
  Mystery: '悬疑',
  Reality: '真人秀',
  Romance: '爱情',
  'Sci-Fi & Fantasy': '科幻奇幻',
  'Sci-Fi': '科幻',
  'Science Fiction': '科幻',
  Sport: '体育',
  Thriller: '惊悚',
  War: '战争',
  'War & Politics': '战争与政治',
  アニメーション: '动画',
};

/** The Chinese label a server spelling folds into. */
export const genreLabel = (name: string): string => ALIAS[name] ?? name;

/** The other spellings of each Chinese label, read off the table above. */
const FAMILY: Record<string, string[]> = Object.entries(ALIAS).reduce((acc, [raw, cn]) => {
  (acc[cn] ||= []).push(raw);
  return acc;
}, {} as Record<string, string[]>);

/** Mapped and deduplicated: one item can carry both spellings of the same genre. `prefer` (the Chinese labels
 *  a page is currently filtered by) is pulled to the front so a card answering a 分类 filter always names the
 *  genre it was matched on, even where the server's own array put it fifth of six. Every surface that prints a
 *  genre line now goes through `mergeGenres`, so this is that function's fold rather than an entry point. */
const genreLabels = (names?: string[], prefer: string[] = []): string[] => {
  const folded = [...new Set((names || []).map(genreLabel))];
  if (!prefer.length) return folded;
  const top = prefer.filter(p => folded.includes(p));
  return [...top, ...folded.filter(g => !top.includes(g))];
};

/** One card's genre line, out of both sources. TMDB's order leads because that list is about the work; the
 *  server's own labels follow it rather than being replaced by it. Measured on the 242 rows both sides tag:
 *  40 reword, none lose a slot, 12 gain one — but a card only prints three, so on 12 rows a label the server
 *  billed is pushed past that cap by a TMDB one (宝石之国 loses 悬疑 to 动作冒险). Two costs come with the merge
 *  and are the reason it is capped: a plain flip instead would empty a slot outright on 6 rows, and a label
 *  TMDB alone names cannot be found by the 分类 filter, which is asked server-side (20 of 373 printed rows).
 *  `prefer` keeps its meaning from `genreLabels`: the labels a browse filter matched stay in front, so a card
 *  answering a 筛选 never leads with something else. */
export const mergeGenres = (tmdb: string[] | undefined, server: string[] | undefined, prefer: string[] = [], cap?: number): string[] => {
  const merged = genreLabels([...(tmdb || []), ...(server || [])], prefer);
  return cap ? merged.slice(0, cap) : merged;
};

/** The dropdown: one row per label, all of them Chinese, in the server's own order. */
export function genreFacet(names: string[]): { value: string; label: string }[] {
  const seen = new Set<string>();
  const out: { value: string; label: string }[] = [];
  for (const name of names) {
    const label = genreLabel(name);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ value: label, label });
  }
  return out;
}

/** One param for a whole family of spellings, joined on the `|` this server ORs on. The filter's own value
 *  stays the Chinese label — it is what the pill shows and what rides in the URL. */
export const genreQuery = (labels: string[]): string =>
  [...new Set(labels.flatMap(l => [l, ...(FAMILY[l] || [])]))].join('|');
