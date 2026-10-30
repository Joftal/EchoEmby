import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as config from '../config';
import { clearFailure, commentPage, comments, lastFailure, matchFile, normalizeBase, probe, raw, searchAnime, searchEpisodes, type ApiAnime, type ApiCommentRow, type ApiSource } from './api';
import type {
  DanmakuAnime,
  DanmakuComment,
  DanmakuDebugReply,
  DanmakuEpisode,
  DanmakuLink,
  DanmakuLookup,
  DanmakuQuery,
  DanmakuSettings,
  DanmakuSource,
  DanmakuTestResult,
  DanmakuTrack,
  DanmakuTrackInfo,
} from '../../shared/types';

/**
 * 弹幕: one list of candidates, a cache on disk, and a list of endpoints to ask for them.
 *
 * Every request goes through `ask()`, which walks the endpoints 设置 holds top to bottom and keeps the first
 * answer. That is what makes a mirror the viewer added usable without switching the official one off: a row
 * that fails to answer costs one timeout, and the next row carries on. Nobody remembers which row answered
 * except `lookup()`, which reports it so the panel can print where the comments came from.
 *
 * The lookup is a small ladder, cheapest and most certain first:
 *   1. a manual link this show already has — the viewer's own answer outranks every guess;
 *   2. the TMDB id the library carries, which 弹弹play resolves without reading a title at all;
 *   3. the filename through `/match`, which is how the desktop client's 自动链接 works;
 *   4. the series title, with the episode number narrowing the answer.
 *
 * A recorded `missing` is what makes 「这部没有弹幕」 stick. A transport failure is the case that must NOT be
 * recorded, or a bad afternoon freezes into a permanent no — the same rule the metadata sources follow.
 */

const DAY = 86_400_000;
const HIT_TTL = 7 * DAY;
const MISS_TTL = DAY;
/** Bumped when the shape below changes: a file from an older build is dropped rather than half-read. */
const STORE_VERSION = 6;

/** The endpoints to ask, in the order 设置 lists them. A switched-off row stays in the file but is never
 *  asked, and an empty list cannot happen: config keeps at least the official row. */
/** Rows that can actually be asked: a row 添加接口 just made has no address yet, and is skipped here so a
 *  half-typed entry never delays a real one. */
const apiSources = (): DanmakuSource[] => config.get().settings.danmaku.sources.filter(s => s.enabled && normalizeBase(s.url) !== '');

/**
 * Ask every enabled endpoint in order, keep the first answer.
 *
 * `null` means every row stayed silent — a refusal, a timeout, a 5xx — which the caller must show as a
 * failure rather than as 「没有弹幕」. An empty array is a real answer and stops the walk: the second row is
 * not worth a request when the first one already said 「this show has none」.
 */
/** The whole walk, not each row, gets this long: with four endpoints a per-row ceiling would mean the drawer
 *  spinning for a minute before saying 「没有弹幕」. */
const LOOKUP_BUDGET_MS = 20_000;
/** One row's ceiling. This mirror took 15.4s, 17.3s and 19.1s on three consecutive questions about one film
 *  (measured 2026-10-30), so the old 12s ceiling read as 「no such work」 on works it had not answered yet. */
const ROW_TIMEOUT_MS = 16_000;

async function firstAnswer<T>(fn: (src: ApiSource) => Promise<T | null>): Promise<{ value: T; name: string } | null> {
  const list = apiSources();
  const started = Date.now();
  for (const row of list) {
    const left = LOOKUP_BUDGET_MS - (Date.now() - started);
    if (left < 1_000) break;
    // A row that hangs must not eat the budget the rest of the list needs: the first one may use its full
    // ceiling, later ones only what is left. A refusal still costs nothing, so the ordinary broken mirror is free.
    const value = await fn({ url: row.url, timeoutMs: Math.min(ROW_TIMEOUT_MS, left) });
    if (value !== null) return { value, name: row.name };
  }
  return null;
}

interface Cached<T> {
  value: T;
  fetchedAt: number;
}
type Miss = { missing: true; fetchedAt: number };

interface LinkRow {
  id: string;
  title?: string;
  shift?: number;
}

interface AnimeLink extends DanmakuLink {
  /** Episode index (`0` for a film) → the row that index resolved to, so the next playback is free. */
  episodes: Record<string, LinkRow>;
}

interface Store {
  v: number;
  /** key = `${itemId}:${episodeId}`; the parsed, shifted, filtered, sorted comment list. */
  tracks: Record<string, Cached<DanmakuTrack>>;
  /** key = `${itemId}`; the ladder's answer for one item, and the row that gave it. */
  candidates: Record<string, (Cached<DanmakuTrackInfo[]> & { source?: string }) | Miss>;
  /** key = `${seriesId || itemId}`; a show the viewer linked by hand. */
  links: Record<string, AnimeLink>;
  /** key = `${episodeId}`; how many comments that episode holds. Kept apart from the comments themselves
   *  because the drawer needs the number for every candidate, and a number is worth caching for a week while
   *  the track it came with is only worth caching for as long as it is being watched. */
  counts: Record<string, Cached<number>>;
}

const file = () => path.join(app.getPath('userData'), 'danmaku.json');
let store: Store | null = null;

const empty = (): Store => ({ v: STORE_VERSION, tracks: {}, candidates: {}, links: {}, counts: {} });

const load = (): Store => {
  if (store) return store;
  let next = empty();
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Store>;
    // The bilibili-era file has no `v` and its keys mean something else; it is simply not read.
    if (raw.v === STORE_VERSION) next = { ...next, ...raw, links: raw.links || {}, counts: raw.counts || {} };
    // A newer build's caches are dropped, but the links are the viewer's own answers and outlive every rule
    // change: the matcher was rewritten on 2026-10-30 and the answers it had already written down — including
    // the 「this show has none」 rows, which live a day — were the old rules' verdicts, not this viewer's.
    else if (raw && raw.links) next = { ...next, links: raw.links };
  } catch {
    // No file yet, or one that is not ours: start clean.
  }
  store = next;
  return next;
};

const persist = (): void => {
  try {
    mkdirSync(path.dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify(load()), 'utf8');
  } catch {
    // A cache that cannot be written only costs a refetch on the next open.
  }
};

const fresh = (hit: Cached<unknown> | Miss | undefined): boolean => !!hit && Date.now() - hit.fetchedAt < ('missing' in hit ? MISS_TTL : HIT_TTL);

