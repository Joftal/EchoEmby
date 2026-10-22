import { app, net } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as config from '../config';
import type { TmdbCreditRow, TmdbCredits, TmdbEpisodeRow, TmdbMeta, TmdbSeasonRow, TmdbRelated, TmdbStills } from '../../shared/types';

/**
 * TMDB is the outside source with a real API and a Chinese locale, so it fills the four gaps Emby
 * leaves on this library: overview text for Asian titles, writing credits (server People has 0
 * writers in the sample), parental guidance for items with no OfficialRating, and episode stills
 * for cards the server returns without a Primary tag. Keys come from `config.meta.tmdbV4Token`,
 * which is DPAPI-encrypted at rest; missing keys simply disable the merge and the UI falls back.
 */

const DAY = 86_400_000;
const META_TTL = 30 * DAY;
const STILLS_TTL = 14 * DAY;
/** A season's crew is re-billed only when the season itself changes, which is on the same clock as its
 *  stills — but on its own name, so tuning the picture strip cannot silently retune the credit band. */
const CAST_TTL = 14 * DAY;
/** A recommendation list drifts slowly; a week keeps it fresh without a request on every open. */
const RELATED_TTL = 7 * DAY;
/** Backdrops for the 剧照 strip age as lazily as the recommendation list does, under their own name. */
const IMAGES_TTL = 7 * DAY;
/** A miss is usually TMDB having no record for that id; asking again in a few days is cheap. */
const MISS_TTL = 3 * DAY;
/* Bump whenever the shape of a stored `meta` entry changes, so a table cached by an older build is
   refetched once instead of being served for the rest of `META_TTL`. A shape marker is needed rather than
   a field-presence test because some fields are written only when they carry something: a season TMDB
   rates at 0 and a season row mapped by a build that never read the rating are then the same object, and
   presence cannot tell them apart. Schema 3 added the work's own identity - its name, year, poster,
   genres and length - because a title this server does not hold has no row to be billed from, and the page
   for it can only be built out of what TMDB's own reply carries. */
const META_SCHEMA = 3;

type Kind = 'movie' | 'tv';
type MetaEntry = TmdbMeta | { missing: true; fetchedAt: number };
type StillsEntry = { value: TmdbStills; fetchedAt: number } | { missing: true; fetchedAt: number };
type CastEntry = { value: TmdbCredits; fetchedAt: number } | { missing: true; fetchedAt: number };
type RelatedEntry = { value: TmdbRelated[]; fetchedAt: number };

interface Store {
  /** key = `${kind}:${tmdbId}` */
  meta: Record<string, MetaEntry>;
  /** key = `tv5:${tmdbId}/${season}`; the `5` is the episode rows' own shape — before `2` a row was a bare
   *  picture path with no synopsis, before `3` it carried no episode title, before `4` no air date and
   *  before `5` no running time. A shape test at read time would be longer than a refetch: the old rows
   *  simply never carry those fields, so the per-episode pairing that reads one would silently never fire
   *  on a season fetched before it existed. */
  stills: Record<string, StillsEntry>;
  /** key = `c2:tv:${tmdbId}/${season}`; the season's own credit list, trimmed to what the band shows. The `2`
   *  marks the list trimmed by the single writer predicate: entries from before it carry the whole Writing
   *  department, and the job that decided it is not stored, so they cannot be re-filtered. */
  cast: Record<string, CastEntry>;
  /** Both look-alike lists merged, capped, keyed by the shape marker explained where the list is built. */
  related: Record<string, RelatedEntry>;
  /** key = `${kind}:${tmdbId}`; image.tmdb.org backdrop paths for the 剧照 strip. */
  images: Record<string, { value: string[]; fetchedAt: number }>;
  /** key = `${kind}:${tmdbId}`; the page's title treatments, unranked — the order depends on the work's
   *  own language, which is asked for at read time. */
  logos: Record<string, { value: LogoRow[]; fetchedAt: number }>;
}

const file = () => path.join(app.getPath('userData'), 'tmdb.json');
let store: Store | null = null;

