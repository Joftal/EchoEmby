import * as https from 'node:https';
import type { ImdbRating } from '../../shared/types';
import { addBytes } from '../netmeter';
import { sourceCache } from './cache';

/**
 * IMDb's title pages are behind a bot challenge (a plain request gets a 202 with no body), but the
 * GraphQL endpoint the site itself calls answers a normal POST. It needs no key, only the two headers
 * that make the request look like it came from imdb.com — without them the edge returns 403.
 *
 * Node's TLS stack, not net.fetch, for two reasons measured on this machine: Chromium drops `origin`
 * and `referer` as forbidden fetch headers, and the system proxy answers that host with a 403 of its
 * own while a direct connection returns the rating. The same reasoning made `meta/csm.ts` leave net.fetch.
 *
 * Their response carries a standing disclaimer that public, commercial or non-private use of the data
 * is not allowed; this is a per-user lookup for one person's own library, which is the case it leaves
 * open. The number is IMDb's own average, which the Emby server does not pass through to us.
 */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const cache = sourceCache<ImdbRating>('imdb.json');

/** Null means the transport never answered, which must not be cached as "IMDb has no rating". */
const ask = (imdb: string): Promise<{ rating: number | null } | null> =>
  new Promise(resolve => {
    const body = JSON.stringify({ query: `query { title(id: "${imdb}") { ratingsSummary { aggregateRating } } }` });
    // The id is shape-checked by the caller, so it is safe to splice into the query text.
    const req = https.request(
      {
        hostname: 'api.graphql.imdb.com',
        path: '/',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': BROWSER_UA,
          origin: 'https://www.imdb.com',
          referer: `https://www.imdb.com/title/${imdb}/`,
        },
        timeout: 15000,
      },
      res => {
        if (!res.statusCode || res.statusCode >= 500) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        // Outside webRequest's reach, so the meter is told about this body by hand.
        res.on('data', c => {
          addBytes((c as Buffer).length);
          chunks.push(c as Buffer);
        });
        res.on('end', () => {
          let v: unknown;
          try {
            v = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.data?.title?.ratingsSummary?.aggregateRating;
          } catch {
            v = undefined;
          }
          resolve({ rating: typeof v === 'number' && Number.isFinite(v) ? v : null });
        });
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });

export async function imdbRating(imdb: string): Promise<ImdbRating | null> {
  if (!/^tt\d{6,10}$/.test(imdb)) return null;
  const hit = cache.read(imdb);
  if (hit.status === 'empty') return null;
  if (hit.status === 'fresh') return hit.value;
  const answer = await ask(imdb);
  if (!answer) return null;
  if (answer.rating === null) {
    cache.markEmpty(imdb);
    return null;
  }
  const out: ImdbRating = { rating: answer.rating, fetchedAt: Date.now() };
  cache.write(imdb, out);
  return out;
}