const names = (q: DanmakuQuery): string[] => {
  const out: string[] = [];
  const series = (q.seriesName || '').trim();
  const own = (q.title || '').trim();
  // An episode's own title is never a work title. Asking 「试播集」 because a show called 路西法 happened to
  // have a pilot by that name does not merely waste the request — the service *answers*: it returned eleven
  // works named 「… 试播集」, all of them plausible by name, and the ladder bound the episode to one of them
  // (measured 2026-10-30, the moment 路西法's own name came back empty).
  const isEpisode = q.episode != null;
  if (series && (!isEpisode || series !== own)) out.push(series);
  if (!isEpisode && own && own !== series) out.push(own);
  // A film's library title is often the localized one while the service files it under something else
  // entirely; the original title is the second spelling worth asking, and the service searches English and
  // Japanese too. Episodes are left alone: their own original title is the episode's, not the show's.
  const original = isEpisode ? '' : (q.originalTitle || '').trim();
  if (original && original !== series && original !== own) out.push(original);
  return out;
};

/** Every spelling the ladder asks, in order: the library's own first, then the same title with a mirror's
 *  dressing peeled off — 「葬送的芙莉莲(2023)【TV动画】from dandan」 is what our panel prints, while the episode
 *  index only knows 「葬送的芙莉莲」. Deduped, because most titles arrive clean. */
const nameTries = (q: DanmakuQuery): string[] => {
  const out: string[] = [];
  for (const name of names(q)) {
    for (const one of [name, plainTitle(name)]) {
      if (one && !out.includes(one)) out.push(one);
    }
  }
  return out;
};

/* ------------------------------- 认不认得出是同一条 ------------------------------- */

const cjkOf = (s: string): string => (s.match(/[\u3400-\u9fff]/g) || []).join('');

/** The Traditional and Japanese spellings that meet in titles, each folded onto its Simplified form. Two
 *  titles otherwise have to share an exact character, and 「劇場版」 against 「剧场版」 shares none at all — that
 *  is how a 2023 film with an exactly matching year was thrown away while the service was holding it
 *  (measured 2026-10-30: 劇場版アイドリッシュセブン LIVE 4bit BEYOND found nothing, and 「剧场版IDOLiSH7 LIVE
 *  4bit BEYOND THE PERiOD(2023)」 was in the answer). Pairs only, so a character we do not know is left alone. */
const FOLDS = [
  '劇剧', '場场', '門门', '醫医', '戰战', '龍龙', '眾众', '傳传', '動动', '會会',
  '樂乐', '業业', '務务', '東东', '兩两', '嚴严', '個个', '豐丰', '臨临', '為为',
  '麗丽', '舉举', '麼么', '烏乌', '習习', '鄉乡', '書书', '買买', '亂乱', '爭争',
  '親亲', '覺觉', '觀观', '記记', '設设', '語语', '說说', '誰谁', '課课', '談谈',
  '論论', '質质', '費费', '賽赛', '贏赢', '車车', '輪轮', '轉转', '進进', '撃击',
  '遠远', '還还', '邊边', '連连', '運运', '達达', '選选', '錯错', '開开', '關关',
  '間间', '際际', '隊队', '階阶', '續续', '結结', '給给', '終终', '級级', '純纯',
  '線线', '練练', '織织', '總总', '聲声', '聽听', '腦脑', '舊旧', '藝艺', '處处',
  '號号', '蟲虫', '術术', '衛卫', '裝装', '裡里', '複复', '訓训', '訪访', '認认',
  '誕诞', '誌志', '護护', '變变', '讓让', '貝贝', '負负', '財财', '責责', '敗败',
  '貨货', '貴贵', '過过', '釋释', '銷销', '鋼钢', '錄录', '鏡镜', '長长', '陽阳',
  '雙双', '難难', '靈灵', '韓韩', '頁页', '順顺', '須须', '預预', '領领', '頭头',
  '題题', '額额', '顏颜', '願愿', '類类', '風风', '飛飞', '飯饭', '飲饮', '驚惊',
  '體体', '髮发', '鬥斗', '魚鱼', '鳥鸟', '鳳凤', '黃黄', '黨党', '齒齿', '靜静',
  '頻频', '顧顾', '顯显', '館馆', '驗验', '廳厅', '廁厕', '廠厂', '廣广', '廬庐',
];
const FOLD = new Map<string, string>();
for (const pair of FOLDS) FOLD.set(pair[0], pair[1]);
const fold = (s: string): string => String(s || '').replace(/[\u3400-\u9fff]/g, ch => FOLD.get(ch) || ch);

/** Words of three letters or more: the only handle a Latin title shares with a Latin row
 *  (「Frieren: Beyond Journey's End」 against 「Sousou no Frieren」). */
const latinOf = (s: string): string[] => String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];

/** The longest run of Chinese characters two titles share, ignoring everything else. A run, not a bag of
 *  characters: 「无职转生 第二季」 and 「无职转生～到了异世界就拿出真本事～」 share 无职转生 as a run, while
 *  「夜王」 and 「くのいち・咲夜」 share only 夜 and must not be read as the same work. Script-blind, so a
 *  Traditional title still meets its Simplified spelling. */
const commonRun = (a: string, b: string): number => {
  const A = cjkOf(a);
  const B = cjkOf(b);
  if (!A || !B) return 0;
  let best = 0;
  const row = new Array<number>(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i += 1) {
    let diag = 0;
    for (let j = 1; j <= B.length; j += 1) {
      const carry = row[j];
      if (A[i - 1] === B[j - 1]) {
        row[j] = diag + 1;
        if (row[j] > best) best = row[j];
      } else {
        row[j] = 0;
      }
      diag = carry;
    }
  }
  return best;
};

/** The season a title says it is, when it says: 「第二季」, 「第 2 部」, 「S2」, 「Season 2」, 「Ⅱ」. */
const CN_DIGITS: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

const cnNumber = (s: string): number | undefined => {
  if (/^\d{1,2}$/.test(s)) return Number(s);
  if (!/^[一二三四五六七八九十]+$/.test(s)) return undefined;
  const ten = s.indexOf('十');
  if (ten < 0) return s.length === 1 ? CN_DIGITS[s] : undefined;
  const high = ten === 0 ? 1 : CN_DIGITS[s[ten - 1]];
  const low = ten === s.length - 1 ? 0 : CN_DIGITS[s[ten + 1]];
  return high == null || low == null ? undefined : high * 10 + low;
};

const ROMAN_SEASON: Record<string, number> = { 'Ⅱ': 2, 'Ⅲ': 3, 'Ⅳ': 4, 'Ⅴ': 5, 'Ⅵ': 6, 'Ⅶ': 7, 'Ⅷ': 8, 'Ⅸ': 9 };