const load = (): Store => {
  if (store) return store;
  let next: Store;
  try {
    next = { meta: {}, stills: {}, cast: {}, related: {}, images: {}, logos: {}, ...JSON.parse(readFileSync(file(), 'utf8')) };
  } catch {
    next = { meta: {}, stills: {}, cast: {}, related: {}, images: {}, logos: {} };
  }
  let pruned = false;
  /* The bucket was named for one of the two lists it now reads. Builds before `r2` keyed their rows by
     plain `${kind}:${tmdbId}`, so every one of those entries is an answer about a list this function no longer
     asks for and the read below can never reach it. Move the rows the marker does claim, drop the rest, and
     write once so the dead weight leaves the file instead of being re-read at every launch. */
  const legacy = next as Store & { similar?: Record<string, RelatedEntry> };
  if (legacy.similar) {
    for (const [k, v] of Object.entries(legacy.similar)) if (k.startsWith('r2:')) next.related[k] = v;
    delete legacy.similar;
    pruned = true;
  }
  /* Rows older than the current shape marker are dropped rather than read: `tv3:` predates the episode air
     date and `tv4:` predates its running time, and those two fields are what the per-episode pairing and
     the empty-slot fallbacks read, so an old row can never satisfy them. Dropping costs one refetch per
     season the user opens again and takes the dead weight out of the file — a row's synopsis alone is 479
     of its 546 bytes. */
  for (const k of Object.keys(next.stills)) {
    if (!k.startsWith('tv5:')) {
      delete next.stills[k];
      pruned = true;
    }
  }
  store = next;
  if (pruned) persist();
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

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

const hasHan = (s: string): boolean => /[一-鿿]/.test(s);

/* The Writing-department jobs that name whoever ran the script desk, not whoever wrote the story. Measured
   over 22 seasons here: the department answers nine job shapes — `Original Story` x8, `Comic Book` x7,
   `Screenplay` x3, `Series Composition` x2, `Executive Story Editor` x2, `Writer`, `Story Editor`,
   `Staff Writer`, `Other` — and not one of them is a desk job. An allowlist of the authorship names cost 4
   of those 26 rows, which is every writer one show's three seasons are credited with, so the test runs the
   other way: believe the department, drop these. */
const NOT_WRITERS = new Set([
  'Script Supervisor',
  'Script Consultant',
  'Script Coordinator',
  'Script Continuity',
]);

/* Both writer surfaces answer to this one predicate. They used to disagree — the work-level list kept only
   the jobs it recognised, the season band took the whole department — so one title could be billed two sets
   of 编剧 depending on which path filled its band. */
const isWriter = (r: any): boolean => r?.department === 'Writing' && !NOT_WRITERS.has(String(r?.job || ''));

const pickWriters = (crew: any[]): string[] =>
  creditRows(
    (Array.isArray(crew) ? crew : []).filter(isWriter),
    '',
    3,
  ).map((r) => r.name);

/** TMDB's season table, trimmed to what a season page can show: its own date, art, size and synopsis.
 *  Rows are capped because one library here files a season per 季 of a long-running show, and a kept
 *  synopsis costs ~200 bytes a row. */
const SEASON_ROWS_CAP = 80;

/** TMDB's four-digit year, read off whichever date the kind files its premiere under. 0 when it has not
   dated the work: a page that prints 「0」 where a year belongs is worse than one that prints no year. */
const yearOf = (date: unknown): number => {
  const s = String(date ?? '');
  return /^\d{4}/.test(s) ? Number(s.slice(0, 4)) : 0;
};

const seasonTable = (rows: any[] | undefined): TmdbSeasonRow[] => {
  const out: TmdbSeasonRow[] = [];
  for (const r of rows || []) {
    const n = num(r?.season_number);
    if (n === undefined) continue;
    const ov = typeof r?.overview === 'string' ? r.overview.trim() : '';
    const name = typeof r?.name === 'string' ? r.name.trim() : '';
    const row: TmdbSeasonRow = {
      n,
      epCount: num(r?.episode_count) || 0,
      airDate: typeof r?.air_date === 'string' ? r.air_date : '',
      poster: typeof r?.poster_path === 'string' ? r.poster_path : '',
    };
    const vote = num(r?.vote_average);
    if (vote) row.voteAverage = Math.round(vote * 10) / 10;
    if (name) row.name = name;
    if (ov && hasHan(ov)) row.ovZh = ov;
    else if (ov) row.ovOther = ov;
    out.push(row);
    if (out.length >= SEASON_ROWS_CAP) break;
  }
  return out;
};

/** `answered` distinguishes "TMDB says this id does not exist" from "TMDB did not reply", which
 *  matters because only the former should be cached as a miss. `why` names what to blame for the
 *  silence; it only ever reaches the log, through ipc.ts's detail(), because the mapped sentence a
 *  caller sees must not pretend to know the user's own server broke. */
const fetchJson = async <T>(url: string, cred: string): Promise<{ json: T | null; answered: boolean; why: string }> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  /* TMDB has two credentials and they do not interchange: a v4 read token is a JWT and only the
     Authorization header accepts it, a v3 key is 32 hex and only the `api_key` parameter accepts it.
     One settings field takes either, so the shape picks the transport. */
  const v4 = cred.split('.').length === 3;
  const at = v4
    ? url
    : url + (url.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(cred);
  try {
    const res = await net.fetch(at, {
      headers: v4 ? { Authorization: `Bearer ${cred}`, Accept: 'application/json' } : { Accept: 'application/json' },
      signal: ctrl.signal,
    });
    /* Only a 404 is TMDB answering 「no such title」. Every other bad status is silence, not an answer:
       401/403 means our own key is wrong, 429 means we are being throttled, and a 5xx — or the empty 502
       this machine's proxy paints over a failed lookup — means the request never got through. Recording
       any of those as a miss would hide a title's whole season for MISS_TTL. */
    if (!res.ok) return { json: null, answered: res.status === 404, why: `HTTP ${res.status}` };
    const text = await res.text();
    try {
      return { json: JSON.parse(text) as T, answered: true, why: '' };
    } catch {
      // Truncated proxy responses land here; treat as unanswered so we retry next open.
      return { json: null, answered: false, why: '回应的 JSON 是截断的' };
    }
  } catch (e) {
    return { json: null, answered: false, why: `${(e as any)?.name || 'Error'}: ${(e as any)?.message ?? e}` };
  } finally {
    clearTimeout(timer);
  }
};

const tmdbToken = (): string | null => config.get().meta?.tmdbV4Token || null;

/* One department array, three lists. Measured over 8 seasons: 鬼灭之刃's S1 carries 51 crew rows of which
   25 are Visual Effects while its `cast` holds one person, so only the departments the band has a label
   for survive the trip. The caps are what keep a 68-row movie page (`007` answers 62 cast rows) from
   costing the cache more than a 12-row season. */
const CREDIT_ACT_CAP = 24;
const CREDIT_CREW_CAP = 4;

const creditRows = (rows: any[] | undefined, sub: string | ((r: any) => string), cap: number): TmdbCreditRow[] => {
  const out: TmdbCreditRow[] = [];
  const seen = new Set<string>();
  for (const r of rows || []) {
    const name = typeof r?.name === 'string' ? r.name.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, sub: typeof sub === 'string' ? sub : String(sub(r) || '').trim(), img: typeof r?.profile_path === 'string' ? r.profile_path : '' });
    if (out.length >= cap) break;
  }
  return out;
};

