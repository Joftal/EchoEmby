import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as config from '../config';
import { clearFailure, comments, lastFailure, matchFile, normalizeBase, probe, raw, searchAnime, searchEpisodes, type ApiAnime, type ApiSource } from './api';
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
const STORE_VERSION = 3;

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
/** The whole walk, not each row, gets this long: with four endpoints a per-row 12s ceiling would mean the
 *  drawer spinning for 48 seconds before saying 「没有弹幕」. */
const LOOKUP_BUDGET_MS = 20_000;

async function firstAnswer<T>(fn: (src: ApiSource) => Promise<T | null>): Promise<{ value: T; name: string } | null> {
  const list = apiSources();
  const started = Date.now();
  for (const row of list) {
    const left = LOOKUP_BUDGET_MS - (Date.now() - started);
    if (left < 1_000) break;
    // A row that hangs must not eat the budget the rest of the list needs: the first one may use 12s, later
    // ones only what is left of the 20s. A refusal still costs nothing, so the ordinary broken mirror is free.
    const value = await fn({ url: row.url, timeoutMs: Math.min(12_000, left) });
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
}

const file = () => path.join(app.getPath('userData'), 'danmaku.json');
let store: Store | null = null;

const empty = (): Store => ({ v: STORE_VERSION, tracks: {}, candidates: {}, links: {} });

const load = (): Store => {
  if (store) return store;
  let next = empty();
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Store>;
    // The bilibili-era file has no `v` and its keys mean something else; it is simply not read.
    if (raw.v === STORE_VERSION) next = { ...next, ...raw, links: raw.links || {} };
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
  if (series) out.push(series);
  const own = (q.title || '').trim();
  if (own && own !== series) out.push(own);
  // A film's library title is often the localized one while the service files it under something else
  // entirely; the original title is the second spelling worth asking, and the service searches English and
  // Japanese too. Episodes are left alone: their own original title is the episode's, not the show's.
  const original = q.episode == null ? (q.originalTitle || '').trim() : '';
  if (original && original !== series && original !== own) out.push(original);
  return out;
};

/* ------------------------------- 认不认得出是同一条 ------------------------------- */

const cjkOf = (s: string): string => (s.match(/[\u3400-\u9fff]/g) || []).join('');

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

/** True when this row is plausibly the work that was asked about.
 *
 *  Why it exists: the episode search is a fuzzy pass over an anime catalogue, and for a Chinese film title it
 *  happily answers with unrelated works — measured 2026-10-30, 「死神来了2」 came back as 「金童卡修 剧场版」,
 *  「龟有公园前派出所」 and an OVA called 「女友不来探病的理由」, none sharing a character with the request.
 *  Showing those is worse than showing nothing: the viewer gets six comments from another film.
 *
 *  Two independent tests, either one enough to keep a row: the year the library knows (a 2007 drama is not
 *  the 2026 film of the same name), and a shared character with any spelling of the title. A row with no year
 *  and no shared character is a different work. */
const plausible = (row: DanmakuTrackInfo, q: DanmakuQuery): boolean => {
  if (row.exact || row.linked) return true;
  const year = q.year;
  // Two years apart is another work that borrowed the name: the 2007 drama is not the 2026 film.
  if (row.year && year && Math.abs(row.year - year) > 1) return false;
  const mine = names(q).map(cjkOf).filter(Boolean);
  const theirs = cjkOf(row.title);
  if (!mine.length || !theirs.length) return true;
  // A shared run of the whole name is the strong test: 「夜王」 sits inside 「夜王~YAOH~」. Short names set
  // their own bar — a two-character title has to survive as a run of two — while longer ones only need the
  // three characters that make a title recognisable, so 「无职转生」 still finds its own season's spelling.
  if (mine.some(s => commonRun(row.title, s) >= Math.min(3, s.length))) return true;
  // A title written in another script keeps only its first two characters (「葬送のフリーレン」 against
  // 「葬送的芙莉莲」), so an exact year is allowed to carry the rest of the proof.
  return !!row.year && !!year && Math.abs(row.year - year) <= 1 && mine.some(s => commonRun(row.title, s) >= 2);
};

const linkKey = (q: DanmakuQuery): string => q.seriesId || q.itemId;
const episodeKey = (q: DanmakuQuery): string => (q.episode != null ? String(q.episode) : '0');
const yearOf = (anime: ApiAnime): number | undefined => {
  const y = Number((anime.startDate || '').slice(0, 4));
  return Number.isFinite(y) && y > 1900 ? y : undefined;
};

/** One API row as the panel prints it: 「葬送的芙莉莲 (2023)【TV动画】· 第1话 冒险结束」. */
const toCandidate = (anime: ApiAnime, episodeId: number, episodeTitle: string | undefined, extra: { shift?: number; exact?: boolean } = {}): DanmakuTrackInfo => ({
  id: String(episodeId),
  title: (anime.animeTitle || '').trim() || String(anime.animeId),
  episode: episodeTitle,
  type: anime.typeDescription || anime.type,
  year: yearOf(anime),
  poster: anime.imageUrl,
  ...(extra.shift ? { shift: extra.shift } : {}),
  ...(extra.exact ? { exact: true } : {}),
});

/** Both the TMDB and the title ladders answer with a list of *works*, each holding the episodes that matched;
 *  the panel wants one row per episode, so the works are flattened in the order the service ranked them. */
const flatten = (animes: ApiAnime[], extra: { exact?: boolean } = {}): DanmakuTrackInfo[] => {
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
      const asked = await firstAnswer(src => searchEpisodes(src, { anime: link.animeTitle, episode: q.episode != null ? String(q.episode) : undefined }));
      const animes = asked?.value || [];
      if (asked) used = asked.name;
      answered = true;
      const hit = animes.find(a => String(a.animeId) === link.animeId) || animes[0];
      const ep = hit?.episodes?.find(e => q.episode == null || true);
      if (ep) {
        row = { id: String(ep.episodeId), title: ep.episodeTitle };
        link.episodes[key] = row;
        persist();
      }
    }
    if (row) {
      linked = row;
      list.push(linkedRow(link, row));
    }
  }

  // 2-4. The guesses. Cached as a whole: the ladder is three requests deep on a cold title.
  const key = q.itemId;
  const hit = s.candidates[key];
  const stale = hit && 'value' in hit ? hit.value : null;
  let failed: ReturnType<typeof lastFailure> = null;
  if (fresh(hit)) {
    if (stale) {
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
        const found = flatten(rows, { exact: true });
        exact = found.length > 0;
        guess.push(...found);
      }
    }

    // The TMDB id is the service's own answer for this exact work. Asking by title after it only adds noise,
    // and one more request to a metered key, so that walk is skipped whenever TMDB produced rows.
    if (!exact) {
      for (const name of names(q)) {
        if (!name) continue;
        const asked = await firstAnswer(src => searchEpisodes(src, { anime: name, episode: q.episode != null ? String(q.episode) : undefined }));
        const rows = asked?.value ?? null;
        if (asked) used = asked.name;
        if (rows) {
          any = true;
          guess.push(...flatten(rows));
        }
        if (guess.length) break;
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
          { shift: m.shift },
        )));
      }
    }

    // A guess made from a Chinese title often lands on a same-named work from another decade; the year is
    // worth one extra call when the ladder had to guess at all, and never when TMDB already answered.
    let unique = dedupe(guess);
    if (unique.length && !exact) {
      const name = names(q)[0];
      const asked = name ? await firstAnswer(src => searchAnime(src, name)) : null;
      const animes = asked?.value ?? null;
      if (asked && !used) used = asked.name;
      if (animes) {
        any = true;
        const byId = new Map(animes.map(a => [String(a.animeId), a]));
        for (const row of unique) {
          const a = byId.get(String(row.id).slice(0, Math.max(0, String(row.id).length - 3)));
          if (a && !row.year) row.year = yearOf(a);
          if (a && !row.poster) row.poster = a.imageUrl;
        }
      }
    }

    // Another work's comments are worse than none: drop what cannot be this film or show, then put the rows
    // whose year the library recognises first. `sort` is stable, so the service's own ranking survives ties.
    unique = unique.filter(r => plausible(r, q));
    const rank = (r: DanmakuTrackInfo): number => (r.exact ? 4 : 0) + (q.year && r.year && Math.abs(r.year - q.year) <= 1 ? 2 : 0);
    unique.sort((a, b) => rank(b) - rank(a));

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

  const asked = await firstAnswer(src => comments(src, trackId));
  if (asked === null) return null;
  const rows = asked.value;
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

