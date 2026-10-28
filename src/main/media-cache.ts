import { app, net } from 'electron';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import * as config from './config';

/**
 * The byte cache behind the playback bridge.
 *
 * Every viewing is one long byte range read off a server that is often on the far side of the internet:
 * measured 2026-10-28, a 1080p episode is 1.34 GB at about 0.9 MB/s of sustained traffic, and a second
 * viewing of the same file pulled all of it again. mpv's own cache cannot help - it lives in the demuxer's
 * memory and dies with the process (--demuxer-max-bytes=220MiB, nothing on disk).
 *
 * So the bridge gets a disk. Files are cut into 4 MiB chunks aligned to absolute offsets, each chunk is
 * fetched once and written under <userData>/media-cache, and any later Range is answered out of those
 * files. Chunks are written whole (through .part and a rename), so a killed app leaves no half chunk that
 * would later read as valid data.
 *
 * The key is server origin + item id + MediaSourceId, because MediaSourceId names one file on one server
 * and item ids collide across servers (173216 is a Bleach episode on the gateway and something else on
 * bangumi). The gateway's ETag is stored beside it and compared on every open (at most a minute apart, so a
 * seek does not pay a round trip each time): a replaced file keeps its id but not its ETag, and serving the
 * old bytes would look like a corrupt film rather than a stale cache.
 *
 * Nothing in here is allowed to fail a viewing. The cache is the optional half of playback: a full disk, a
 * locked folder, a chunk that was truncated by an older build - each of those costs bytes on disk, and the
 * film keeps playing.
 */

const CHUNK = 4 * 1024 * 1024;
const GB = 1024 * 1024 * 1024;
/** How long a stored ETag counts as current. Short enough that a replaced file is noticed inside a viewing,
 *  long enough that 拖动进度条 does not add a round trip to every Range the demuxer opens. */
const ETAG_TTL = 60_000;
/** How much of the next episode 预取 pulls: ten minutes of it. Enough to make 下一集 feel instant, not so
 *  much that a file the viewer never reaches fills the disk. */
const PREFETCH_SECONDS = 600;

interface EntryMeta {
  key: string;
  itemId: string;
  sourceId: string;
  size: number;
  etag: string;
  type: string;
  updated: number;
}

interface Entry {
  meta: EntryMeta;
  /** Indices of the chunks that exist on disk in full. */
  chunks: Set<number>;
  bytes: number;
  used: number;
  /** When the ETag was last checked against the server; 0 means never (a fresh scan). */
  checkedAt: number;
}

export interface CacheStats {
  bytes: number;
  items: number;
  limitBytes: number;
  enabled: boolean;
}

const pad = (i: number): string => String(i).padStart(7, '0');

class MediaCache {
  private root = '';
  private entries = new Map<string, Entry>();
  private total = 0;
  private initPromise: Promise<void> | null = null;
  /** How many requests are being served per key. A plain Set was wrong: mpv opens a second Range for a seek
   *  before the first one closes, and the first to finish cleared the guard that keeps the entry out of LRU. */
  private serving = new Map<string, number>();
  private prefetchAbort: AbortController | null = null;
  private prefetchKey = '';

  /** `0` is 不限制 and answers `0` here rather than `Infinity`: zero is what the sheet reads back as the word,
   *  and the two places that compare against it both guard for it before dividing. */
  private get limitBytes(): number {
    const gb = config.load().settings.mediaCache.limitGB;
    return gb > 0 ? gb * GB : 0;
  }

  /** Half of the ceiling, or no ceiling at all - the prefetch budget and the guard that stops it mid-file. */
  private get prefetchCap(): number {
    const limit = this.limitBytes;
    return limit > 0 ? Math.floor(limit / 2) : Infinity;
  }

  private enabled(): boolean {
    return config.load().settings.mediaCache.enabled;
  }