const seasonOf = (title: string): number | undefined => {
  const t = String(title || '');
  const cn = /第\s*([一二三四五六七八九十]+|\d{1,2})\s*[季部期]/.exec(t);
  if (cn) return cnNumber(cn[1]);
  // Only the latin 「S2」 / 「Season 2」 spelling, never 「S01E03」: an episode's file name is not a season claim.
  const en = /(?:\bSeason\s*(\d{1,2})\b|(?<![A-Za-z0-9])S(\d{1,2})(?![0-9A-Za-z]|E\d))/i.exec(t);
  if (en) return Number(en[1] || en[2]);
  for (const key of Object.keys(ROMAN_SEASON)) if (t.includes(key)) return ROMAN_SEASON[key];
  return undefined;
};

/** True when this row is plausibly the work that was asked about.
 *
 *  Why it exists: the episode search is a fuzzy pass over an anime catalogue, and for a Chinese film title it
 *  happily answers with unrelated works — measured 2026-10-30, 「死神来了2」 came back as 「金童卡修 剧场版」,
 *  「龟有公园前派出所」 and an OVA called 「女友不来探病的理由」, none sharing a character with the request.
 *  Showing those is worse than showing nothing: the viewer gets six comments from another film.
 *
 *  Four tests, each one earned by a wrong binding: the season the title claims (路西法 第一季 was bound to
 *  第二季, and both are dated 2016), the year (the 2017 纸房子 against the 2021 documentary), a shared run of
 *  Chinese characters after folding the scripts together, and a shared Latin word for titles that carry one.
 *  A row that fails all four is a different work, however confident the service was. */
const seriesSeason = (q: DanmakuQuery): number | undefined => {
  const tail = /^.*[\u3400-\u9fff][·\s]*(\d{1,2})$/.exec((q.seriesName || '').trim());
  return tail ? Number(tail[1]) : undefined;
};

const plausible = (row: DanmakuTrackInfo, q: DanmakuQuery): boolean => {
  if (row.exact || row.linked) return true;
  const year = q.year;
  const mine = nameTries(q).map(fold).filter(Boolean);
  const title = fold(row.title);
  const theirs = cjkOf(title);
  const words = latinOf(row.title);
  const said = seasonOf(row.title);
  const asked = q.season != null && q.season > 0 ? q.season : undefined;
  // Some libraries carry the season in the *series* name instead of the season number — 「地球脉动3」 is one
  // entry whose season 1 is the show's third — and the service files it as 「地球脉动 第三季」. The trailing
  // digit is the only place that number appears on our side, so it counts as a claim of its own.
  const nameSaid = seriesSeason(q);
  const agrees = said != null && (said === asked || (nameSaid != null && said === nameSaid));
  // A row that names another season is another season: the year cannot separate them (both 2016), and taking
  // the first row the service lists put every 第一季 episode on 第二季's comments.
  if (asked && said != null && !agrees) return false;
  // A row that names the season being played needs no year: services date a season by its own first airing,
  // and a long runner's rows drift away from the year the library holds (银魂 2006 against a 2026 film).
  const seasonProof = asked != null && agrees;
  // Two years apart is another work that borrowed the name, even when the shared name is long enough to look
  // convincing: 「进击的巨人 S1E1」 must not land on 「进击的巨人 完结篇 THE LAST ATTACK(2024)」.
  if (!seasonProof && row.year && year && Math.abs(row.year - year) > 1) return false;
  // A title in another script keeps its Latin words (「劇場版アイドリッシュセブン LIVE 4bit BEYOND」 against
  // 「剧场版IDOLiSH7 LIVE 4bit BEYOND THE PERiOD」), and that is the whole proof for those.
  if (words.length > 0 && mine.some(m => latinOf(m).some(w => words.includes(w)))) return true;
  // A shared run of the whole name is the strong test: 「夜王」 sits inside 「夜王~YAOH~」. Short names set
  // their own bar — a two-character title has to survive as a run of two — while longer ones only need the
  // three characters that make a title recognisable.
  const strong = mine.some(s => {
    const c = cjkOf(s);
    return c.length > 0 && theirs.length > 0 && commonRun(title, c) >= Math.min(3, c.length);
  });
  if (strong) return true;
  // Nothing in common in either script: the year is the only thing left, and it has to be the same year, not
  // a neighbouring one. (A Latin-only request used to pass this test without any check at all, which is how
  // 「James May: Our Man in…」 was bound to an unrelated 舌尖上的清流.)
  if (!mine.length || !theirs.length) return !!year && !!row.year && row.year === year;
  // A title written in another script keeps only its first two characters (「葬送のフリーレン」 against
  // 「葬送的芙莉莲」), so the same season or a neighbouring year is allowed to carry the rest of the proof.
  return (seasonProof || !row.year || !year || Math.abs(row.year - year) <= 1) && mine.some(s => commonRun(title, cjkOf(s)) >= 2);
};

/** The order the panel shows its rows in, best first.
 *
 *  The service's own order is relevance to a fuzzily matched title, which for a franchise puts the newest
 *  film or a spin-off first (银魂's 2026 剧场版 ranked above the 2006 TV series; 进击的巨人's 2024 完结篇 above
 *  the 2013 series). Four signals are ours: the work the service itself resolved, the year the library holds,
 *  the season the row claims, and the kind of work it is — a season's episode is not a film. `sort` is
 *  stable, so the service's ranking still decides ties. */
const rankOf = (r: DanmakuTrackInfo, q: DanmakuQuery): number => {
  let n = r.exact || r.linked ? 8 : 0;
  // A decade away is a different production that borrowed the name — a remake, a documentary, a concert film —
  // even when it calls itself the same season (孤独的美食家 第一季(2019) against a 2012 episode).
  if (q.year && r.year) n += r.year === q.year ? 3 : Math.abs(r.year - q.year) <= 1 ? 1 : -3;
  const said = seasonOf(r.title);
  const nameSaid = seriesSeason(q);
  if (q.season != null && q.season > 0 && said != null && (said === q.season || said === nameSaid)) n += 3;
  if (q.episode != null) {
    const kind = r.type || '';
    if (/剧场版|电影|OV[AD]|纪录片|其他|总集/.test(kind)) n -= 4;
    else if (/TV|电视剧|动漫|网络放送/.test(kind)) n += 1;
  }
  return n;
};

