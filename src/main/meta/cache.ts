import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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

export function sourceCache<T extends { fetchedAt: number }>(
  name: string,
  hitTtl: number = 30 * DAY,
  missTtl: number = 7 * DAY,
): SourceCache<T> {
  const file = () => path.join(app.getPath('userData'), name);
  let data: Record<string, T | Missing> | null = null;

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