/** From anything shaped like a `credits` answer — a season's, or a movie's appended onto the title. */
const creditPack = (c: any): TmdbCredits => {
  const crew: any[] = Array.isArray(c?.crew) ? c.crew : [];
  return {
    act: creditRows(c?.cast, (r) => String(r?.character || ''), CREDIT_ACT_CAP),
    dir: creditRows(crew.filter((r) => r?.department === 'Directing'), '导演', CREDIT_CREW_CAP),
    write: creditRows(crew.filter(isWriter), '编剧', CREDIT_CREW_CAP),
  };
};

const metaHit = (key: string): { state: 'miss' } | { state: 'cold' } | { state: 'fresh'; value: TmdbMeta } => {
  const hit = load().meta[key];
  if (!hit) return { state: 'cold' };
  if (Date.now() - hit.fetchedAt >= ('missing' in hit ? MISS_TTL : META_TTL)) return { state: 'cold' };
  /* A recorded miss is its own state because `tmdbMeta`'s null now reads as 「TMDB has nothing」: without it,
     a title TMDB genuinely does not have would cost a request on every open instead of one per MISS_TTL. */
  if ('missing' in hit) return { state: 'miss' };
  /* `schema` is the one staleness test. It replaces a run of presence checks (`originalLanguage`,
     `overviewOther`, `seasons`, `cast`), each of which only worked while its field was written every
     time — see `META_SCHEMA`. An entry from before the marker refetches once and is then rewritten with
     it. */
  return hit.schema === META_SCHEMA ? { state: 'fresh', value: hit } : { state: 'cold' };
};

/** One trip per title for the asks that arrive while it is still out. The disk entry is only written when a
 *  fetch answers, so a card's ★ and the work page that same card opens a moment later each pay for the title
 *  twice — and the hover prefetch, which starts the ask early, would gain nothing if the page it opens simply
 *  sent a second one. */
const inflight = new Map<string, Promise<TmdbMeta | null>>();

