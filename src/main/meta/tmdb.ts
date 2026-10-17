import { app, net } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as config from '../config';
import type { TmdbCreditRow, TmdbCredits, TmdbMeta, TmdbSeasonRow, TmdbSimilar, TmdbStills } from '../../shared/types';

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
const SIMILAR_TTL = 7 * DAY;
/** Backdrops for the 剧照 strip age as lazily as the recommendation list does, under their own name. */
const IMAGES_TTL = 7 * DAY;
/** A miss is usually TMDB having no record for that id; asking again in a few days is cheap. */
const MISS_TTL = 3 * DAY;
/* Bump whenever the shape of a stored `meta` entry changes, so a table cached by an older build is
   refetched once instead of being served for the rest of `META_TTL`. A shape marker is needed rather than
   a field-presence test because some fields are written only when they carry something: a season TMDB
   rates at 0 and a season row mapped by a build that never read the rating are then the same object, and
   presence cannot tell them apart. */
const META_SCHEMA = 2;

type Kind = 'movie' | 'tv';
type MetaEntry = TmdbMeta | { missing: true; fetchedAt: number };
type StillsEntry = { value: TmdbStills; fetchedAt: number } | { missing: true; fetchedAt: number };
type CastEntry = { value: TmdbCredits; fetchedAt: number } | { missing: true; fetchedAt: number };

interface Store {
  /** key = `${kind}:${tmdbId}` */
  meta: Record<string, MetaEntry>;
  /** key = `tv:${tmdbId}/${season}` */
  stills: Record<string, StillsEntry>;
  /** key = `tv:${tmdbId}/${season}`; the season's own credit list, trimmed to what the band shows. */
  cast: Record<string, CastEntry>;
  /** key = `${kind}:${tmdbId}`; TMDB `/similar`, capped list of poster-only rows. */
  similar: Record<string, { value: TmdbSimilar[]; fetchedAt: number }>;
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
    next = { meta: {}, stills: {}, cast: {}, similar: {}, images: {}, logos: {}, ...JSON.parse(readFileSync(file(), 'utf8')) };
  } catch {
    next = { meta: {}, stills: {}, cast: {}, similar: {}, images: {}, logos: {} };
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

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

const hasHan = (s: string): boolean => /[一-鿿]/.test(s);

/** Jobs in the Writing department we count as authorship; production-side jobs (`Script Consultant`,
 *  `Script Supervisor`) are dropped because they do not name whoever wrote the story. */
const WRITER_JOBS = new Set([
  'Writer',
  'Screenplay',
  'Novel',
  'Characters',
  'Comic Book',
  'Original Film Writer',
  'Original Story',
  'Story',
  'Series Composition',
  'Scenario Writer',
  'Script',
]);

const pickWriters = (crew: any[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of crew) {
    if (c?.department !== 'Writing' || !WRITER_JOBS.has(c?.job)) continue;
    const name = String(c?.name || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= 3) break;
  }
  return out;
};

/** TMDB's season table, trimmed to what a season page can show: its own date, art, size and synopsis.
 *  Rows are capped because one library here files a season per 季 of a long-running show, and a kept
 *  synopsis costs ~200 bytes a row. */
const SEASON_ROWS_CAP = 80;

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
 *  matters because only the former should be cached as a miss. */
const fetchJson = async <T>(url: string, cred: string): Promise<{ json: T | null; answered: boolean }> => {
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
    if (!res.ok) return { json: null, answered: res.status === 404 };
    const text = await res.text();
    try {
      return { json: JSON.parse(text) as T, answered: true };
    } catch {
      // Truncated proxy responses land here; treat as unanswered so we retry next open.
      return { json: null, answered: false };
    }
  } catch {
    return { json: null, answered: false };
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
    write: creditRows(crew.filter((r) => r?.department === 'Writing'), '编剧', CREDIT_CREW_CAP),
  };
};

const metaHit = (key: string): { state: 'miss' } | { state: 'cold' } | { state: 'fresh'; value: TmdbMeta } => {
  const hit = load().meta[key];
  if (!hit) return { state: 'cold' };
  if (Date.now() - hit.fetchedAt >= ('missing' in hit ? MISS_TTL : META_TTL)) return { state: 'cold' };
  /* A recorded miss is its own state because `tmdbMeta` reads a null as 「go and ask」. Without it, a title
     TMDB genuinely does not have costs a request on every open instead of one per MISS_TTL. */
  if ('missing' in hit) return { state: 'miss' };
  /* `schema` is the one staleness test. It replaces a run of presence checks (`originalLanguage`,
     `overviewOther`, `seasons`, `cast`), each of which only worked while its field was written every
     time — see `META_SCHEMA`. An entry from before the marker refetches once and is then rewritten with
     it. */
  return hit.schema === META_SCHEMA ? { state: 'fresh', value: hit } : { state: 'cold' };
};