const linkKey = (q: DanmakuQuery): string => q.seriesId || q.itemId;
const episodeKey = (q: DanmakuQuery): string => (q.episode != null ? String(q.episode) : '0');
/** The year a work first aired.
 *
 *  Two sources, because the service is not consistent about the field: /api/v2/search/anime hands back a
 *  real startDate, while /api/v2/search/episodes - the ladder that answers for an episode - leaves the field
 *  out entirely and puts the year inside the title instead (「无职转生Ⅱ ～到了异世界就拿出真本事～(2023)」).
 *  Reading only startDate left every row of the episode search without a year, which silently disabled both
 *  the 「two years apart is another work」 filter and the ranking below - a season-2 episode was bound to the
 *  first row the service happened to list, which was season 3. */
const yearOf = (anime: ApiAnime): number | undefined => {
  const start = Number((anime.startDate || '').slice(0, 4));
  if (Number.isFinite(start) && start > 1900) return start;
  const said = /[（(](\d{4})[)）]/.exec(anime.animeTitle || '');
  const year = said ? Number(said[1]) : NaN;
  return Number.isFinite(year) && year > 1900 ? year : undefined;
};

/** One API row as the panel prints it: 「葬送的芙莉莲 (2023)【TV动画】· 第1话 冒险结束」. */
const toCandidate = (anime: ApiAnime, episodeId: number, episodeTitle: string | undefined, extra: { shift?: number; exact?: boolean; api?: string } = {}): DanmakuTrackInfo => ({
  id: String(episodeId),
  title: (anime.animeTitle || '').trim() || String(anime.animeId),
  episode: episodeTitle,
  type: anime.typeDescription || anime.type,
  year: yearOf(anime),
  animeId: anime.animeId != null ? String(anime.animeId) : undefined,
  poster: anime.imageUrl,
  ...(extra.shift ? { shift: extra.shift } : {}),
  ...(extra.exact ? { exact: true } : {}),
  // Which endpoint answered, so the count can go back to the same one instead of guessing.
  ...(extra.api ? { api: extra.api } : {}),
});

/** Both the TMDB and the title ladders answer with a list of *works*, each holding the episodes that matched;
 *  the panel wants one row per episode, so the works are flattened in the order the service ranked them. */
const flatten = (animes: ApiAnime[], extra: { exact?: boolean; api?: string } = {}): DanmakuTrackInfo[] => {
  const out: DanmakuTrackInfo[] = [];
  for (const a of animes) {
    for (const e of a.episodes || []) {
      if (e?.episodeId == null) continue;
      out.push(toCandidate(a, e.episodeId, e.episodeTitle, extra));
    }
  }
  return out;
};

const dedupe = (rows: DanmakuTrackInfo[]): DanmakuTrackInfo[] => {
  const seen = new Set<string>();
  return rows.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)));
};

/** One count’s ceiling. The mirror answers a 200KB track in 0.8–1.4s when warm, but it also serves 4–5s on a
 *  bad minute, and a number is not worth holding the drawer for longer than this. */
const COUNT_MS = 6_000;
/** How long the eager pass in `lookup` may hold the drawer. Every candidate is counted (a row without a number
 *  reads as 「no comments here」), but the drawer opens with whatever answered by this point and the rest arrives
 *  from the window afterwards — one slow mirror must not keep a 20-row list off the screen. */
const COUNT_BUDGET_MS = 6_000;
/** How many counts are in flight at once. Six keeps a head of short lists filled inside the budget without
 *  turning a 40-row answer into a burst of downloads. */
const COUNT_PARA = 6;
/** A counted track’s rows kept in memory this long, so picking that row does not download it a second time. */
const COUNT_KEEP_MS = 120_000;
/** Rows already downloaded while counting, by episode id. Cleared by the clock, not by the viewer. Bounded:
 *  counting now walks every row of an answer, so an unbounded map would hold a whole season's tracks — sixty
 *  rows of 200KB — for a drawer nobody is looking at. */
const counted = new Map<string, { rows: ApiCommentRow[]; at: number }>();
/** How many counted tracks stay in memory for the playback that follows the number. Four is the drawer's head. */
const COUNTED_KEEP = 4;

/** Ask one endpoint for a count, and keep the rows it came with: the count and the track are one reply, so the
 *  download that produced the number can serve the playback a moment later.
 *
 *  An empty reply is not a count. Measured 2026-10-30: `/comment/10042` answered `{count:0,comments:[]}` once
 *  and `{count:2286,comments:[…]}` on the next ask, and the zero was cached for a week — the drawer printed
 *  「0 条」 beside a track holding 2,286 comments. Zero-with-nothing is therefore read as 「不知道」. */
const countOf = async (src: ApiSource, id: string): Promise<number | null> => {
  const page = await commentPage(src, id);
  if (!page) return null;
  if (page.rows.length) {
    counted.set(id, { rows: page.rows, at: Date.now() });
    while (counted.size > COUNTED_KEEP) counted.delete(counted.keys().next().value as string);
  }
  if (page.count > 0) return page.count;
  return page.rows.length ? page.rows.length : null;
};

/** A number from the file, or null. A stored zero is read as 「not known」: those entries are the empty
 *  replies an older build cached for a week, and re-asking is exactly how they get replaced. */
const storedCount = (id: string): number | null => {
  const hit = load().counts[id];
  if (!hit || hit.value <= 0 || Date.now() - hit.fetchedAt >= HIT_TTL) return null;
  return hit.value;
};

/**
 * Fills the number on every candidate the drawer is about to show.
 *
 * All of them, not the head: a row without a number reads as 「这一条没有弹幕」, and the column is what the
 * viewer compares mirrors by. The walk is bounded by time rather than by row count, so a long answer opens
 * with the numbers that arrived and the window asks for the rest (`countOne`) — a row whose endpoint stays
 * silent keeps no number rather than a zero, because 「0 条」 is a claim about the work and 「不知道」 is not.
 */
