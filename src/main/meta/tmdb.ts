import { app, net } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as config from '../config';
import type { TmdbMeta, TmdbStills } from '../../shared/types';

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
/** A miss is usually TMDB having no record for that id; asking again in a few days is cheap. */
const MISS_TTL = 3 * DAY;

type Kind = 'movie' | 'tv';
type MetaEntry = TmdbMeta | { missing: true; fetchedAt: number };
type StillsEntry = { value: TmdbStills; fetchedAt: number } | { missing: true; fetchedAt: number };

interface Store {
  /** key = `${kind}:${tmdbId}` */
  meta: Record<string, MetaEntry>;
  /** key = `tv:${tmdbId}/${season}` */
  stills: Record<string, StillsEntry>;
}

const file = () => path.join(app.getPath('userData'), 'tmdb.json');
let store: Store | null = null;

const load = (): Store => {
  if (store) return store;
  let next: Store;
  try {
    next = { meta: {}, stills: {}, ...JSON.parse(readFileSync(file(), 'utf8')) };
  } catch {
    next = { meta: {}, stills: {} };
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

/** `answered` distinguishes "TMDB says this id does not exist" from "TMDB did not reply", which
 *  matters because only the former should be cached as a miss. */
const fetchJson = async <T>(url: string, token: string): Promise<{ json: T | null; answered: boolean }> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await net.fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: ctrl.signal });
    if (res.status >= 500) return { json: null, answered: false };
    if (!res.ok) return { json: null, answered: true };
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

const cachedMeta = (key: string): TmdbMeta | null => {
  const hit = load().meta[key];
  if (!hit) return null;
  const ttl = 'missing' in hit ? MISS_TTL : META_TTL;
  if (Date.now() - hit.fetchedAt >= ttl) return null;
  return 'missing' in hit ? null : hit;
};

/** Returns the metadata TMDB has for one title, or null when TMDB does not (or no key is configured). */
export async function tmdbMeta(kind: Kind, tmdbId: string): Promise<TmdbMeta | null> {
  if (!/^\d{1,8}$/.test(tmdbId)) return null;
  const token = tmdbToken();
  if (!token) return null;
  const key = `${kind}:${tmdbId}`;
  const cached = cachedMeta(key);
  if (cached) return cached;

  const base = `https://api.themoviedb.org/3/${kind}/${tmdbId}`;
  const q = '?language=zh-CN&append_to_response=credits,release_dates,content_ratings';
  const { json, answered } = await fetchJson<any>(base + q, token);
  const s = load();
  if (!answered) return null;
  if (!json || json.status_code === 7 || json.success === false) {
    s.meta[key] = { missing: true, fetchedAt: Date.now() };
    persist();
    return null;
  }
  const out: TmdbMeta = { fetchedAt: Date.now() };
  const ov = typeof json.overview === 'string' ? json.overview.trim() : '';
  if (ov && hasHan(ov)) out.overviewZh = ov;
  const v = num(json.vote_average);
  const vc = num(json.vote_count);
  if (v !== undefined && vc !== undefined && vc > 0) {
    out.voteAverage = Math.round(v * 10) / 10;
    out.voteCount = vc;
  }
  const writers = pickWriters(json.credits?.crew || []);
  if (writers.length) out.writers = writers;
  const cert = kind === 'movie' ? pickMovieCert(json.release_dates?.results) : pickTvCert(json.content_ratings?.results);
  if (cert) out.cert = cert;
  s.meta[key] = out;
  persist();
  return out;
}

/** Prefers the US certification; the earliest-named country with any cert is the fallback. */
const pickMovieCert = (results: any[] | undefined): string | undefined => {
  if (!Array.isArray(results)) return undefined;
  const us = results.find(r => r?.iso_3166 === 'US');
  const from = (list: any[] | undefined): string | undefined =>
    (list || []).map(x => String(x?.certification || '').trim()).find(Boolean);
  return (us && from(us.release_dates)) || results.map(r => from(r?.release_dates)).find(Boolean);
};

const pickTvCert = (results: any[] | undefined): string | undefined => {
  if (!Array.isArray(results)) return undefined;
  const us = results.find(r => r?.iso_3166 === 'US');
  if (us?.rating) return String(us.rating);
  const first = results.find(r => r?.rating);
  return first ? String(first.rating) : undefined;
};

const sameSeason = (a: TmdbStills, b: TmdbStills): boolean => {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => a[+k] === b[+k]);
};

export interface SeasonStills {
  value: TmdbStills;
  /** True when TMDB has at least one episode still for this season. */
  any: boolean;
}

/** Returns the season's episode stills; empty map (still `answered`) is a normal reply. */
export async function tmdbSeasonStills(tmdbId: string, season: number): Promise<SeasonStills | null> {
  if (!/^\d{1,8}$/.test(tmdbId) || !Number.isInteger(season) || season < 0 || season > 500) return null;
  const token = tmdbToken();
  if (!token) return null;
  const key = `tv:${tmdbId}/${season}`;
  const s = load();
  const hit = s.stills[key];
  if (hit && Date.now() - hit.fetchedAt < ('missing' in hit ? MISS_TTL : STILLS_TTL)) {
    if ('missing' in hit) return null;
    return { value: hit.value, any: Object.keys(hit.value).length > 0 };
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
  return { value: next, any: Object.keys(next).length > 0 };
}