/** Returns the metadata TMDB has for one title, or null when TMDB does not (or no key is configured). */
export async function tmdbMeta(kind: Kind, tmdbId: string): Promise<TmdbMeta | null> {
  if (!/^\d{1,8}$/.test(tmdbId)) return null;
  const token = tmdbToken();
  if (!token) return null;
  const key = `${kind}:${tmdbId}`;
  const hit = metaHit(key);
  if (hit.state === 'miss') return null;
  /* A `0` written before the pickers below refused it would otherwise hold a badge open for the rest of
     the TTL, so the read path refuses it too. */
  if (hit.state === 'fresh')
    return hit.value.cert === '0' ? { ...hit.value, cert: '' } : hit.value;

  const base = `https://api.themoviedb.org/3/${kind}/${tmdbId}`;
  /* `credits` comes along for both kinds because the writers the credit band falls back to are inside it.
     The certification half is asked per kind: a movie's rating is read off `release_dates`, a show's off
     `content_ratings`, and neither has a use for the other. */
  const q = `?language=zh-CN&append_to_response=${kind === 'movie' ? 'credits,release_dates' : 'credits,content_ratings'}`;
  const { json, answered } = await fetchJson<any>(base + q, token);
  const s = load();
  if (!answered) return null;
  if (!json || json.status_code === 7 || json.success === false) {
    s.meta[key] = { missing: true, fetchedAt: Date.now() };
    persist();
    return null;
  }
  const out: TmdbMeta = {
    schema: META_SCHEMA,
    fetchedAt: Date.now(),
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
  return out;
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

const sameSeason = (a: TmdbStills, b: TmdbStills): boolean => {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => a[+k] === b[+k]);
};

/** Returns the season's episode stills; an empty map (still `answered`) is a normal reply, and null means
 *  this season was not asked, is not on TMDB, or is waiting out a recorded miss. */
export async function tmdbSeasonStills(tmdbId: string, season: number): Promise<TmdbStills | null> {
  if (!/^\d{1,8}$/.test(tmdbId) || !Number.isInteger(season) || season < 0 || season > 500) return null;
  const token = tmdbToken();
  if (!token) return null;
  const key = `tv:${tmdbId}/${season}`;
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
    const p = typeof ep?.still_path === 'string' ? ep.still_path : '';
    if (n !== undefined && p) next[n] = p;
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
  const key = `tv:${tmdbId}/${season}`;
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

const SIMILAR_CAP = 12;

/** The `/similar` list for one title, as poster-only rows. These cannot be resolved back into the
 *  library (they are outside ids), so the strip is a read-only "more like this", never a link. */
export async function tmdbSimilar(kind: Kind, tmdbId: string): Promise<TmdbSimilar[]> {
  if (!/^\d{1,8}$/.test(tmdbId)) return [];
  const token = tmdbToken();
  if (!token) return [];
  const key = `${kind}:${tmdbId}`;
  const s = load();
  const hit = s.similar[key];
  if (hit && Date.now() - hit.fetchedAt < SIMILAR_TTL) return hit.value;

  const { json, answered } = await fetchJson<any>(
    `https://api.themoviedb.org/3/${kind}/${tmdbId}/similar?language=zh-CN`,
    token,
  );
  // No answer or an empty list both keep the previous value (or nothing); never cache a transport miss.
  if (!answered) return hit?.value || [];
  const results: any[] = Array.isArray(json?.results) ? json.results : [];
  const out: TmdbSimilar[] = [];
  for (const r of results) {
    const id = num(r?.id);
    if (id === undefined) continue;
    const v = num(r?.vote_average);
    const date = String(r?.release_date || r?.first_air_date || '');
    out.push({
      tmdbId: id,
      title: String(r?.title || r?.name || '').trim(),
      posterPath: typeof r?.poster_path === 'string' ? r.poster_path : undefined,
      year: /^\d{4}/.test(date) ? date.slice(0, 4) : undefined,
      voteAverage: v !== undefined ? Math.round(v * 10) / 10 : undefined,
    });
    if (out.length >= SIMILAR_CAP) break;
  }
  const prev = hit?.value;
  if (!prev || prev.length !== out.length || prev.some((p, i) => p.tmdbId !== out[i].tmdbId)) {
    s.similar[key] = { value: out, fetchedAt: Date.now() };
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
  const film = (await tmdbMeta(kind, tmdbId))?.originalLanguage || '';
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