/** Returns the metadata TMDB has for one title, or null when TMDB does not (or no key is configured). */
export async function tmdbMeta(kind: Kind, tmdbId: string): Promise<TmdbMeta | null> {
  if (!/^\d{1,8}$/.test(tmdbId)) return null;
  const token = tmdbToken();
  if (!token) return null;
  const key = `${kind}:${tmdbId}`;
  const hit = metaHit(key);
  if (hit.state === 'miss') return null;
  if (hit.state === 'fresh') return served(hit.value);
  const running = inflight.get(key);
  if (running) return running;
  const out = fetchMeta(kind, tmdbId, token, key).finally(() => inflight.delete(key));
  inflight.set(key, out);
  return out;
}

async function fetchMeta(kind: Kind, tmdbId: string, token: string, key: string): Promise<TmdbMeta | null> {
  const base = `https://api.themoviedb.org/3/${kind}/${tmdbId}`;
  /* `credits` comes along for both kinds because the writers the credit band falls back to are inside it.
     The certification half is asked per kind: a movie's rating is read off `release_dates`, a show's off
     `content_ratings`, and neither has a use for the other. */
  const q = `?language=zh-CN&append_to_response=${kind === 'movie' ? 'credits,release_dates' : 'credits,content_ratings'}`;
  const { json, answered, why } = await fetchJson<any>(base + q, token);
  const s = load();
  /* Thrown instead of returned as null: a null that reaches a card now means TMDB answered and has nothing
     to say, which is the one thing a badge may print the server's number over. Silence is not that answer,
     and holding it as one cost a title its whole caption for the rest of the session on a single lost
     request. */
  if (!answered) throw new Error(`TMDB 没有答上（${why}）`);
  if (!json || json.status_code === 7 || json.success === false) {
    s.meta[key] = { missing: true, fetchedAt: Date.now() };
    persist();
    return null;
  }
  const out: TmdbMeta = {
    schema: META_SCHEMA,
    fetchedAt: Date.now(),
    name: String(json.name || json.title || '').trim(),
    year: yearOf(json.first_air_date || json.release_date),
    poster: typeof json.poster_path === 'string' ? json.poster_path : '',
    genres: (Array.isArray(json.genres) ? json.genres : [])
      .map((g: any) => String(g?.name || '').trim())
      .filter(Boolean),
    runtime: Math.max(0, Math.round(num(json.runtime) || 0)),
    originalLanguage: String(json.original_language || '').toLowerCase(),
    seasons: seasonTable(json.seasons),
    /* The actor list is kept for a movie only, because that is the one page that reads it; a show's band
       is billed season by season, and the appended `credits` is still walked here for its writers. */
    cast: kind === 'movie' ? creditPack(json.credits) : { act: [], dir: [], write: [] },
  };
  const ov = typeof json.overview === 'string' ? json.overview.trim() : '';
  /* Both halves of the synopsis ladder are written every time, the non-Chinese one even when empty, so a
     title TMDB has no text for stays cached instead of being re-asked on every open. */
  if (ov && hasHan(ov)) out.overviewZh = ov;
  out.overviewOther = ov;
  const v = num(json.vote_average);
  /* Only a rating somebody actually cast counts: TMDB answers 0 votes and an empty average for a title
     nobody rated. `vote_count` is read as that gate and then dropped — no surface shows the number. */
  if (v !== undefined && (num(json.vote_count) || 0) > 0) out.voteAverage = Math.round(v * 10) / 10;
  const writers = pickWriters(json.credits?.crew || []);
  if (writers.length) out.writers = writers;
  const cert = kind === 'movie' ? pickMovieCert(json.release_dates?.results) : pickTvCert(json.content_ratings?.results);
  if (cert) out.cert = cert;
  s.meta[key] = out;
  persist();
  return served(out);
}

/* Germany files what any child may watch under the number 0, and a badge that reads 「0」 looks like a
   broken rating rather than like no restriction, so neither picker below lets it through — and the read
   path refuses one already sitting on disk from an older build. */

/** Prefers the US certification; the earliest-named country with any cert is the fallback. */
const pickMovieCert = (results: any[] | undefined): string | undefined => {
  if (!Array.isArray(results)) return undefined;
  const us = results.find(r => r?.iso_3166 === 'US');
  const from = (list: any[] | undefined): string | undefined =>
    (list || []).map(x => String(x?.certification || '').trim()).find(x => x && x !== '0');
  return (us && from(us.release_dates)) || results.map(r => from(r?.release_dates)).find(Boolean);
};