const fillCounts = async (rows: DanmakuTrackInfo[], budgetMs = COUNT_BUDGET_MS): Promise<boolean> => {
  const s = load();
  let wrote = false;
  const ask: DanmakuTrackInfo[] = [];
  for (const r of rows) {
    // A count that came in with a cached list is not evidence: it may be a zero an older build read out of an
    // empty reply, and the file is the only place a number is allowed to come from.
    const known = storedCount(r.id);
    r.count = known ?? undefined;
    if (known == null) ask.push(r);
  }
  if (!ask.length) return false;
  const deadline = Date.now() + budgetMs;
  const one = async (r: DanmakuTrackInfo): Promise<void> => {
    const left = deadline - Date.now();
    if (left < 500) return;
    const named = r.api ? apiSources().find(src => src.name === r.api) : undefined;
    const cap = Math.min(COUNT_MS, left);
    let n = named ? await countOf({ url: named.url, timeoutMs: cap }, r.id) : null;
    // A row restored from a cache entry written before the endpoint was recorded has no name; the list order
    // is the next best guess, and a wrong guess only costs a request that answers null.
    if (n === null) {
      const fallback = await firstAnswer(src => countOf({ ...src, timeoutMs: Math.min(cap, ROW_TIMEOUT_MS) }, r.id));
      n = fallback ? fallback.value : null;
    }
    if (n === null) return;
    r.count = n;
    s.counts[r.id] = { value: n, fetchedAt: Date.now() };
    wrote = true;
  };
  const queue = [...ask];
  const worker = async (): Promise<void> => {
    for (let r = queue.shift(); r; r = queue.shift()) await one(r);
  };
  await Promise.all(Array.from({ length: Math.min(COUNT_PARA, queue.length) }, () => worker()));
  return wrote;
};

/**
 * Best first, and among rows the ranking cannot tell apart, the busiest one.
 *
 * The count is a tie-breaker and never a vote. rankOf puts three points on a matching season and one on being
 * a TV episode rather than a film, so a gap wider than two points is a different production wearing the same
 * name — a remake, a documentary, a concert film — and 「it has more comments」 must not promote it. Within two
 * points the rows are the same show as different endpoints or seasons number it, and there the fuller track is
 * the one worth playing.
 */
const byCount = (a: DanmakuTrackInfo, b: DanmakuTrackInfo, q: DanmakuQuery): number => {
  const d = rankOf(b, q) - rankOf(a, q);
  if (Math.abs(d) > 2) return d;
  const ca = a.count ?? -1;
  const cb = b.count ?? -1;
  return ca === cb ? d : cb - ca;
};

/** The file name the matcher reads: the show plus the episode marker, without an extension. Emby's own names
 *  are already 「葬送的芙莉莲 - S01E01 - 第1话」-shaped often enough that this is a real hint rather than noise. */
const fileNameOf = (q: DanmakuQuery): string => {
  const base = (q.seriesName || q.title || '').trim();
  if (q.episode == null) return base;
  const s = q.season && q.season > 0 ? `S${String(q.season).padStart(2, '0')}` : '';
  const e = `E${String(q.episode).padStart(2, '0')}`;
  return `${base} ${s}${e}`.trim();
};

/** The manual-link rows come first and say so, so a viewer who linked a show by hand never has to hunt for
 *  the row they picked among the guesses. */
const linkedRow = (link: AnimeLink, row: LinkRow): DanmakuTrackInfo => ({
  id: row.id,
  title: link.animeTitle,
  episode: row.title,
  type: link.type,
  shift: row.shift,
  linked: true,
});

/**
 * The candidates for one item, with the manual link resolved to this episode. `null` means the service never
 * answered, which the caller must show as a failure rather than as 「没有弹幕」.
 */
