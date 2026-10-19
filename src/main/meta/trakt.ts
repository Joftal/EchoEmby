import { net } from 'electron';
import * as config from '../config';
import type { TraktScores } from '../../shared/types';
import { sourceCache } from './cache';

/**
 * Trakt is the one source here that needs a key. Its API takes an IMDb id wherever it takes its own, so
 * no reverse lookup is needed: one request, keyed by the id the Emby server already gives us.
 */

const DAY = 86_400_000;
const API = 'https://api.trakt.tv';

const cache = sourceCache<TraktScores>('trakt.json', 7 * DAY, 3 * DAY);

const ask = async (url: string, key: string): Promise<any | null> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await net.fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': key,
        // Without a UA the CDN in front of Trakt answers 403 to a default fetch.
        'User-Agent': 'EchoEmby/0.1 (desktop client; per-title metadata lookup)',
      },
      signal: ctrl.signal,
    });
    // 404 is Trakt saying it has no such title; only a 5xx or a dead socket is not an answer.
    if (res.status >= 500) return null;
    // A rejected key answers for no title in particular, so it must not be filed as 「this one has no
    // Trakt score」 — measured: a bad id gets HTTP 403 "Forbidden" from the CDN, and a caller that
    // negative-cached that would leave the strip dark for three days after the key is fixed.
    if (res.status === 401 || res.status === 403) return null;
    if (res.status === 404) return {};
    return await res.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export async function traktScores(kind: 'movie' | 'tv', imdb: string): Promise<TraktScores | null> {
  const key = config.get().meta?.traktClientId;
  if (!key || !/^tt\d{6,10}$/.test(imdb)) return null;
  const id = `${kind}:${imdb}`;
  const hit = cache.read(id);
  if (hit.status === 'empty') return null;
  if (hit.status === 'fresh') return hit.value;

  const base = `${API}/${kind === 'movie' ? 'movies' : 'shows'}/${imdb}`;
  const rating = await ask(`${base}/ratings`, key);
  if (!rating) return null;

  const out: TraktScores = { fetchedAt: Date.now() };
  const r = num(rating.rating) ?? num(rating.value);
  if (r !== undefined) out.rating = Math.round(r * 100) / 100;
  if (out.rating === undefined) {
    cache.markEmpty(id);
    return null;
  }
  cache.write(id, out);
  return out;
}
