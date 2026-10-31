import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cachePath } from '../cache/root';

/**
 * One JSON file per outside source under userData, shared by the IMDb / Trakt / Bangumi lookups.
 * Rotten Tomatoes, TMDB and Common Sense Media each grew their own copy of this before it existed.
 *
 * A recorded `missing` marker is what makes a real "this database has no such title" answer stick:
 * without it every open of the detail page would re-ask. A transport failure is the case callers must
 * NOT record, so that one retries on the next open instead of freezing into a permanent no.
 */

const DAY = 86_400_000;

export interface Missing {
  missing: true;
  fetchedAt: number;
}

export type Read<T> = { status: 'fresh'; value: T } | { status: 'empty' } | { status: 'stale' };

export interface SourceCache<T> {
  read(key: string): Read<T>;
  write(key: string, value: T): void;
  markEmpty(key: string): void;
}

/** Files this layer owns, by name. `clearMetaFiles()` deletes them and every loader forgets its copy. */
const resetters = new Set<() => void>();

export const META_FILES = ['tmdb.json', 'imdb.json', 'trakt.json', 'bangumi.json', 'csm.json', 'meta.json'];

export function resetSources(): void {
  for (const fn of resetters) fn();
}

export function sourceCache<T extends { fetchedAt: number }>(
  name: string,
  hitTtl: number = 30 * DAY,
  missTtl: number = 7 * DAY,
): SourceCache<T> {
  const file = () => cachePath(name);
  let data: Record<string, T | Missing> | null = null;
  // Every source registers its loader here so one 清空 can make them all re-read: deleting the files alone
  // would leave each module's in-memory copy answering from a file that no longer exists.
  resetters.add(() => {
    data = null;
  });

  const load = (): Record<string, T | Missing> => {
    if (!data) {
      try {
        data = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, T | Missing>;
      } catch {
        data = {};
      }
    }
    return data;
  };

  const persist = () => {
    try {
      mkdirSync(path.dirname(file()), { recursive: true });
      writeFileSync(file(), JSON.stringify(load()), 'utf8');
    } catch {
      // A cache that cannot be written only costs a refetch on the next open.
    }
  };

  return {
    read(key) {
      const hit = load()[key];
      if (!hit) return { status: 'stale' };
      const missing = (hit as Missing).missing === true;
      if (Date.now() - hit.fetchedAt >= (missing ? missTtl : hitTtl)) return { status: 'stale' };
      return missing ? { status: 'empty' } : { status: 'fresh', value: hit as T };
    },
    write(key, value) {
      load()[key] = value;
      persist();
    },
    markEmpty(key) {
      load()[key] = { missing: true, fetchedAt: Date.now() };
      persist();
    },
  };
}