export async function lookup(q: DanmakuQuery): Promise<DanmakuLookup | null> {
  // Nothing to ask: 弹幕 exists only as far as the endpoint rows do, so an empty or all-off list is 「no
  // 弹幕 here」 rather than an error, and no request leaves the machine.
  if (!apiSources().length) return { list: [], link: null, pick: '', auto: false };

  // One refusal from any rung of the ladder outlives the rungs that follow it: a walk that ends in a clean
  // 「no match」 after a quota rejection must still be able to say why it found nothing.
  clearFailure();
  // A ladder, not a request: three or four rungs, each with its own ceiling, on a service whose own answers
  // were measured between 0.4 s and 19 s on the same afternoon. The first rung always gets its full timeout —
  // it is the one that usually answers — and the walk stops starting new ones once the budget is gone, so a
  // dead endpoint costs one ceiling instead of four.
  const started = Date.now();
  const BUDGET_MS = 30_000;
  const spent = (): boolean => Date.now() - started > BUDGET_MS;
  const s = load();
  const link = s.links[linkKey(q)];
  const list: DanmakuTrackInfo[] = [];
  let answered = false;
  /** The row that answered, for the panel's 「来自 X」 note; the cached half below reads it back from disk. */
  let used = '';

  // 1. The link the viewer made. Its episode row may already be resolved; when it is not, the anime's title
  //    is asked again — that is one request the first time an episode is played and none afterwards.
  let linked: LinkRow | null = null;
  if (link) {
    const key = episodeKey(q);
    let row = link.episodes[key];
    if (!row) {
      const found = await workFor(link.animeTitle, link.animeId, q.episode != null ? String(q.episode) : undefined);
      if (found.answered) used = found.source;
      answered = true;
      const ep = found.hit?.episodes?.[0];
      if (ep) {
        row = { id: String(ep.episodeId), title: ep.episodeTitle };
        link.episodes[key] = row;
        persist();
      }
    }
    if (row) {
      linked = row;
      // The number belongs on this row as much as on the guesses: it is the row that plays, and the viewer
      // comparing mirrors reads the counts as one column. Counting downloads the track itself, which is the
      // row about to be played, so the bytes are the ones the playback would have spent anyway.
      const row0 = linkedRow(link, row);
      await fillCounts([row0]);
      list.push(row0);
      persist();
    }
  }

  // 2-4. The guesses. Cached as a whole: the ladder is three requests deep on a cold title.
  const key = q.itemId;
  const hit = s.candidates[key];
  const stale = hit && 'value' in hit ? hit.value : null;
  let failed: ReturnType<typeof lastFailure> = null;
  if (fresh(hit)) {
    if (stale) {
      // A remembered answer keeps its numbers: they live a week, and asking again for a drawer that is opened
      // twice is exactly the trip the count cache exists to avoid. The order is recomputed because the count
      // is part of it — a row counted for the first time may now belong above the one that was first before.
      const wrote = await fillCounts(stale);
      stale.sort((a, b) => byCount(a, b, q));
      if (wrote) persist();
      list.push(...stale);
      used = (hit && 'source' in hit ? hit.source : '') || '';
    }
    answered = true;
  } else {
    const guess: DanmakuTrackInfo[] = [];
    let any = false;
    let exact = false;

    if (q.tmdbId) {
      const tmdbId = Number(q.tmdbId);
      const asked = Number.isFinite(tmdbId) && tmdbId > 0
        ? await firstAnswer(src => searchEpisodes(src, { tmdbId, tmdbType: q.episode != null ? 0 : 1, episode: q.episode != null ? String(q.episode) : undefined }))
        : null;
      const rows = asked?.value ?? null;
      if (asked) used = asked.name;
      if (rows && rows.length) {
        any = true;
        const found = flatten(rows, { exact: true, api: asked?.name });
        exact = found.length > 0;
        guess.push(...found);
      }
    }

    // The TMDB id is the service's own answer for this exact work. Asking by title after it only adds noise,
    // and one more request to a metered key, so that walk is skipped whenever TMDB produced rows.
    // An episode numbered 0 is a special: it has no place in the episode list, so asking the service for
    // 「第 0 集」 quietly answers with 第 1 集 (measured: 龙族's special was bound to 第1话, whose comments are
    // someone else's). No rows is the honest answer, and the viewer can link the work by hand.
    const special = q.episode === 0;

    if (!exact && !special) {
      for (const name of nameTries(q)) {
        if (!name) continue;
        if (spent()) break;
        const asked = await firstAnswer(src => searchEpisodes(src, { anime: name, episode: q.episode != null ? String(q.episode) : undefined }));
        const rows = asked?.value ?? null;
        if (asked) used = asked.name;
        if (rows) {
          any = true;
          guess.push(...flatten(rows, { api: asked?.name }));
        }
        // Rows are not a match. The first spelling can answer with works that all fail the tests below, and
        // stopping there meant the plain title — the one a mirror's index actually knows — was never asked
        // (纸房子 and James May both stopped on their first name and reported nothing).
        if (guess.some(r => plausible(r, q))) break;
      }
    }

    if (!guess.length) {
      const asked = await firstAnswer(src => matchFile(src, fileNameOf(q)));
      const matched = asked?.value ?? null;
      if (asked) used = asked.name;
      if (matched) {
        any = true;
        guess.push(...matched.map(m => toCandidate(
          { animeId: m.animeId, animeTitle: m.animeTitle, typeDescription: m.typeDescription, imageUrl: m.imageUrl },
          m.episodeId,
          m.episodeTitle,
          { shift: m.shift, api: asked?.name },
        )));
      }
    }

    // A guess made from a Chinese title often lands on a same-named work from another decade; the year is
    // worth one extra call when the ladder had to guess at all, and never when TMDB already answered.
    let unique = dedupe(guess);
    if (unique.length && !exact && !spent()) {
      const name = nameTries(q)[0];
      const asked = name ? await firstAnswer(src => searchAnime(src, name)) : null;
      const animes = asked?.value ?? null;
      if (asked && !used) used = asked.name;
      if (animes) {
        any = true;
        const byId = new Map(animes.map(a => [String(a.animeId), a]));
        for (const row of unique) {
          // The row carries the work it came from: an episode id is its own number, not the work's padded
          // out, so the previous guess (strip three digits and hope) pointed at an unrelated work and wrote
          // its year onto the row.
          const a = row.animeId ? byId.get(row.animeId) : undefined;
          if (a && !row.year) row.year = yearOf(a);
          if (a && !row.poster) row.poster = a.imageUrl;
        }
      }
    }

    // Another work's comments are worse than none: drop what cannot be this film or show, then put the rows
    // whose year the library recognises first. An exact year beats a neighbouring one, because a service
    // that lists every season of a show answers with (2023) and (2024) rows of the same episode number, and
    // only the exact year is the season being played. `sort` is stable, so the service's own ranking
    // survives ties.
    unique = unique.filter(r => plausible(r, q));
    // Numbers, then order: the count is printed on every row and is also the tie-breaker the order uses.
    await fillCounts(unique);
    unique.sort((a, b) => byCount(a, b, q));

    failed = lastFailure();
    if (!any && !unique.length) {
      // Every row stayed silent. A list remembered from a better hour beats an empty drawer, but only when
      // the service is refusing to talk — never when it answered 「none」.
      if (stale && failed) {
        list.push(...stale);
        answered = true;
      } else if (!failed) {
        return null;
      }
    } else {
      const s2 = load();
      if (unique.length) s2.candidates[key] = { value: unique, fetchedAt: Date.now(), source: used };
      else s2.candidates[key] = { missing: true, fetchedAt: Date.now() };
      persist();
      list.push(...unique);
      answered = true;
    }
  }

  const rows = dedupe(list);
  // No answer at all is 「没有回应」 — unless something refused, which is a fact the drawer must name
  // (「配额已用完，约 N 小时后恢复」) rather than passing off as a service that never spoke. Returning here
  // on a refusal is what made the 429 read as a plain empty drawer.
  if (!answered && !rows.length && !failed) return null;
  return {
    list: rows,
    // The stored link also carries its per-episode cache; only the fields a panel reads cross the bridge.
    link: link ? { animeId: link.animeId, animeTitle: link.animeTitle, type: link.type, episodeId: linked?.id || '', episodeTitle: linked?.title, shift: link.shift } : null,
    pick: rows[0]?.id || '',
    auto: rows.some(r => r.exact),
    ...(used ? { source: used } : {}),
    ...(failed && !rows.length ? { reason: failed.kind, retryAfterMs: failed.retryMs } : {}),
  };
}

/** One comment row: `p` is 「出现时间,模式,颜色,用户ID」 for this service. Mode 5 pins to the top, 4 to the
 *  bottom, everything else scrolls; the colour is a 24-bit integer. */