/** 手动链接's search box: the works a keyword finds, with the year and the episode count that tell two
 *  same-named shows apart. */
export async function search(word: string): Promise<DanmakuAnime[] | null> {
  const asked = await firstAnswer(src => searchAnime(src, word.trim()));
  if (asked === null) return null;
  const animes = asked.value;
  return animes.map(a => ({
    id: String(a.animeId),
    title: (a.animeTitle || '').trim(),
    type: a.typeDescription || a.type,
    year: yearOf(a),
    episodes: a.episodeCount,
    poster: a.imageUrl,
    rating: a.rating,
  }));
}

/** The episodes of one work, so a link can name the exact row rather than the one the service would default to. */
export async function episodes(animeTitle: string, animeId: string): Promise<DanmakuEpisode[] | null> {
  const asked = await firstAnswer(src => searchEpisodes(src, { anime: animeTitle }));
  if (asked === null) return null;
  const animes = asked.value;
  const hit = animes.find(a => String(a.animeId) === animeId) || animes[0];
  if (!hit) return [];
  return (hit.episodes || []).map(e => ({ id: String(e.episodeId), title: e.episodeTitle || '' }));
}

/** One episode row, named by its number. The list a work comes with is cut short (死神 holds 366 episodes and
 *  the search hands back 128), so a link that has to name 第 131 集 asks for that number instead of indexing
 *  past the end of a list that never reaches it. */
export async function episodeAt(animeTitle: string, animeId: string, episode: number): Promise<DanmakuEpisode | null> {
  const asked = await firstAnswer(src => searchEpisodes(src, { anime: animeTitle, episode: String(episode) }));
  if (!asked) return null;
  const animes = asked.value;
  const hit = animes.find(a => String(a.animeId) === animeId) || animes[0];
  const e = hit?.episodes?.[0];
  return e ? { id: String(e.episodeId), title: e.episodeTitle || '' } : null;
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