const pickTvCert = (results: any[] | undefined): string | undefined => {
  if (!Array.isArray(results)) return undefined;
  const us = results.find(r => r?.iso_3166 === 'US');
  if (us?.rating && us.rating !== '0') return String(us.rating);
  const first = results.find(r => r?.rating && r.rating !== '0');
  return first ? String(first.rating) : undefined;
};

/** The families a Chinese viewer reads without help: the MPAA letters and the one `TV-` series the server
 *  itself files. Every other shape below is a foreign board's code. */
const READABLE_CERT = /^(G|PG|PG-?13|R|NC-?17|AP|TV-Y(-?7)?|TV-G|TV-PG|TV-14|TV-MA|TV-A)$/;

/* Measured over the 213 titles this library has a cert for on disk: 64 answers are in the family above, 74
   are a bare age (`12`, `16`, `19`), 48 are an age wearing a country's uniform (`+13`, `MA 15+`, `M18`,
   `NC16`, `U/A 16+`, `12A`) and 27 carry no number a badge could print (`M`, `ATP`, `NR`, `L`, `IIB`, `0`) —
   43 distinct strings for what is one question. TMDB files a work under whichever country answers first, so
   which of those a title lands on is not a property of the work. */
/** What a badge may print: the readable family verbatim, any other age as 「N+」 like the 番剧 mark already
 *  does, and nothing for a code that carries no number — that hole is the server's to fill. Applied on every
 *  read instead of at write so tuning it reaches the entries already on disk without a refetch. */
const readableCert = (raw?: string): string => {
  const v = (raw || '').trim();
  if (!v || v === '0') return '';
  if (READABLE_CERT.test(v)) return v;
  const n = Number(v.match(/\d+/)?.[0]);
  return n > 0 && n <= 25 ? `${n}+` : '';
};

const served = (m: TmdbMeta): TmdbMeta => ({ ...m, cert: readableCert(m.cert) });

const sameSeason = (a: TmdbStills, b: TmdbStills): boolean => {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => {
    const x = a[+k];
    const y = b[+k];
    return !!y && x.p === y.p && x.ovZh === y.ovZh && x.ovOther === y.ovOther && x.nZh === y.nZh && x.nOther === y.nOther && x.air === y.air && x.rt === y.rt;
  });
};

/** Returns what TMDB bills for one season's episodes — each episode's still, its own title, line, air date
 *  and running time; an empty map (still `answered`) is a normal reply, and null means this season was not
 *  asked, is not on TMDB, or is waiting out a recorded miss. */
