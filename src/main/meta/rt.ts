import { app, net } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RtScores } from '../../shared/types';

/**
 * Rotten Tomatoes has no public API we can get a key for, but every title page ships its scorecard
 * as embedded JSON. The hard half is the slug: it is not derivable from a name (`matrix`, not
 * `the_matrix`), so we get it from the IMDb id through Wikidata, which is the only bridge that
 * needs no key, no scraping of titles and no second lookup once it has answered.
 */

const DAY = 86_400_000;
const SCORE_TTL = 7 * DAY;
/** A miss is usually Wikidata not having the claim yet, so it is worth asking again sooner. */
const MISS_TTL = 3 * DAY;

interface Store {
  /** Permanent: an IMDb id never starts pointing at a different film. */
  slugs: Record<string, string>;
  rt: Record<string, RtScores | { missing: true; fetchedAt: number }>;
}

const file = () => path.join(app.getPath('userData'), 'meta.json');
let store: Store | null = null;

const load = (): Store => {
  if (store) return store;
  let next: Store;
  try {
    next = { slugs: {}, rt: {}, ...JSON.parse(readFileSync(file(), 'utf8')) };
  } catch {
    next = { slugs: {}, rt: {} };
  }
  store = next;
  return next;
};

const persist = () => {
  try {
    mkdirSync(path.dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify(load()), 'utf8');
  } catch {
    // A cache that cannot be written only costs a refetch on the next open.
  }
};

const SITE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// Measured: Wikimedia answers a descriptive agent and returns an error page for a borrowed browser UA.
const WD_UA = 'EchoEmby/0.1 (desktop client; per-title metadata lookup)';

const get = async (url: string, headers: Record<string, string>, timeoutMs: number): Promise<string | null> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, { headers, signal: ctrl.signal });
    // 4xx/5xx is an answer about the title; only a dead transport is not.
    if (res.status >= 500) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' || typeof v === 'number' ? Math.round(Number(v)) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

const jsonBlock = (html: string, id: string): any => {
  const m = html.match(new RegExp(`<script[^>]*id="${id}"[^>]*>([\\s\\S]*?)</script>`));
  try {
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
};

const parse = (html: string, fetchedAt: number): RtScores | null => {
  const sc = jsonBlock(html, 'media-scorecard-json');
  if (!sc) return null;
  // RT samples verified ticket buyers only for recent theatrical releases; older titles carry the
  // all-audience number instead, so take the verified one when it exists and the other when not.
  const verified = num(sc.overlay?.audienceVerified?.score);
  const out: RtScores = { fetchedAt };
  const tomato = num(sc.criticsScore?.score);
  const popcorn = verified ?? num(sc.overlay?.audienceAll?.score) ?? num(sc.audienceScore?.score);
  if (tomato !== undefined) out.tomatometer = tomato;
  if (sc.criticsScore?.certified) out.tomatoCertified = true;
  if (popcorn !== undefined) out.popcorn = popcorn;
  // The first affiliate is always RT's own Fandango CTA whose text is a verb ("Stream", "Buy"),
  // so it is dropped and what is left are the services.
  const watch = [
    ...new Set<string>(
      ((jsonBlock(html, 'where-to-watch-json')?.affiliates || []) as any[])
        .filter(a => a?.icon !== 'fandango')
        .map(a => String(a?.text || '').trim())
        .filter(Boolean),
    ),
  ];
  if (watch.length) out.whereToWatch = watch.slice(0, 5);
  return out.tomatometer === undefined && out.popcorn === undefined ? null : out;
};

/** `answered: false` means the request never got through, which must not be cached as "no page". */
const resolveSlug = async (imdb: string): Promise<{ slug: string | null; answered: boolean }> => {
  const s = load();
  if (s.slugs[imdb]) return { slug: s.slugs[imdb], answered: true };
  const q = new URLSearchParams({
    query: `SELECT ?rt WHERE { ?item wdt:P345 "${imdb}". ?item wdt:P1258 ?rt } LIMIT 1`,
    format: 'json',
  });
  const text = await get(`https://query.wikidata.org/sparql?${q}`, { 'User-Agent': WD_UA, Accept: 'application/sparql-results+json' }, 12000);
  if (text === null) return { slug: null, answered: false };
  let value = '';
  try {
    value = JSON.parse(text).results?.bindings?.[0]?.rt?.value || '';
  } catch {
    // Wikidata answers an HTML error page when it dislikes the request; that is not a negative.
    return { slug: null, answered: false };
  }
  if (!value) return { slug: null, answered: true };
  if (!/^\/?(m|tv)\//.test(value)) return { slug: null, answered: true };
  s.slugs[imdb] = value.replace(/^\/+/, '');
  persist();
  return { slug: s.slugs[imdb], answered: true };
};

/** Null means "no RT numbers for this id", which the UI renders as the absence of a badge. */
export async function rtScores(imdb: string): Promise<RtScores | null> {
  // The id goes into a query string, so anything that is not shaped like one is refused here.
  if (!/^tt\d{6,10}$/.test(imdb)) return null;
  const s = load();
  const hit = s.rt[imdb];
  if (hit && Date.now() - hit.fetchedAt < ('missing' in hit ? MISS_TTL : SCORE_TTL)) {
    return 'missing' in hit ? null : hit;
  }
  const miss = () => {
    s.rt[imdb] = { missing: true, fetchedAt: Date.now() };
    persist();
  };
  const resolved = await resolveSlug(imdb);
  if (!resolved.slug) {
    if (resolved.answered) miss();
    return null;
  }
  const html = await get(`https://www.rottentomatoes.com/${resolved.slug}`, { 'User-Agent': SITE_UA, 'Accept-Language': 'en-US,en;q=0.9' }, 15000);
  if (html === null) return null;
  const parsed = parse(html, Date.now());
  if (!parsed) {
    miss();
    return null;
  }
  s.rt[imdb] = parsed;
  persist();
  return parsed;
}
