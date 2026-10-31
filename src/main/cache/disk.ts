import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { app } from 'electron';
import path from 'node:path';
import { cachePath } from './root';

/** How much a whole account's cached answers are allowed to take. Measured 2026-10-31: the gateway answers
 *  82,211 episodes and 7,313 films, which is about 130 MB if every row were kept; no one browses that much,
 *  so the ceiling only has to catch a long-lived install, not a complete mirror. */
const CAP_BYTES = 200 * 1024 * 1024;
export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const MINUTE = 60_000;

/** Bumped whenever what `write` stores changes shape. An index from another shape cannot be trusted to
 *  describe these files, and honouring it would serve a week of answers the reader no longer understands —
 *  so the folder is dropped once and rebuilt instead. */
const SCHEMA = 2;

/** A read is what proves an answer still earns its room, so the index is rewritten on a short delay rather
 *  than on every hit: a page that reads twenty answers should not rewrite the index twenty times. */
const FLUSH_MS = 400;

/** Value files removed one at a time leave nothing to notice them by; after this many, sweep the folder for
 *  files the index no longer points at. */
const VACUUM_AFTER = 64;

interface Entry {
  /** When it was written. The TTL counts from here and never slides: a row read every ten minutes is still
   *  a row from three days ago, and the owner expects it to be re-asked eventually. */
  at: number;
  ttl: number;
  bytes: number;
  /** The last time somebody read it, which is what 淘汰 goes by: an answer nobody opens is the one to lose,
   *  however recently it was written. */
  used?: number;
}

/** One JSON file per answer, plus a small index that holds the timing and the size.
 *
 *  Written as a key-value store rather than a table on purpose: the client asks for whole answers, and the
 *  only query this layer needs beyond a direct hit is "forget everything about this library". Files are
 *  written through a temp name so a crash mid-write leaves either the old answer or the new one, never half
 *  of both. Every filesystem call is allowed to fail: a cache that cannot write is a cache that misses. */
class DiskCache {
  private entries: Map<string, Entry> | null = null;
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private unusable = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private vacuumed = 0;

  private get root(): string {
    return cachePath('emby-cache');
  }

  private get indexPath(): string {
    return path.join(this.root, 'index.json');
  }

  private file(key: string): string {
    return path.join(this.root, createHash('sha1').update(key).digest('hex') + '.json');
  }

  private index(): Map<string, Entry> | null {
    if (this.entries) return this.entries;
    if (this.unusable) return null;
    const map = new Map<string, Entry>();
    try {
      const raw = JSON.parse(readFileSync(this.indexPath, 'utf8')) as { v?: number; schema?: number; entries?: Record<string, Entry> };
      if (raw?.v !== SCHEMA || raw?.schema !== SCHEMA) {
        // An index from another shape: its rows describe files this build cannot read.
        this.wipeValues();
      } else {
        for (const [k, v] of Object.entries(raw?.entries ?? {})) {
          if (!v || !(v.ttl > 0)) continue;
          map.set(k, {
            at: Number(v.at) || 0,
            ttl: Number(v.ttl) || 0,
            bytes: Number(v.bytes) || 0,
            used: Number(v.used) || Number(v.at) || 0,
          });
          this.bytes += Number(v.bytes) || 0;
        }
      }
    } catch {
      // No index yet, or one that did not survive a crash: start empty and let the files fall out of use.
      // The directory keeps the orphans until 清空 is pressed; they are a few hundred kilobytes of stale
      // answers, not a leak that grows without the index growing with it.
    }
    this.entries = map;
    return map;
  }

