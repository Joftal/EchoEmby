import { net } from 'electron';
import type { BangumiScore } from '../../shared/types';
import { sourceCache } from './cache';

/**
 * Bangumi is the score source that actually covers this library's anime and C-drama half — IMDb, RT
 * and Trakt all thin out on Asian titles. Two of its doors are broken for our purposes: the v0 search
 * API matches only the original Japanese/Latin name (a Chinese title returns nothing at all), and its
 * subject records are keyed by an id we do not have. The legacy `search/subject/{name}` route does
 * take a Chinese name and, with `responseGroup=large`, hands back the rating in the same reply.
 *
 * What it gives us is a loose-match list ranked by relevance, so the match has to be made here: keep
 * only animation (2) and live-action (6) subjects, and accept a name that equals the title exactly or
 * extends it with a season marker — C-dramas are filed per season (庆余年 → 庆余年 第一季) while the
 * library carries one series entry.
 */

const API = 'https://api.bgm.tv';
/** bgm.tv rejects a request with no descriptive agent. */
const UA = 'EchoEmby/0.1 (desktop client; per-title metadata lookup)';

const cache = sourceCache<BangumiScore>('bangumi.json');

interface Hit {
  id: number;
  type: number;
  name?: string;
  name_cn?: string;
  rating?: { score?: number; total?: number };
}

/** Null means the transport never answered, which must not be cached as "Bangumi has no such title". */
const ask = async (title: string): Promise<Hit[] | null> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await net.fetch(`${API}/search/subject/${encodeURIComponent(title)}?responseGroup=large&max=30`, {
      headers: { 'User-Agent': UA },
      signal: ctrl.signal,
    });
    if (res.status >= 500) return null;
    const json = await res.json().catch(() => null);
    return Array.isArray((json as any)?.list) ? ((json as any).list as Hit[]) : [];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/** Spaces are the difference between 「庆余年 第一季」 and a title written without one. */
const flat = (s: string): string => s.replace(/\s+/g, '');

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** The season number in a 「第X季」 suffix, or NaN when the name is not a season of the title. */
const seasonNum = (name: string, want: string): number => {
  const rest = name.slice(want.length);
  const m = /^第([0-9]{1,2}|[一二三四五六七八九十])季/.exec(rest);
  if (!m) return NaN;
  return /^\d/.test(m[1]) ? Number(m[1]) : CN_NUM[m[1]];
};

/** The library's titles are Chinese; bgm's own records may carry the name in either column, and the
 *  Chinese one sometimes differs from the title we hold (舒克贝塔 is filed as 《新舒克贝塔》). */
const names = (h: Hit): string[] => [h.name_cn, h.name].filter((n): n is string => !!n).map(flat);

const picked = (list: Hit[], title: string): Hit | undefined => {
  const want = flat(title);
  const cands = list.filter(h => h.type === 2 || h.type === 6);
  const exact = cands.filter(h => names(h).includes(want));
  // A season-only subject stands in for the series when Bangumi has no series record (C-dramas are filed
  // per season). Take the earliest such season rather than whichever the search happened to rank first —
  // picking 第四季 for a whole series is what made this read as a wrong title on 吸血鬼日记.
  const seasons = cands
    .flatMap(h => names(h).map(n => ({ h, s: n.startsWith(want) ? seasonNum(n, want) : NaN })))
    .filter(x => Number.isFinite(x.s))
    .sort((a, b) => a.s - b.s);
  const withScore = (arr: { h: Hit; s: number }[]) => arr.find(x => (x.h.rating?.score ?? 0) > 0)?.h;
  return exact.find(h => (h.rating?.score ?? 0) > 0) || withScore(seasons);
};

export async function bangumiScore(title: string): Promise<BangumiScore | null> {
  // Every usable lookup here starts from a CJK name; a Latin one is better spent on the other sources.
  if (!/[㐀-鿿぀-ヿ가-힯]/.test(title)) return null;
  const hit = cache.read(title);
  if (hit.status === 'empty') return null;
  if (hit.status === 'fresh') return hit.value;
  const list = await ask(title);
  if (!list) return null;
  const found = picked(list, title);
  const score = found?.rating?.score;
  if (!found || !score) {
    cache.markEmpty(title);
    return null;
  }
  const out: BangumiScore = {
    score,
    subjectId: found.id,
    name: found.name_cn || found.name || title,
    fetchedAt: Date.now(),
  };
  cache.write(title, out);
  return out;
}