export async function tmdbSeasonStills(tmdbId: string, season: number): Promise<TmdbStills | null> {
  if (!/^\d{1,8}$/.test(tmdbId) || !Number.isInteger(season) || season < 0 || season > 500) return null;
  const token = tmdbToken();
  if (!token) return null;
  const key = `tv5:${tmdbId}/${season}`;
  const s = load();
  const hit = s.stills[key];
  if (hit && Date.now() - hit.fetchedAt < ('missing' in hit ? MISS_TTL : STILLS_TTL)) {
    if ('missing' in hit) return null;
    return hit.value;
  }
  const { json, answered } = await fetchJson<any>(
    `https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}?language=zh-CN`,
    token,
  );
  if (!answered) return null;
  if (!json || !Array.isArray(json.episodes)) {
    s.stills[key] = { missing: true, fetchedAt: Date.now() };
    persist();
    return null;
  }
  const next: TmdbStills = {};
  for (const ep of json.episodes) {
    const n = num(ep?.episode_number);
    if (n === undefined) continue;
    const p = typeof ep?.still_path === 'string' ? ep.still_path : '';
    /* The episode's own paragraph rides the same reply as its still and used to be thrown away, and the
       title below rides it for the same reason. Both are held in the two halves the rest of the ladder
       uses, because `language=zh-CN` answers in Chinese only where TMDB has a Chinese record — the rest
       comes back in the work's own language, which still beats a blank line or a bare number. Measured on
       UTF-8 bytes over the 210 episode rows this library has refetched since the shape changed: 546 a row,
       of which the synopsis takes 479, the title 24 and the picture path 33 — ~14 KB for a 26-episode
       season, ~106 KB for a 195-episode one. */
    const ov = typeof ep?.overview === 'string' ? ep.overview.trim() : '';
    /* This is the one field the page had nowhere else to get a real name from: the server's row calls 235
       of its 1437 episodes 「第 2 集」, and TMDB's own answer is the only place a title exists. It is
       the cheap half of the reply — 24 of the 546 bytes a row costs. No positional filter here: a name
       that only repeats the number is dropped by `episodeHead`, the one rule every name source passes
       through, so a stored row says what TMDB billed rather than what this build concluded. 209 of the
       210 rows cached now came back in Chinese; the one that did not is 「Big Boss」, so the other half has
       already spoken once, for a title this library would otherwise have printed as a bare number. */
    const nm = typeof ep?.name === 'string' ? ep.name.trim() : '';
    /* The date costs 18 bytes a row and is the only field on this row that can identify the episode rather
       than describe it, so it is kept even when TMDB has neither a picture nor a line for the episode. */
    const air = typeof ep?.air_date === 'string' ? ep.air_date.trim() : '';
    /* Thrown away until now on a written belief that TMDB does not bill a length per episode; it does, for
       155 of the 204 rows measured across 12 seasons, and it is the only length a card has when the server
       holds no file for that episode. Four bytes a row. */
    const rt = num(ep?.runtime);
    const row: TmdbEpisodeRow = { p };
    if (ov && hasHan(ov)) row.ovZh = ov;
    else if (ov) row.ovOther = ov;
    if (nm && hasHan(nm)) row.nZh = nm;
    else if (nm) row.nOther = nm;
    if (air) row.air = air;
    if (rt && rt > 0) row.rt = Math.round(rt);
    if (p || ov || nm || air || rt) next[n] = row;
  }
  /* `language=zh-CN` answers an episode's line only where TMDB has one in Chinese or falls back to the work's
     own language, and it answers nothing for a large minority of rows: measured on the four thinnest seasons
     in this library's cache, 48 of 88 rows came back with no line and 29 of those have one in English
     (Cowboy Bebop's 第 1 季: 0 of 23 in Chinese, 23 of 23 in English). So ask the same season once more in
     en-US, and only for a reply that would otherwise store an empty line, and fill just those. One extra
     request per season that needs it, cached with the rest for 14 days. */
  if (Object.values(next).some(r => !r.ovZh && !r.ovOther)) {
    const en = await fetchJson<any>(
      `https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}?language=en-US`,
      token,
    );
    for (const ep of en.json?.episodes || []) {
      const n = num(ep?.episode_number);
      const line = typeof ep?.overview === 'string' ? ep.overview.trim() : '';
      const row = n === undefined ? undefined : next[n];
      if (!row || !line || row.ovZh || row.ovOther) continue;
      if (hasHan(line)) row.ovZh = line;
      else row.ovOther = line;
    }
  }
  const prev: TmdbStills | undefined = hit && !('missing' in hit) ? hit.value : undefined;
  // Do not rewrite the file if nothing changed — the file is shared with the meta map.
  if (!prev || !sameSeason(prev, next)) {
    s.stills[key] = { value: next, fetchedAt: Date.now() };
    persist();
  }
  return next;
}

/* The season detail endpoint carries no cast at all — measured, its keys are id, _id, air_date,
   episodes, name, networks, overview, poster_path, season_number, vote_average — so the credits have
   to be asked for by name. The dedicated season credits route is the cheap way: 1.4-16.5 KB against
   the 24 KB-2.1 MB a season detail costs, and it answers 404 rather than empty for a season TMDB
   does not have, which is what the miss entry below is for. */
/** The three lists the cast band shows for one season, in TMDB's own billing order. */
export async function tmdbSeasonCast(tmdbId: string, season: number): Promise<TmdbCredits | null> {
  if (!/^\d{1,8}$/.test(tmdbId) || !Number.isInteger(season) || season < 0 || season > 500) return null;
  const token = tmdbToken();
  if (!token) return null;
  const key = `c2:tv:${tmdbId}/${season}`;
  const s = load();
  const hit = s.cast[key];
  if (hit && Date.now() - hit.fetchedAt < ('missing' in hit ? MISS_TTL : CAST_TTL)) {
    return 'missing' in hit ? null : hit.value;
  }
  const { json, answered } = await fetchJson<any>(
    `https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}/credits?language=zh-CN`,
    token,
  );
  if (!answered) return null;
  if (!json || (!Array.isArray(json.cast) && !Array.isArray(json.crew))) {
    s.cast[key] = { missing: true, fetchedAt: Date.now() };
    persist();
    return null;
  }
  const value = creditPack(json);
  s.cast[key] = { value, fetchedAt: Date.now() };
  persist();
  return value;
}

