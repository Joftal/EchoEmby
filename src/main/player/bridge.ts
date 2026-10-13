import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { net } from 'electron';

/**
 * mpv opens streams with ffmpeg's TLS stack, which fails this server's proxy
 * CONNECT handshake roughly twice every ten requests (measured), while Chromium's
 * net.fetch on the identical request succeeded 8/8. So mpv is handed a plain-HTTP
 * loopback URL and this server owns the TLS and the Range forwarding.
 */
export class StreamBridge {
  private server: http.Server | null = null;
  private port = 0;
  private token = randomUUID().slice(0, 12);
  private target = '';
  private inflight = new Set<AbortController>();

  /** Points the bridge at a stream and returns the loopback URL mpv should open. */
  async open(target: string): Promise<string> {
    this.target = target;
    if (this.server) return this.url();
    const server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
    return this.url();
  }

  private url(): string {
    return `http://127.0.0.1:${this.port}/${this.token}/stream`;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.url !== `/${this.token}/stream`) {
      res.writeHead(404).end();
      return;
    }
    const abort = new AbortController();
    this.inflight.add(abort);
    req.on('close', () => abort.abort());
    const headers: Record<string, string> = {};
    // ffmpeg asks for ranges with no end on the first probe; Emby needs the raw value.
    if (req.headers.range) headers.Range = req.headers.range;
    try {
      const up = await net.fetch(this.target, { headers, signal: abort.signal });
      res.writeHead(up.status, {
        'Accept-Ranges': up.headers.get('accept-ranges') || 'bytes',
        ...(up.headers.get('Content-Range') ? { 'Content-Range': up.headers.get('Content-Range')! } : {}),
        ...(up.headers.get('Content-Length') ? { 'Content-Length': up.headers.get('Content-Length')! } : {}),
        'Content-Type': up.headers.get('Content-Type') || 'application/octet-stream',
        ...(up.headers.get('X-Emby-Total-size') ? { 'X-Emby-Total-size': up.headers.get('X-Emby-Total-size')! } : {}),
      });
      if (!up.body) {
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
  }
}
