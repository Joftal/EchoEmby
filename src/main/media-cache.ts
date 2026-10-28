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
 * bangumi). The gateway's ETag is stored beside it and compared on every open: a replaced file keeps its id
 * but not its ETag, and serving the old bytes would look like a corrupt film rather than a stale cache.
 */

const CHUNK = 4 * 1024 * 1024;
const GB = 1024 * 1024 * 1024;
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
  private serving = new Set<string>();
  private prefetchAbort: AbortController | null = null;
  private prefetchKey = '';

  private get limitBytes(): number {
    return Math.max(1, config.load().settings.mediaCache.limitGB) * GB;
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
          const m = /^(\d{7})\.chunk$/.exec(f);
          if (!m) continue;
          const st = await fsp.stat(path.join(dir, f)).catch(() => null);
          if (!st) continue;
          chunks.add(Number(m[1]));
          bytes += st.size;
        }
        this.entries.set(meta.key, { meta, chunks, bytes, used: meta.updated || 0 });
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
    this.serving.add(id.key);
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
        if (entry.chunks.has(i)) await this.pipeChunk(id.key, i, from - cs, to - cs, res);
        else await this.fillAndServe(url, entry, i, cs, ce, from, to, res, ac.signal);
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
      this.serving.delete(id.key);
      this.persistMeta(entry);
      this.enforce(this.limitBytes);
    }
  }

  /** Makes sure the entry exists and carries a size. A changed ETag drops the old files: they are not some
   *  bytes of the new file, they are bytes of a different file at the same offsets. */
  private async resolve(url: string, id: { key: string; itemId: string; sourceId: string }): Promise<EntryMeta | null> {
    const known = this.entries.get(id.key);
    if (known && known.meta.size > 0) return known.meta;
    const probed = await this.probe(url, id);
    if (!probed) return null;
    if (known) {
      if (known.meta.etag && probed.etag && known.meta.etag !== probed.etag) {
        await this.drop(known);
      } else {
        known.meta = { ...known.meta, ...probed, updated: Date.now() };
        return known.meta;
      }
    }
    const entry: Entry = { meta: probed, chunks: new Set(), bytes: 0, used: Date.now() };
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
    if (got === want && !res.destroyed) await this.store(entry, index, Buffer.concat(parts));
  }

  private async store(entry: Entry, index: number, buf: Buffer): Promise<void> {
    if (entry.chunks.has(index)) return;
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
      const budget = Math.min(share, Math.floor(this.limitBytes / 2));
      const want = Math.min(Math.ceil(meta.size / CHUNK), Math.ceil(budget / CHUNK));
      for (let i = 0; i < want; i++) {
        if (ac.signal.aborted) return;
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
    return { bytes: this.total, items: this.entries.size, limitBytes: this.limitBytes, enabled: this.enabled() };
  }

  /** 清理全部缓存: the folder is dropped and re-created empty, and the index goes with it. */
  async clear(): Promise<void> {
    this.cancelPrefetch();
    await this.init();
    const root = this.root;
    this.entries.clear();
    this.total = 0;
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
    await fsp.mkdir(root, { recursive: true }).catch(() => undefined);
  }

  /** 退出程序时清理缓存, bounded by the caller's exit budget. */
  async clearIfAsked(): Promise<void> {
    if (!config.load().settings.mediaCache.clearOnExit) return;
    await this.clear();
  }
}

export const mediaCache = new MediaCache();