/* TMDB answers "what is like this title" with two different lists, and measured over 18 sampled bands
   their first twelve rows do not share a single title (overlap 0.0). They are also not one's better half:
   on OkEmby /similar places 34 rows this account can play and /recommendations places 67, and the merged
   list carries 101 — the exact sum, because nothing is duplicated. So both are asked, in one pass, and the
   band is built out of the pair. */
const RELATED_CAP_EACH = 12;
const RELATED_CAP = 24;

/** Both look-alike lists for one title: name, the name in its own language, year, poster, TMDB's own
 *  rating and how many people stand behind that rating. The renderer resolves these back into the library
 *  and links every row somewhere, so the row needs no server id of its own.
 *
 *  The original-language name travels because the search that resolves a row is a title search, and this
 *  library files shows under Chinese spellings that are not TMDB's. Measured on the live route: TMDB bills
 *  tv:121792 as 「明日酱的水手服」, and on the account that holds it that spelling answers zero rows while
 *  the work's own name 明日ちゃんのセーラー服 answers its row, filed as 「明日同学的水手服」. */
export async function tmdbRelated(kind: Kind, tmdbId: string): Promise<TmdbRelated[]> {
  if (!/^\d{1,8}$/.test(tmdbId)) return [];
  const token = tmdbToken();
  if (!token) return [];
  /* `r2` marks the merged list and the original-language name. Neither can be caught by looking for a
     field: a Chinese title's original name legitimately equals its own, and a one-list cache is otherwise
     a well-shaped list of rows that happen to be the wrong half of the answer. */
  const key = `r2:${kind}:${tmdbId}`;
  const s = load();
  const hit = s.related[key];
  if (hit && Date.now() - hit.fetchedAt < RELATED_TTL) return hit.value;

  const [sim, reco] = await Promise.all([
    fetchJson<any>(`https://api.themoviedb.org/3/${kind}/${tmdbId}/similar?language=zh-CN`, token),
    fetchJson<any>(`https://api.themoviedb.org/3/${kind}/${tmdbId}/recommendations?language=zh-CN`, token),
  ]);
  // Silence from both is not absence: keep whatever was cached and never store a transport miss.
  if (!sim.answered && !reco.answered) return hit?.value || [];
  const out: TmdbRelated[] = [];
  const seen = new Set<number>();
  for (const res of [sim, reco]) {
    const results: any[] = Array.isArray(res.json?.results) ? res.json.results : [];
    let taken = 0;
    for (const r of results) {
      if (taken >= RELATED_CAP_EACH || out.length >= RELATED_CAP) break;
      const id = num(r?.id);
      if (id === undefined || seen.has(id)) continue;
      const title = String(r?.title || r?.name || '').trim();
      if (!title) continue;
      const orig = String(r?.original_title || r?.original_name || '').trim();
      const v = num(r?.vote_average);
      const date = String(r?.release_date || r?.first_air_date || '');
      const cast = Math.max(0, Math.round(num(r?.vote_count) ?? 0));
      taken++;
      seen.add(id);
      out.push({
        tmdbId: id,
        title,
        originalTitle: orig && orig !== title ? orig : undefined,
        posterPath: typeof r?.poster_path === 'string' ? r.poster_path : undefined,
        year: /^\d{4}/.test(date) ? date.slice(0, 4) : undefined,
        // The gate the work's own entry already applies: a number nobody cast is not a rating, and a card
        // that prints one while the page it opens withholds it is the same title wearing two answers.
        voteAverage: v !== undefined && cast > 0 ? Math.round(v * 10) / 10 : undefined,
        votes: cast,
      });
    }
  }
  // Both lists empty against a cached answer is TMDB having nothing to say, not a better answer: keep the
  // rows rather than replace them with a hole that lasts a week.
  if (!out.length && hit?.value?.length) return hit.value;
  const prev = hit?.value;
  if (!prev || prev.length !== out.length || prev.some((p, i) => p.tmdbId !== out[i].tmdbId)) {
    s.related[key] = { value: out, fetchedAt: Date.now() };
    persist();
  }
  return out;
}

/** Backdrop image paths for the 剧照 strip, best-voted first. `include_image_language=en,null` is
 *  required: without it TMDB filters to the `language` locale's art and this library's Asian titles
 *  return zero backdrops. The strip is uncapped — the row scrolls sideways, so every backdrop earns its slot. */
