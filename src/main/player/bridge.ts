import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { net } from 'electron';

/**
 * The loopback HTTP server mpv actually talks to.
 *
 * mpv opens streams with ffmpeg's TLS stack, which fails this gateway's proxy CONNECT roughly twice
 * every ten requests (measured), while Chromium's net.fetch on the identical request succeeded 8/8.
 * So mpv is handed a plain-HTTP address here and this server owns the TLS, the proxy route and the
 * Range forwarding.
 *
 * The second reason it exists is HLS. A transcode playlist from Emby lists its segments as paths
 * relative to the playlist (`hls1/main/0.ts`), and ffmpeg resolves them against whatever address it
 * was given - so a bridge that answers only one fixed URL 404s every segment and the transcode path
 * can never play. Every URI in a playlist is therefore rewritten here into this bridge's own address
 * space, and the request for it carries the absolute upstream URL it came from.
 */
/** The slice of the media cache this server needs: it decides whether a URL is a chunkable file, and it
 *  answers the request when it can. Kept as an interface so the bridge stays a pipe that knows nothing
 *  about settings, eviction or the gateway. */
export interface RangeCache {
  can(url: string): boolean;
  handle(url: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>;
}

export class StreamBridge {
  private server: http.Server | null = null;
  private port = 0;
  private origin = '';
  private readonly token = randomUUID().slice(0, 16);
  private readonly inflight = new Set<AbortController>();
  private cache: RangeCache | null = null;

  /** Installed once by AppServices, before any window can play: a cache that arrived halfway through the
   *  first viewing would answer the second half of the file and forward the first. */
  useCache(cache: RangeCache): void {
    this.cache = cache;
  }

  /** Starts listening if needed and returns the address to hand the player for `upstream`. */
  async mount(upstream: string): Promise<string> {
    if (!this.server) {
      const server = http.createServer((req, res) => void this.handle(req, res));
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
      this.port = (server.address() as AddressInfo).port;
      this.server = server;
    }
    // Everything this mount may fetch, so a rewritten playlist cannot be pointed elsewhere later.
    this.origin = new URL(upstream).origin;
    return this.address(upstream);
  }

  private get root(): string {
    return `http://127.0.0.1:${this.port}/${this.token}`;
  }

  private address(upstream: string): string {
    return `${this.root}/${encodeURIComponent(upstream)}`;
  }

  /** A playlist line is either a tag (only its `URI="…"` attributes matter) or a segment / child playlist
   *  path, which is relative to the playlist it was found in. Both become addresses of this server. */
  private rewritePlaylist(text: string, base: string): string {
    const to = (uri: string): string => {
      const t = uri.trim();
      // Already ours (a redirect we followed earlier, or a playlist that quoted absolute bridge URLs):
      // leave it, so a rewrite can never nest.
      if (!t || t.startsWith('#') || t.startsWith(this.root)) return uri;
      try {
        return this.address(new URL(t, base).href);
      } catch {
        return uri;
      }
    };
    return text
      .replace(/URI="([^"]+)"/g, (_m, uri: string) => `URI="${to(uri)}"`)
      .split('\n')
      .map(line => {
        const bare = line.trim();
        return bare && !bare.startsWith('#') ? to(bare) : line;
      })
      .join('\n');
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = (req.url || '').split('?')[0];
    const prefix = `/${this.token}/`;
    const encoded = url.startsWith(prefix) ? url.slice(prefix.length) : '';
    let upstream = '';
    try {
      upstream = decodeURIComponent(encoded);
    } catch {
      res.writeHead(400).end();
      return;
    }
    // This server forwards with the gateway's own credentials in the query string, so it will only fetch
    // under the origin it was mounted for. Without that, anything that could reach the loopback port
    // could name any URL and read the answer through the player.
    let sameOrigin = false;
    try {
      sameOrigin = !!encoded && new URL(upstream).origin === this.origin;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    // A cached range is answered here instead of by the gateway; anything the cache cannot vouch for (a
    // playlist, a subtitle file, a file whose size the server refused to report) falls through unchanged.
    // The cache decides from the URL itself, because that is the only place MediaSourceId is visible.
    if (this.cache?.can(upstream)) {
      try {
        if (await this.cache.handle(upstream, req, res)) return;
      } catch {
        // Nothing was written on this path, or the response is already torn down; either way the forward
        // below is the plain, always-correct answer.
      }
      if (res.headersSent) return;
    }
    await this.forward(upstream, req, res);
  }

  private async forward(upstream: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const abort = new AbortController();
    this.inflight.add(abort);
    req.on('close', () => abort.abort());
    const headers: Record<string, string> = {};
    // ffmpeg probes with an open-ended Range; Emby needs the value verbatim.
    if (req.headers.range) headers.Range = req.headers.range;
    try {
      const up = await net.fetch(upstream, { method: req.method, headers, signal: abort.signal, redirect: 'follow' });
      const type = up.headers.get('content-type') || '';
      // The server's own label decides, not which address was asked for: the direct-stream entry is a
      // multi-gigabyte byte range and must never be buffered to look for playlist syntax.
      const isPlaylist = up.ok && (/mpegurl|m3u8/i.test(type) || /\.m3u8([?#]|$)/i.test(new URL(upstream).pathname));
      if (isPlaylist && up.body) {
        const buf = Buffer.from(this.rewritePlaylist(await up.text(), upstream), 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Content-Length': String(buf.length),
          'Accept-Ranges': 'none',
        });
        res.end(req.method === 'HEAD' ? undefined : buf);
        return;
      }
      const out: Record<string, string> = {
        'Accept-Ranges': up.headers.get('accept-ranges') || 'bytes',
        'Content-Type': type || 'application/octet-stream',
      };
      const length = up.headers.get('content-length');
      const range = up.headers.get('content-range');
      const total = up.headers.get('x-emby-total-size');
      if (length) out['Content-Length'] = length;
      if (range) out['Content-Range'] = range;
      if (total) out['X-Emby-Total-Size'] = total;
      res.writeHead(up.status, out);
      if (!up.body || req.method === 'HEAD') {
        res.end();
        return;
      }
      const body = Readable.fromWeb(up.body as any);
      body.on('error', () => res.destroy());
      body.pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    } finally {
      this.inflight.delete(abort);
    }
  }

  close(): void {
    for (const c of this.inflight) c.abort();
    this.inflight.clear();
    this.server?.close();
    this.server = null;
    this.port = 0;
    this.origin = '';
  }
}
