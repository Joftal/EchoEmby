import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as https from 'node:https';
import path from 'node:path';
import type { CsmGuide } from '../../shared/types';

/**
 * Common Sense Media publishes a content-advisory breakdown (violence, language, sex, drugs) on a 0–5
 * dot scale for each title, with no API and no key: the numbers are static HTML on the review page.
 * The page lives at `/movie-reviews/{slug}` or `/tv-reviews/{slug}`, and the slug is the title
 * lowercased with non-alphanumerics folded to hyphens — which only works for Latin titles, so Chinese,
 * Japanese and Korean items (the majority here) simply miss and the block stays hidden.
 */

const DAY = 86_400_000;
const GUIDE_TTL = 90 * DAY;
/** A miss is a wrong or absent slug, which rarely changes, so it can be cached long. */
const MISS_TTL = 30 * DAY;

/** Only these advisory categories reach the UI; the positive ones (messages, role models, diversity,
 *  consumerism) are not what a parental guidance strip is for. */
const ADVISORY: Record<string, string> = {
  sex: '性与裸露',
  violence: '暴力与惊吓',
  language: '粗口',
  drugs: '烟酒毒品',
};

interface Store {
  /** key = `${kind}:${slug}`, slug already ASCII-normalised. */
  guides: Record<string, CsmGuide | { missing: true; fetchedAt: number }>;
}

const file = () => path.join(app.getPath('userData'), 'csm.json');
let store: Store | null = null;

const load = (): Store => {
  if (store) return store;
  try {
    return { guides: {}, ...JSON.parse(readFileSync(file(), 'utf8')) };
  } catch {
    return { guides: {} };
  }
};

const persist = () => {
  try {
    mkdirSync(path.dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify(load()), 'utf8');
  } catch {
    // A cache that cannot be written only costs a refetch on the next open.
  }
};

const SITE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Fold a title into CSM's URL slug. Anything that has no Latin letters yields '' and is never looked up. */
export const csmSlug = (title: string): string =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

/** Node's TLS stack, not net.fetch: Chromium would route this through the system proxy, which turns a
 *  resolvable-but-flaky host into a 502 and we cannot tell that apart from a real CSM page. */
const get = (url: string, depth = 0): Promise<string | null> =>
  new Promise(resolve => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': SITE_UA, 'Accept-Language': 'en-US,en;q=0.9' }, timeout: 15000 },
      res => {
        const loc = res.headers.location;
        // A redirect is CSM normalising the slug; a bare 404 is a real "no such page".
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc && depth < 3) {
          res.resume();
          resolve(get(new URL(loc, url).toString(), depth + 1));
          return;
        }
        if (!res.statusCode || res.statusCode >= 500) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c as Buffer));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });

const parse = (html: string, fetchedAt: number): CsmGuide | null => {
  // Each category is a button whose score is drawn as filled/total circles; count the filled ones.
  const re = /id="content-grid-item-([a-z]+)"[^>]*>[\s\S]*?<\/button>/g;
  const categories: CsmGuide['categories'] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const key = m[1];
    const label = ADVISORY[key];
    if (!label) continue;
    const block = m[0];
    const total = (block.match(/icon-circle-solid/g) || []).length;
    const active = (block.match(/icon-circle-solid active/g) || []).length;
    if (!total) continue;
    categories.push({ key, label, level: active });
  }
  if (!categories.length) return null;
  const out: CsmGuide = { categories, fetchedAt };
  const age = html.match(/"typicalAgeRange"\s*:\s*"(\d{1,2})/);
  if (age) out.minAge = Number(age[1]);
  return out;
};

/** Null means CSM has nothing we can find for this title, which the UI renders as an absent block. */
export async function csmGuide(kind: 'movie' | 'tv', title: string): Promise<CsmGuide | null> {
  const slug = csmSlug(title);
  // A slug under three characters is either a non-Latin title or too generic to trust.
  if (slug.length < 3) return null;
  const s = load();
  const key = `${kind}:${slug}`;
  const hit = s.guides[key];
  if (hit && Date.now() - hit.fetchedAt < ('missing' in hit ? MISS_TTL : GUIDE_TTL)) {
    return 'missing' in hit ? null : hit;
  }
  const url = `https://www.commonsensemedia.org/${kind === 'movie' ? 'movie-reviews' : 'tv-reviews'}/${slug}`;
  const html = await get(url);
  if (html === null) return null; // transport failure: do not cache as missing
  const parsed = parse(html, Date.now());
  if (!parsed) {
    s.guides[key] = { missing: true, fetchedAt: Date.now() };
    persist();
    return null;
  }
  s.guides[key] = parsed;
  persist();
  return parsed;
}