export async function tmdbImages(kind: Kind, tmdbId: string): Promise<string[]> {
  if (!/^\d{1,8}$/.test(tmdbId)) return [];
  const token = tmdbToken();
  if (!token) return [];
  const key = `b2:${kind}:${tmdbId}`;
  const s = load();
  const hit = s.images[key];
  if (hit && Date.now() - hit.fetchedAt < IMAGES_TTL) return hit.value;

  const { json, answered } = await fetchJson<any>(
    `https://api.themoviedb.org/3/${kind}/${tmdbId}/images?include_image_language=en,null`,
    token,
  );
  if (!answered) return hit?.value || [];
  const list: any[] = Array.isArray(json?.backdrops) ? json.backdrops : [];
  const out = list
    .filter(b => typeof b?.file_path === 'string')
    .sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0))
    .map(b => String(b.file_path));
  const prev = hit?.value;
  if (!prev || prev.length !== out.length || prev.some((p, i) => p !== out[i])) {
    s.images[key] = { value: out, fetchedAt: Date.now() };
    persist();
  }
  return out;
}

/** A title's treatments barely change once the film is out, and a week keeps a re-cut logo from living
 *  in the hero forever. */
const LOGO_TTL = 7 * DAY;

/** One treatment as TMDB filed it. Chinese uploads all come back as `zh` in `iso_639_1`; what separates
 *  简体 from 繁体 is the region in `iso_3166_1` (measured on 玩具总动员5: nine `zh` treatments, two filed
 *  CN, five HK, two TW). Votes ride along so the ranking can run again at read time against whichever
 *  language the work turns out to be in. */
interface LogoRow {
  path: string;
  lang: string;
  cc: string;
  votes: number;
}

/** 简体中文 → 繁体中文 → 英文 → 影视本身的语言 → 其余. */
const logoTier = (l: LogoRow, film: string): number => {
  if (l.lang === 'zh') return l.cc === 'CN' ? 0 : 1;
  if (l.lang === 'en') return 2;
  if (film && l.lang === film) return 3;
  return 4;
};

const rankLogos = (rows: LogoRow[], film: string): string[] =>
  [...rows]
    .sort((a, b) => logoTier(a, film) - logoTier(b, film) || b.votes - a.votes)
    .slice(0, 8)
    .map(l => l.path);

export async function tmdbLogos(kind: Kind, tmdbId: string): Promise<string[]> {
  if (!/^\d{1,8}$/.test(tmdbId)) return [];
  const token = tmdbToken();
  if (!token) return [];
  const key = `${kind}:${tmdbId}`;
  const s = load();
  const hit = s.logos[key];
  /* The work's own language is the fourth tier, and Emby does not carry it (measured: this gateway
     returns no OriginalLanguage even when asked for it). TMDB's detail record does, and that request is
     already made and cached for the score badges, so asking here only costs on a cold title. */
  /* Only the work's own language is borrowed here, so a failed lookup must not empty the strip: the logo
     rows may already sit on disk and rank perfectly well without the fourth tier. */
  const film = (await tmdbMeta(kind, tmdbId).catch(() => null))?.originalLanguage || '';
  if (hit && Date.now() - hit.fetchedAt < LOGO_TTL) return rankLogos(hit.value, film);

  /* `include_image_language=zh,en` would be the cheap ask, but measured on this library it silently
     drops every other language — TMDB treats `null` as "no language", not as "all of them", so a title
     whose only treatment is Japanese comes back empty. `include_all_languages` costs 118 KB instead of
     59 KB on a 103-logo page, once a week per title. */
  const { json, answered } = await fetchJson<any>(
    `https://api.themoviedb.org/3/${kind}/${tmdbId}/images?include_all_languages=true`,
    token,
  );
  if (!answered) return hit ? rankLogos(hit.value, film) : [];
  const list: any[] = Array.isArray(json?.logos) ? json.logos : [];
  const out: LogoRow[] = list
    .filter(l => typeof l?.file_path === 'string')
    .map(l => ({
      path: String(l.file_path),
      lang: String(l.iso_639_1 || '').toLowerCase(),
      cc: String(l.iso_3166_1 || '').toUpperCase(),
      votes: Number(l.vote_count) || 0,
    }))
    .sort((a, b) => b.votes - a.votes)
    /* Held well above the eight that get shown: on a title whose older releases were all marketed in
       繁体, the lone 简体 treatment is often the least-voted upload, and a tight cap would delete it. */
    .slice(0, 24);
  const prev = hit?.value;
  if (!prev || prev.length !== out.length || prev.some((p, i) => p.path !== out[i].path)) {
    s.logos[key] = { value: out, fetchedAt: Date.now() };
    persist();
  }
  return rankLogos(out, film);
}