const parseRow = (p: string, body: string): DanmakuComment | null => {
  const f = p.split(',');
  const t = Number(f[0]);
  const text = body.trim();
  if (!Number.isFinite(t) || !text) return null;
  const mode = f[1] === '5' ? 'top' : f[1] === '4' ? 'bottom' : 'scroll';
  const n = f[2] && /^\d+$/.test(f[2]) ? Number(f[2]) : 0xffffff;
  const color = `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
  return { timeSec: t, text, color, mode };
};

/** Bad rows out, time order in. Kept apart from the blocked words because this half is a fact about the
 *  file and the other half is a preference the viewer can change while it plays. */
const sanitize = (comments_: DanmakuComment[]): DanmakuComment[] =>
  comments_.filter(c => c.text && Number.isFinite(c.timeSec) && c.timeSec >= 0).sort((a, b) => a.timeSec - b.timeSec);

/** 屏蔽词 applied on the way out, never baked into the cache: editing the list while a track plays has to
 *  take effect on the comments already fetched, and dropping them from the cache would mean a new download. */
const applyFilters = (comments_: DanmakuComment[], cfg: DanmakuSettings): DanmakuComment[] => {
  const blocked = cfg.blockedWords.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
  const out = sanitize(comments_);
  return blocked.length ? out.filter(c => !blocked.some(w => c.text.includes(w))) : out;
};

/**
 * One candidate's comments, parsed, shifted, filtered and sorted. `shift` is the service's own answer for how
 * far this copy of the film runs from the copy the comments were timed against — a rip with a 90-second
 * studio logo in front of it is the ordinary case, and ignoring it puts every comment 90 seconds early.
 */
export async function fetchTrack(q: DanmakuQuery, trackId: string, shift = 0): Promise<DanmakuTrack | null> {
  const cfg = config.get().settings.danmaku;
  if (!apiSources().length) return null;
  const key = `${q.itemId}:${trackId}`;
  const hit = load().tracks[key];
  if (hit && fresh(hit)) return { ...hit.value, comments: applyFilters(hit.value.comments, cfg) };

  // 「no answer」 and 「no comments」 used to be the same null on this side, so the overlay could only say
  // 「这一条没有弹幕」 about a service that timed out — measured 2026-10-30: both cases cross the bridge as
  // `{ok:true, data:null}` and the panel has no way to tell them apart. A failed download now fails, and only
  // a track that really has no comments comes back empty.
  // Counting this row a moment ago already downloaded exactly these rows — the count and the track are one
  // reply — so the row the viewer picks after reading 「5931 条」 starts instantly instead of paying for the
  // same bytes twice.
  const kept = counted.get(trackId);
  const reuse = kept && Date.now() - kept.at < COUNT_KEEP_MS ? kept.rows : null;
  if (reuse) counted.delete(trackId);
  const asked = reuse ? null : await firstAnswer(src => comments(src, trackId));
  if (!reuse && asked === null) throw new Error('弹幕服务没有回应');
  const rows = reuse ?? asked!.value;
  const parsed: DanmakuComment[] = [];
  for (const c of rows) {
    const row = parseRow(String(c?.p ?? ''), typeof c?.m === 'string' ? c.m : '');
    if (!row) continue;
    if (shift) row.timeSec = Math.max(0, row.timeSec + shift);
    parsed.push(row);
  }
  const clean = sanitize(parsed);
  if (!clean.length) return null;

  const link = load().links[linkKey(q)];
  const title = link && link.episodes[episodeKey(q)]?.id === trackId ? link.animeTitle : trackId;
  const out: DanmakuTrack = { id: trackId, title, comments: clean, fetchedAt: Date.now() };
  load().tracks[key] = { value: out, fetchedAt: Date.now() };
  persist();
  return { ...out, comments: applyFilters(clean, cfg) };
}

/** 手动链接: one show, one work on the other side. Passing `null` drops the link and the guesses are used
 *  again — the two answers for that item are dropped with it, because both lists were built around it. */
export function setLink(q: DanmakuQuery, link: DanmakuLink | null): DanmakuLink | null {
  const s = load();
  const key = linkKey(q);
  if (!link) {
    delete s.links[key];
  } else {
    const prev = s.links[key];
    s.links[key] = { ...link, episodes: prev && prev.animeId === link.animeId ? prev.episodes : {} };
    s.links[key].episodes[episodeKey(q)] = { id: link.episodeId, title: link.episodeTitle, shift: link.shift };
  }
  for (const k of Object.keys(s.candidates)) if (k === q.itemId) delete s.candidates[k];
  for (const k of Object.keys(s.tracks)) if (k.startsWith(`${q.itemId}:`)) delete s.tracks[k];
  persist();
  return link;
}

/** Answers to `search`, kept in memory for the session. The drawer is closed and reopened while the viewer
 *  compares mirrors, and a keyword costs 0.3–9 s against a loaded one; the same word asked twice is the same
 *  list. In memory only — a restart is a new catalogue, and a fortnight-old search is worse than a slow one. */
const searches = new Map<string, { rows: DanmakuAnime[]; at: number }>();
const SEARCH_TTL_MS = 10 * 60_000;
const SEARCH_KEEP = 24;

/** 手动链接's search box: the works a keyword finds, with the year and the episode count that tell two
 *  same-named shows apart. */
export async function search(word: string): Promise<DanmakuAnime[] | null> {
  const key = word.trim().toLowerCase();
  const kept = searches.get(key);
  if (kept && Date.now() - kept.at < SEARCH_TTL_MS) {
    // Re-insert so the map's own order is least-recently-used first.
    searches.delete(key);
    searches.set(key, kept);
    return kept.rows.map(r => ({ ...r }));
  }
  const asked = await firstAnswer(src => searchAnime(src, word.trim()));
  if (asked === null) return null;
  const animes = asked.value;
  const rows = animes.map(a => ({
    id: String(a.animeId),
    title: (a.animeTitle || '').trim(),
    type: a.typeDescription || a.type,
    year: yearOf(a),
    episodes: a.episodeCount,
    poster: a.imageUrl,
    rating: a.rating,
  }));
  if (rows.length) {
    searches.delete(key);
    searches.set(key, { rows, at: Date.now() });
    while (searches.size > SEARCH_KEEP) searches.delete(searches.keys().next().value as string);
  }
  return rows.map(r => ({ ...r }));
}

/**
 * The title a work is filed under, without the dressing a mirror adds.
 *
 * A deployment that proxies 弹弹play sometimes answers with the name it assembled for its own index —
 * 「葬送的芙莉莲(2023)【TV动画】from dandan」 — and then refuses that same string in the next question: the episode
 * endpoint only knows 「葬送的芙莉莲」. The year goes with it because one mirror (measured 2026-10-30) answers
 * 「名字(2023)」 with a single unrelated work while 「名字」 returns the whole catalogue.
 */
function plainTitle(title: string): string {
  // Peeled in rounds rather than in one fixed order: the dressing nests — 「…第二季(2026)【TV动画】from dandan」
  // ends in the source, so a single pass that looks for 【…】 at the end first would leave the bracket behind.
  let out = String(title || '').trim();
  for (let round = 0; round < 4; round += 1) {
    const before = out;
    out = out
      .replace(/\s*from\s+\S+$/i, '')
      .replace(/\s*【[^】]*】\s*$/, '')
      .replace(/\s*[（(]\s*(?:19|20)\d{2}\s*[)）]\s*$/, '')
      .trim();
    if (out === before) break;
  }
  return out;
}

/**
 * The row for one work, and only that work.
 *
 * Two rules earned by measurement. The plain title is asked before the decorated one, because a mirror's own
 * dressing is not a keyword its episode index accepts. And a row is accepted **only** when its id is the id that
 * was asked for: the endpoint's relevance ranking collapses when it degrades to its own scraped sources
 * (`anime=无职转生Ⅱ` answered with 关于地球的运动, 黑色五叶草, 狂赌之渊 …), so 「第一行就是它」 would lay a stranger's
 * comments over the picture. Nothing found is the right answer when the id is missing.
 */
async function workFor(animeTitle: string, animeId: string, episode?: string): Promise<{ hit: ApiAnime | null; source: string; answered: boolean }> {
  const tries: string[] = [];
  for (const name of [plainTitle(animeTitle), String(animeTitle || '').trim()]) {
    if (name && !tries.includes(name)) tries.push(name);
  }
  let source = '';
  let answered = false;
  // Both spellings are asked even when the first one answers: a mirror that has degraded answers 200 with an
  // empty list, and stopping there would have said 「这部剧没有分集」 about a work it can serve under its own name.
  for (const name of tries) {
    const asked = await firstAnswer(src => searchEpisodes(src, { anime: name, episode }));
    if (asked === null) continue;
    answered = true;
    source = asked.name;
    const hit = asked.value.find(a => String(a.animeId) === animeId) || null;
    if (hit) return { hit, source, answered };
  }
  return { hit: null, source, answered };
}

/** The episodes of one work, so a link can name the exact row rather than the one the service would default to. */
export async function episodes(animeTitle: string, animeId: string): Promise<DanmakuEpisode[] | null> {
  const { hit, answered } = await workFor(animeTitle, animeId);
  if (!hit) return answered ? [] : null;
  return (hit.episodes || []).map(e => ({ id: String(e.episodeId), title: e.episodeTitle || '' }));
}

/** One episode row, named by its number. The list a work comes with is cut short (死神 holds 366 episodes and
 *  the search hands back 128), so a link that has to name 第 131 集 asks for that number instead of indexing
 *  past the end of a list that never reaches it. */
export async function episodeAt(animeTitle: string, animeId: string, episode: number): Promise<DanmakuEpisode | null> {
  const { hit } = await workFor(animeTitle, animeId, String(episode));
  const e = hit?.episodes?.[0];
  return e ? { id: String(e.episodeId), title: e.episodeTitle || '' } : null;
}

/** 手动搜索's compare column: how many comments one work holds for the episode being played.
 *
 *  The work rows a search answers with carry no count — the number is a property of an *episode*, and the
 *  episode has to be named by number because a work's own list is cut short (死神 lists 128 of 366). Every row
 *  of an answer gets one, so the panel asks for all of them, three at a time, and the numbers fill in under the
 *  eye instead of holding the page. Two asks per row; the resolved episode id is memoised for the session, so
 *  reopening the drawer or a second episode of the same work costs one request, not two.
 *  `count: null` is 「asked, no number」 — a silent endpoint is not a work with zero comments. */
export async function countFor(animeTitle: string, animeId: string, episode: number): Promise<{ episodeId: string; count: number | null } | null> {
  const memoKey = `${animeId}|${episode}`;
  const memo = episodeIds.get(memoKey);
  let row: DanmakuEpisode | null | undefined =
    memo && Date.now() - memo.at < EPISODE_ID_MS ? memo.row : undefined;
  episodeIds.delete(memoKey);
  if (row === undefined) {
    const ep = episode > 0 ? await episodeAt(animeTitle, animeId, episode) : await episodes(animeTitle, animeId);
    row = Array.isArray(ep) ? ep[0] || null : ep;
    // Only a hit is worth remembering: 「这部剧没有第 N 集」 is answered again next time rather than made
    // permanent for the whole session.
    if (row) {
      episodeIds.set(memoKey, { row, at: Date.now() });
      while (episodeIds.size > 200) episodeIds.delete(episodeIds.keys().next().value as string);
    }
  }
  if (!row) return null;
  const known = storedCount(row.id);
  if (known != null) return { episodeId: row.id, count: known };
  const asked = await firstAnswer(src => countOf(src, row.id));
  const n = asked ? asked.value : null;
  if (n !== null) {
    load().counts[row.id] = { value: n, fetchedAt: Date.now() };
    persist();
  }
  return { episodeId: row.id, count: n };
}

/** The episode a work files under a number, memoised per session; see `countFor`. */
const episodeIds = new Map<string, { row: DanmakuEpisode; at: number }>();
const EPISODE_ID_MS = 30 * 60_000;

/**
 * The number on one candidate row that the eager pass in `lookup` ran out of time for.
 *
 * The window walks its own list with this after the drawer opens, so the counts are complete without the
 * drawer waiting for the slowest mirror. A row that never answers simply keeps no number.
 */
export async function countOne(id: string, api?: string): Promise<number | null> {
  const known = storedCount(id);
  if (known != null) return known;
  const named = api ? apiSources().find(src => src.name === api) : undefined;
  // With a name, that endpoint is the only one worth asking: an episode id belongs to the index that issued it,
  // and the same number on another mirror is a different track. Without one, fall back in list order.
  let n = named ? await countOf(named, id) : null;
  if (n === null && !named) {
    const asked = await firstAnswer(src => countOf(src, id));
    n = asked ? asked.value : null;
  }
  if (n === null) return null;
  load().counts[id] = { value: n, fetchedAt: Date.now() };
  persist();
  return n;
}

/**
 * 设置 → 弹幕 → 测试: one endpoint, four questions, nothing cached.
 *
 * Deliberately independent of the row's switch and of the list's order: a viewer adds an address first and
 * wants to know whether it works before trusting it with a playback. A row only counts as usable when every
 * step passed — 「连得上但取不到弹幕」 is not an endpoint this app can use.
 */
export async function test(source: DanmakuSource, keyword: string): Promise<DanmakuTestResult> {
  const t0 = Date.now();
  const steps = await probe({ url: source.url }, keyword);
  return {
    id: source.id,
    name: source.name,
    url: source.url,
    ok: steps.length > 0 && steps.every(s => s.ok),
    ms: Date.now() - t0,
    steps,
  };
}

/** 弹幕调试 › 接口调试: hand one path to one endpoint and bring the raw answer back, untouched. */
export async function debug(base: string, path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<DanmakuDebugReply> {
  const reply = await raw(base, path, method, body);
  return { status: reply.status, ms: reply.ms, bytes: reply.bytes, text: reply.text, ...(reply.error ? { error: reply.error } : {}) };
}