  /** Reads what is already on disk. Called from the app's ready handler; every other entry point awaits it,
   *  so a request that arrives before the scan finished sees the same index instead of an empty one. */
  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.scan().catch(() => undefined);
    return this.initPromise;
  }

  private async scan(): Promise<void> {
    this.root = path.join(app.getPath('userData'), 'media-cache');
    await fsp.mkdir(this.root, { recursive: true });
    const dirs = await fsp.readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(this.root, d.name);
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8')) as EntryMeta;
        if (!meta || meta.key !== d.name || !(meta.size > 0)) throw new Error('bad meta');
        const files = await fsp.readdir(dir);
        const chunks = new Set<number>();
        let bytes = 0;
        for (const f of files) {
          // A .part is a chunk the process died while writing. The index cannot count it (the number would be
          // wrong) and nothing else ever deletes it, so a killed app used to leak that space silently.
          if (/\.part$/.test(f)) {
            await fsp.rm(path.join(dir, f), { force: true }).catch(() => undefined);
            continue;
          }
          const m = /^(\d{7})\.chunk$/.exec(f);
          if (!m) continue;
          const index = Number(m[1]);
          const st = await fsp.stat(path.join(dir, f)).catch(() => null);
          if (!st) continue;
          // Only a chunk at its full length can be served: a short file would be answered as if it were whole
          // and every byte after it would sit at the wrong offset for the rest of the film, forever.
          if (st.size !== Math.min(CHUNK, meta.size - index * CHUNK)) {
            await fsp.rm(path.join(dir, f), { force: true }).catch(() => undefined);
            continue;
          }
          chunks.add(index);
          bytes += st.size;
        }
        this.entries.set(meta.key, { meta, chunks, bytes, used: meta.updated || 0, checkedAt: 0 });
        this.total += bytes;
      } catch {
        // A folder without a readable meta.json is a half-written entry: worth nothing, and it would make
        // the total wrong, so it goes rather than being indexed on a guess.
        void fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    this.enforce(this.limitBytes);
  }

  /** Only a direct file is chunkable: an HLS playlist is text the bridge rewrites, and a segment list has no
   *  stable offsets to key on. */
  can(url: string): boolean {
    if (!this.enabled()) return false;
    if (!this.keyOf(url)) return false;
    return !/\.m3u8([?#]|$)/i.test(url) && !/mpegurl/i.test(url);
  }

  private keyOf(url: string): { key: string; itemId: string; sourceId: string } | null {
    try {
      const u = new URL(url);
      const m = /\/videos\/([^/]+)\/stream/i.exec(u.pathname);
      const sourceId = u.searchParams.get('MediaSourceId') || '';
      if (!m || !sourceId) return null;
      const itemId = m[1];
      const key = createHash('sha1').update(u.origin + '|' + itemId + '|' + sourceId).digest('hex').slice(0, 20);
      return { key, itemId, sourceId };
    } catch {
      return null;
    }
  }

  private dirOf(key: string): string {
    return path.join(this.root, key);
  }

  private chunkPath(key: string, index: number): string {
    return path.join(this.dirOf(key), pad(index) + '.chunk');
  }

  /** One round trip for the three numbers a Range answer is made of. bytes=0-0 is the smallest request that
   *  still carries Content-Range; the body is dropped. */
  private async probe(url: string, id: { key: string; itemId: string; sourceId: string }): Promise<EntryMeta | null> {
    try {
      const up = await net.fetch(url, { headers: { Range: 'bytes=0-0' } });
      const cr = up.headers.get('content-range') || '';
      const m = /bytes \d+-\d+\/(\d+)/.exec(cr);
      const size = m ? Number(m[1]) : 0;
      const type = up.headers.get('content-type') || 'application/octet-stream';
      const etag = up.headers.get('etag') || '';
      void up.body?.cancel().catch(() => undefined);
      if (!(size > 0)) return null;
      return { key: id.key, itemId: id.itemId, sourceId: id.sourceId, size, etag, type, updated: Date.now() };
    } catch {
      return null;
    }
  }

  /** Serves one Range out of the cache, fetching the chunks that are missing. Returns false when the request
   *  cannot be answered this way (no size, a refused byte range), which sends the bridge back to a plain
   *  forward. */
  async handle(url: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const id = this.keyOf(url);
    if (!id) return false;
    await this.init();
    const meta = await this.resolve(url, id);
    if (!meta) return false;
    const entry = this.entries.get(id.key);
    if (!entry) return false;
    const size = meta.size;
    const range = this.parseRange(req.headers.range, size);
    const head: Record<string, string> = {
      'Content-Type': meta.type,
      'Content-Length': String(range.end - range.start + 1),
      'Accept-Ranges': 'bytes',
    };
    if (req.headers.range) head['Content-Range'] = 'bytes ' + range.start + '-' + range.end + '/' + size;
    if (meta.etag) head['ETag'] = meta.etag;
    res.writeHead(req.headers.range ? 206 : 200, head);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }

    const ac = new AbortController();
    this.serving.set(id.key, (this.serving.get(id.key) || 0) + 1);
    entry.used = Date.now();
    const onClose = (): void => ac.abort();
    req.on('close', onClose);
    try {
      const first = Math.floor(range.start / CHUNK);
      const last = Math.floor(range.end / CHUNK);
      for (let i = first; i <= last; i++) {
        if (ac.signal.aborted || res.destroyed) return true;
        const cs = i * CHUNK;
        const ce = Math.min(cs + CHUNK, size) - 1;
        const from = Math.max(range.start, cs);
        const to = Math.min(range.end, ce);
        const want = ce - cs + 1;
        const st = entry.chunks.has(i) ? await fsp.stat(this.chunkPath(id.key, i)).catch(() => null) : null;
        if (st && st.size === want) {
          await this.pipeChunk(id.key, i, from - cs, to - cs, res);
        } else if (entry.chunks.has(i)) {
          // A short chunk cannot be repaired by reading past it: the bytes after it would be one chunk-length
          // out of step for the rest of the film (measured: a 1024-byte third chunk froze playback at 11.3s,
          // jumped to 17.6s, and never healed because the file looked complete to the index).
          await fsp.rm(this.chunkPath(id.key, i), { force: true }).catch(() => undefined);
          entry.chunks.delete(i);
          const lost = st ? st.size : 0;
          entry.bytes = Math.max(0, entry.bytes - lost);
          this.total = Math.max(0, this.total - lost);
          await this.fillAndServe(url, entry, i, cs, ce, from, to, res, ac.signal);
        } else {
          await this.fillAndServe(url, entry, i, cs, ce, from, to, res, ac.signal);
        }
      }
      if (!res.destroyed) res.end();
      return true;
    } catch {
      // Part of the picture is already on screen, so the honest end is a closed socket: mpv reports a failed
      // read and retries with a fresh Range. A status line cannot be sent at this point in the body.
      if (!res.destroyed) res.destroy();
      return true;
    } finally {
      req.off('close', onClose);
      const left = (this.serving.get(id.key) || 1) - 1;
      if (left > 0) this.serving.set(id.key, left);
      else this.serving.delete(id.key);
      this.persistMeta(entry);
      this.enforce(this.limitBytes);
    }
  }

  /** Makes sure the entry exists and carries a size. A changed ETag drops the old files: they are not some
   *  bytes of the new file, they are bytes of a different file at the same offsets. */
  private async resolve(url: string, id: { key: string; itemId: string; sourceId: string }): Promise<EntryMeta | null> {
    const known = this.entries.get(id.key);
    // The stored ETag is trusted for a minute at a time. Checking it on every open (as this file promises)
    // means one round trip per Range, and mpv opens a new Range for every seek.
    if (known && Date.now() - known.checkedAt < ETAG_TTL) return known.meta;
    const probed = await this.probe(url, id);
    // The server not answering is not a reason to stop reading bytes that are already on disk: offline a
    // cached film should still play.
    if (!probed) return known && known.meta.size > 0 ? known.meta : null;
    if (known) {
      const replaced =
        (known.meta.etag && probed.etag && known.meta.etag !== probed.etag) || known.meta.size !== probed.size;
      if (replaced) {
        await this.drop(known);
      } else {
        known.meta = { ...known.meta, ...probed, updated: Date.now() };
        known.checkedAt = Date.now();
        return known.meta;
      }
    }
    const entry: Entry = { meta: probed, chunks: new Set(), bytes: 0, used: Date.now(), checkedAt: Date.now() };
    this.entries.set(id.key, entry);
    await fsp.mkdir(this.dirOf(id.key), { recursive: true });
    this.persistMeta(entry);
    return probed;
  }

  private parseRange(header: string | undefined, size: number): { start: number; end: number } {
    const m = /^bytes=(\d*)-(\d*)/.exec(header || '');
    if (!m) return { start: 0, end: size - 1 };
    const a = m[1];
    const b = m[2];
    if (!a && b) {
      const n = Number(b);
      return { start: Math.max(0, size - n), end: size - 1 };
    }
    const start = Number(a || 0);
    const end = b ? Math.min(Number(b), size - 1) : size - 1;
    if (!(start < size) || end < start) return { start: 0, end: size - 1 };
    return { start, end };
  }

  private async pipeChunk(key: string, index: number, from: number, to: number, res: ServerResponse): Promise<void> {
    const fh = await fsp.open(this.chunkPath(key, index), 'r');
    try {
      const stream = fh.createReadStream({ start: from, end: to, autoClose: false });
      for await (const data of stream) await this.write(res, data as Buffer);
    } finally {
      await fh.close().catch(() => undefined);
    }
  }

  private async write(res: ServerResponse, buf: Buffer): Promise<void> {
    if (res.destroyed) throw new Error('client gone');
    await new Promise<void>((resolve, reject) => res.write(buf, err => (err ? reject(err) : resolve())));
  }

  /** Fetches one whole chunk, hands the client the part of it that was asked for while it arrives, and puts
   *  the complete chunk on disk. Streaming rather than buffering matters: the first 4 MiB of a 4K film can
   *  take seconds, and mpv must start filling its own demuxer during them. */
  private async fillAndServe(
    url: string,
    entry: Entry,
    index: number,
    cs: number,
    ce: number,
    from: number,
    to: number,
    res: ServerResponse,
    signal: AbortSignal,
  ): Promise<void> {
    const up = await net.fetch(url, { headers: { Range: 'bytes=' + cs + '-' + ce }, signal });
    if (!up.body) throw new Error('no body ' + up.status);
    const parts: Buffer[] = [];
    let got = 0;
    const want = ce - cs + 1;
    const body = Readable.fromWeb(up.body as any);
    try {
      for await (const data of body) {
        const buf = data as Buffer;
        const base = cs + got;
        parts.push(buf);
        got += buf.length;
        const a = Math.max(base, from);
        const b = Math.min(base + buf.length - 1, to);
        if (a <= b) await this.write(res, buf.subarray(a - base, b - base + 1));
      }
    } finally {
      // The viewer can close the window mid-chunk, and a destroyed response leaves the upstream read
      // half-consumed: undici holds its socket until this stream is destroyed (measured as a 「file
      // descriptor closed on garbage collection」 warning on the way out).
      body.destroy();
    }
    // A short body is not cached: writing it would leave a chunk that reads as complete and is not.
    if (got === want && !res.destroyed) {
      // A failed write is a failed cache, not a failed film. Letting it escape used to close the socket from
      // handle()'s catch, and measured with an unwritable chunk the player stopped at 27.8s and reopened the
      // file from zero. A full disk, a folder the user locked, an antivirus holding the file - all the same.
      try {
        await this.store(entry, index, Buffer.concat(parts));
      } catch {
        // The next chunk tries again; nothing is said because there is nothing the viewer could do.
      }
    }
  }

  private async store(entry: Entry, index: number, buf: Buffer): Promise<void> {
    if (entry.chunks.has(index)) return;
    // Switched off while a film is playing: the request already streaming keeps calling store() for the rest
    // of the file, and honouring the switch here is the difference between a setting and a decoration.
    if (!this.enabled()) return;
    // 清理全部缓存 can land in the middle of a viewing: the entry the request holds is no longer the one the
    // index owns, and writing into its folder would put bytes on disk that nothing can ever account for.
    if (this.entries.get(entry.meta.key) !== entry) return;
    const dir = this.dirOf(entry.meta.key);
    await fsp.mkdir(dir, { recursive: true });
    const file = this.chunkPath(entry.meta.key, index);
    await fsp.writeFile(file + '.part', buf);
    await fsp.rename(file + '.part', file);
    entry.chunks.add(index);
    entry.bytes += buf.length;
    this.total += buf.length;
    entry.used = Date.now();
  }

  /** Whole-item LRU. Evicting chunks out of the middle of films would leave a cache that is neither small
   *  nor useful, and a season is the unit a viewer thinks in. */
  private enforce(limit: number): void {
    // 不限制: nothing is ever evicted. The check lives here rather than at each call site so that a limit
    // dropped from 不限制 to 1 GB starts evicting on the very next read.
    if (limit <= 0) return;
    if (this.total <= limit) return;
    const victims = [...this.entries.values()]
      .filter(e => !this.serving.has(e.meta.key) && e.meta.key !== this.prefetchKey)
      .sort((a, b) => a.used - b.used);
    for (const e of victims) {
      if (this.total <= limit) break;
      void this.drop(e);
    }
  }

  private async drop(entry: Entry): Promise<void> {
    this.entries.delete(entry.meta.key);
    this.total = Math.max(0, this.total - entry.bytes);
    await fsp.rm(this.dirOf(entry.meta.key), { recursive: true, force: true }).catch(() => undefined);
  }

  private persistMeta(entry: Entry): void {
    entry.meta.updated = entry.used;
    void fsp.writeFile(path.join(this.dirOf(entry.meta.key), 'meta.json'), JSON.stringify(entry.meta)).catch(() => undefined);
  }

  /** 追剧时预取下一集. Bounded at both ends: the window of an episode that PREFETCH_SECONDS covers, never more
   *  than half the configured limit, so a prefetch cannot evict the film being watched. */
  async prefetch(url: string, runTimeMs: number): Promise<void> {
    const s = config.load().settings.mediaCache;
    if (!s.enabled || !s.prefetchNext) return;
    const id = this.keyOf(url);
    if (!id) return;
    await this.init();
    this.cancelPrefetch();
    const ac = new AbortController();
    this.prefetchAbort = ac;
    this.prefetchKey = id.key;
    try {
      const meta = await this.resolve(url, id);
      if (!meta || ac.signal.aborted) return;
      const entry = this.entries.get(id.key);
      if (!entry) return;
      const share = Math.min(meta.size, Math.ceil((meta.size * PREFETCH_SECONDS * 1000) / Math.max(runTimeMs, 60_000)));
      const budget = Math.min(share, this.prefetchCap);
      const want = Math.min(Math.ceil(meta.size / CHUNK), Math.ceil(budget / CHUNK));
      for (let i = 0; i < want; i++) {
        if (ac.signal.aborted) return;
        // Both knobs can move while a prefetch runs: the switch turned off, or 上限 dragged down to 1 GB. Stop
        // then, instead of pulling an episode into a cache that was just told to shrink.
        const now = config.load().settings.mediaCache;
        if (!now.enabled || !now.prefetchNext) return;
        if (entry.bytes >= this.prefetchCap) return;
        if (entry.chunks.has(i)) continue;
        const cs = i * CHUNK;
        const ce = Math.min(cs + CHUNK, meta.size) - 1;
        const up = await net.fetch(url, { headers: { Range: 'bytes=' + cs + '-' + ce }, signal: ac.signal });
        if (!up.body) return;
        const parts: Buffer[] = [];
        let got = 0;
        for await (const data of Readable.fromWeb(up.body as any)) {
          const buf = data as Buffer;
          parts.push(buf);
          got += buf.length;
        }
        if (got !== ce - cs + 1) return;
        await this.store(entry, i, Buffer.concat(parts));
        this.enforce(this.limitBytes);
      }
      this.persistMeta(entry);
    } catch {
      // A prefetch is an optimisation: the network went away, the account changed, the limit was reached.
      // None of those is worth a line the viewer would have to read.
    } finally {
      if (this.prefetchAbort === ac) {
        this.prefetchAbort = null;
        this.prefetchKey = '';
      }
    }
  }

  cancelPrefetch(): void {
    this.prefetchAbort?.abort();
    this.prefetchAbort = null;
    this.prefetchKey = '';
  }

  stats(): CacheStats {
    // Reading is also the moment 缓存上限 is applied: a limit lowered in 设置 must empty the difference now,
    // not at the end of whatever the viewer happens to play next (which could be tomorrow).
    this.enforce(this.limitBytes);
    // An entry a live request is holding can sit at zero bytes right after a clear; it is not a cached video
    // until it has some.
    let items = 0;
    for (const e of this.entries.values()) if (e.bytes > 0) items++;
    return { bytes: this.total, items, limitBytes: this.limitBytes, enabled: this.enabled() };
  }

  /** 清理全部缓存: the folder is dropped and re-created empty, and the index goes with it - except for the
   *  entries a playing request is holding. Those are emptied instead of forgotten, because store() only writes
   *  into the entry object the index owns: dropping it made the rest of that episode unwritable (measured: 已用
   *  stayed at 0 B for the whole film after a clear made mid-viewing), and keeping it means the space comes
   *  back as the viewer watches rather than after a restart. */
  async clear(): Promise<void> {
    this.cancelPrefetch();
    await this.init();
    const root = this.root;
    const live = [...this.entries.values()].filter(e => this.serving.has(e.meta.key));
    this.entries.clear();
    this.total = 0;
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
    await fsp.mkdir(root, { recursive: true }).catch(() => undefined);
    for (const e of live) {
      e.chunks = new Set();
      e.bytes = 0;
      this.entries.set(e.meta.key, e);
    }
  }

  /** 退出程序时清理缓存, bounded by the caller's exit budget. */
  async clearIfAsked(): Promise<void> {
    if (!config.load().settings.mediaCache.clearOnExit) return;
    await this.clear();
  }
}

export const mediaCache = new MediaCache();