  /** Ask for the index to be rewritten soon. Cheap enough to call on every hit and every write. */
  private flush(): void {
    if (!this.entries) return;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, FLUSH_MS);
  }

  flushNow(): void {
    const map = this.entries;
    if (!map) return;
    try {
      mkdirSync(this.root, { recursive: true });
      const body = JSON.stringify({ v: SCHEMA, schema: SCHEMA, entries: Object.fromEntries(map) });
      const tmp = this.indexPath + '.' + process.pid + '.tmp';
      writeFileSync(tmp, body, 'utf8');
      renameSync(tmp, this.indexPath);
    } catch {
      // A read-only profile still plays; it just pays for every answer.
    }
  }

  /** Close the door on a pending rewrite before the map underneath it changes hands. */
  private stopFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Delete every answer file but the ones that are not answers (the index, the 观看状态 store). Called when
   *  the index cannot describe the folder any more. */
  private wipeValues(): void {
    try {
      for (const name of readdirSync(this.root)) {
        if (!/^[0-9a-f]{40}\.json$/.test(name)) continue;
        rmSync(path.join(this.root, name), { force: true });
      }
    } catch {
      // No folder yet: nothing to wipe.
    }
  }

  /** Remove answer files the index no longer points at. `forget` deletes one per drop, so this only has to
   *  catch the passes that were interrupted and the rows an index rewrite lost. */
  private vacuum(map: Map<string, Entry>): void {
    this.vacuumed = 0;
    const live = new Set([...map.keys()].map(k => createHash('sha1').update(k).digest('hex') + '.json'));
    try {
      for (const name of readdirSync(this.root)) {
        if (!/^[0-9a-f]{40}\.json$/.test(name) || live.has(name)) continue;
        rmSync(path.join(this.root, name), { force: true });
      }
    } catch {
      // Nothing to sweep.
    }
  }

  /** Read without checking the clock, for markers that are compared rather than expired. */
  peek<T>(key: string): T | null {
    const map = this.index();
    if (!map?.has(key)) return null;
    return this.raw<T>(key, map);
  }

  read<T>(key: string): T | null {
    const map = this.index();
    const entry = map?.get(key);
    if (!map || !entry) {
      this.misses++;
      return null;
    }
    if (Date.now() - entry.at >= entry.ttl) {
      this.forget(key, map);
      this.misses++;
      return null;
    }
    const body = this.raw<T>(key, map);
    if (body === null) {
      this.misses++;
      return null;
    }
    this.hits++;
    entry.used = Date.now();
    this.flush();
    return body;
  }

  private raw<T>(key: string, map: Map<string, Entry>): T | null {
    try {
      return JSON.parse(readFileSync(this.file(key), 'utf8')) as T;
    } catch {
      // Index says it is here, disk says otherwise: drop the row so the next read is a clean miss.
      this.forget(key, map);
      return null;
    }
  }

  write(key: string, value: unknown, ttl: number): void {
    const map = this.index();
    if (!map) return;
    let body: string;
    try {
      body = JSON.stringify(value);
    } catch {
      return;
    }
    const bytes = Buffer.byteLength(body);
    try {
      mkdirSync(this.root, { recursive: true });
      const file = this.file(key);
      const tmp = file + '.' + process.pid + '.tmp';
      writeFileSync(tmp, body, 'utf8');
      renameSync(tmp, file);
    } catch {
      return;
    }
    const prev = map.get(key);
    if (prev) this.bytes -= prev.bytes;
    map.set(key, { at: Date.now(), ttl, bytes, used: Date.now() });
    this.bytes += bytes;
    this.evict(map);
    this.flush();
  }

  /** Everything whose key starts with this. Keys are built so that a library's answers share a prefix, which
   *  is what lets one probe retire a library instead of the whole store. */
  dropPrefix(prefix: string): void {
    const map = this.index();
    if (!map) return;
    let dropped = 0;
    for (const key of [...map.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.forget(key, map);
      dropped++;
    }
    if (dropped) this.flush();
  }

  clear(): void {
    const map = this.index();
    if (map) {
      for (const key of [...map.keys()]) this.forget(key, map);
      map.clear();
    }
    // No index is the right answer for an empty folder, so the pending rewrite is dropped rather than made.
    this.stopFlush();
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
    try {
      rmSync(this.root, { recursive: true, force: true });
    } catch {
      // Nothing to remove, or the profile is locked; the index is already empty.
    }
    this.entries = null;
  }

  /** Forget the in-memory index after the folder behind it changed: the next read asks the new place. The
   *  counters go too, because 「本次命中」 is a reading about one folder, not about the app. */
  reset(): void {
    this.stopFlush();
    this.entries = null;
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
    this.unusable = false;
  }

  stats(): { bytes: number; entries: number; cap: number; hits: number; misses: number } {
    const map = this.index();
    return { bytes: this.bytes, entries: map?.size ?? 0, cap: CAP_BYTES, hits: this.hits, misses: this.misses };
  }

  private forget(key: string, map: Map<string, Entry>): void {
    const entry = map.get(key);
    if (!entry) return;
    map.delete(key);
    this.bytes -= entry.bytes;
    try {
      rmSync(this.file(key), { force: true });
    } catch {
      // Left behind for 清空; the index no longer points at it.
    }
    if (++this.vacuumed >= VACUUM_AFTER) this.vacuum(map);
  }

  /** Least recently read goes first. Writing time alone was wrong: the 1200-episode row of one library and
   *  the 类型 list are both written once and then never opened again, and they were pushing out the episodes
   *  of the series the viewer actually had open. Sizes are known from the index, so this is a scan, not a walk. */
  private evict(map: Map<string, Entry>): void {
    if (this.bytes <= CAP_BYTES) return;
    const seen = (e: Entry): number => e.used ?? e.at;
    const order = [...map.entries()].sort((a, b) => seen(a[1]) - seen(b[1]));
    for (const [key] of order) {
      if (this.bytes <= CAP_BYTES) break;
      this.forget(key, map);
    }
  }
}

export const diskCache = new DiskCache();
// The index is written on a delay, so the last few seconds of a session are only in memory until here.
app.on('will-quit', () => diskCache.flushNow());
