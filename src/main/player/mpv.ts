import { app } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { PlayerState } from '../../shared/types';

export interface MpvOptions {
  hwnd: string;
  hwdec: string;
}

type Listener = (s: PlayerState) => void;

function mpvDir(): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
  return path.join(base, 'resources', 'mpv');
}

export function mpvExecutable(): string {
  const dir = mpvDir();
  const exe = path.join(dir, 'mpv.exe');
  if (existsSync(exe)) return exe;
  throw new Error(`mpv.exe not found in ${dir} — run \`npm run mpv\` to fetch it`);
}

/**
 * Drives the portable mpv build over its JSON IPC named pipe, rendering into the
 * host window through --wid (the arrangement measured in the PoC).
 */
export class MpvPlayer {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private sock: net.Socket | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private state: PlayerState | null = null;
  private listeners = new Set<Listener>();
  private poll: NodeJS.Timeout | null = null;
  readonly pipeName = `echoemby-mpv-${randomUUID().slice(0, 8)}`;

  onState(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(patch: Partial<PlayerState>): void {
    this.state = { ...(this.state as PlayerState), ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  get running(): boolean {
    return !!this.proc;
  }

  async start(opts: MpvOptions): Promise<void> {
    if (this.proc) throw new Error('mpv already running');
    const exe = mpvExecutable();
    const args = [
      `--wid=${opts.hwnd}`,
      `--input-ipc-server=${this.pipeName}`,
      '--no-config',
      '--terminal=no',
      '--msg-level=all=error',
      '--idle=once',
      '--keep-open=yes',
      '--force-window=yes',
      '--no-osc',
      '--no-osd-bar',
      // yt-dlp is not installed and ytdl_hook otherwise grabs every failed open,
      // turning one bad connect into ~10s of subprocess probing.
      '--no-ytdl',
      '--really-quiet=no',
      `--hwdec=${opts.hwdec}`,
      '--vo=gpu',
      '--gpu-api=d3d11',
      '--profile=gpu-hq',
      '--scale=ewa_lanczossharp',
      '--cscale=ewa_lanczossharp',
      '--video-sync=display-resample',
      '--interpolation=yes',
      '--tscale=oversample',
      '--hr-seek=yes',
      '--demuxer-max-bytes=220MiB',
      '--demuxer-max-back-bytes=120MiB',
      '--demuxer-readahead-secs=20',
      '--network-timeout=30',
      '--slang=zh,chi,zho,und',
      '--sub-bold=yes',
      '--sub-border-size=3',
      '--sub-shadow-offset=1',
      '--sub-font-size=52',
      '--volume-max=150',
      '--screenshot-format=jpg',
    ];
    // One --demuxer-lavf-o per process: mpv replaces rather than merges the list.
    // Streams arrive over loopback from StreamBridge, so reconnect here covers a
    // failed upstream read: mpv re-requests localhost and Chromium retries the server.
    args.push(`--demuxer-lavf-o=${['reconnect=1', 'reconnect_streamed=1', 'reconnect_delay_max=5'].join(',')}`);

    this.proc = spawn(exe, args, {
      cwd: path.dirname(exe),
      windowsHide: true,
    });
    this.proc.on('exit', (code, signal) => {
      this.stopPolling();
      this.emit({ status: signal ? 'idle' : 'error', error: signal ? undefined : `播放器进程退出了（代码 ${code}）` });
      this.proc = null;
      this.sock = null;
    });
    this.proc.stderr?.setEncoding('utf8');
    this.proc.stderr?.on('data', d => {
      const t = String(d).trim();
      if (t) {
        console.error('[mpv]', t.slice(0, 300));
      }
    });

    await this.connect();
    this.emit({
      status: 'idle', positionMs: 0, durationMs: 0, bufferedMs: 0, paused: true,
      volume: 100, muted: false, title: '', playMethod: '', direct: false,
      videoWidth: 0, videoHeight: 0, fullscreen: false, error: undefined,
    });
    this.startPolling();
  }

  private connect(): Promise<void> {
    const pipe = `\\\\.\\pipe\\${this.pipeName}`;
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 8000;
      const attempt = () => {
        const sock = net.connect(pipe);
        sock.once('connect', () => {
          this.sock = sock;

          sock.on('data', (chunk: Buffer) => this.onData(chunk.toString('utf8')));
          sock.on('error', () => sock.destroy());
          resolve();
        });
        sock.once('error', () => {
          sock.destroy();
          if (Date.now() > deadline) reject(new Error(`mpv IPC pipe never opened: ${pipe}`));
          else setTimeout(attempt, 120);
        });
      };
      attempt();
    });
  }

  /** mpv emits one JSON object per line. */
  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      // mpv answers every successful command with error:"success".
      const failure = msg.error && msg.error !== 'success' ? msg.error : null;
      if (failure && msg.request_id != null) {
        const p = this.pending.get(msg.request_id);
        if (p) { this.pending.delete(msg.request_id); p.reject(new Error(String(failure))); }
      } else if (msg.request_id != null) {
        const p = this.pending.get(msg.request_id);
        if (p) { this.pending.delete(msg.request_id); p.resolve(msg.data); }
      } else if (msg.event === 'start-file') {
        this.emit({ status: 'opening', error: undefined });
      } else if (msg.event === 'file-loaded') {
        this.emit({ status: 'playing', paused: false });
      } else if (msg.event === 'end-file') {
        if (msg.reason === 'eof') this.emit({ status: 'ended', paused: true });
        else if (msg.reason) this.emit({ status: 'error', paused: true, error: `无法打开流 (${msg.reason})` });
      } else if (msg.event === 'file-error') {
        this.emit({ status: 'error', paused: true, error: String(msg.text || '播放器出错').slice(0, 300) });
      }
    }
  }

  command<T = any>(args: unknown[], timeoutMs = 5000): Promise<T> {
    if (!this.sock?.writable) return Promise.reject(new Error('mpv not connected'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`mpv command timed out: ${JSON.stringify(args[0])}`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      // mpv's JSON IPC correlates replies by the snake_case `request_id` field.
      this.sock!.write(JSON.stringify({ command: args, async: true, request_id: id }) + '\n');
    });
  }

  async prop(name: string): Promise<any> {
    try {
      return await this.command(['get_property', name], 2000);
    } catch {
      return undefined;
    }
  }

  async load(url: string, title: string, opts: { startMs?: number; playMethod?: string; headers?: Record<string, string> } = {}): Promise<void> {
    const playMethod = opts.playMethod || '';
    this.emit({ status: 'opening', title, playMethod, direct: playMethod === 'DirectPlay', positionMs: opts.startMs || 0, durationMs: 0 });
    const extra: string[] = [];
    if (opts.headers) for (const [k, v] of Object.entries(opts.headers)) extra.push(`${k}: ${v}`);
    if (extra.length) await this.command(['set_property', 'http-header-fields', extra.join('\r\n')]).catch(() => undefined);
    // This mpv build rejects loadfile's options map ("invalid parameter"), so the
    // measured working form is url+flag; pause/seek go through separate commands.
    await this.command(['loadfile', url, 'replace']);
    if (opts.startMs) {
      // seek after file-loaded; before that mpv has no timeline yet
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        if ((this.state?.status as string) === 'playing') break;
        await new Promise(r => setTimeout(r, 60));
      }
      await this.command(['set_property', 'playback-time', Math.max(0, opts.startMs / 1000)]).catch(() => undefined);
    }
  }

  async play(): Promise<void> { await this.command(['set_property', 'pause', false]); this.emit({ paused: false, status: 'playing' }); }
  async pause(): Promise<void> { await this.command(['set_property', 'pause', true]); this.emit({ paused: true, status: 'paused' }); }
  async toggle(): Promise<void> { (await this.prop('pause')) ? this.play() : this.pause(); }
  async seekTo(ms: number): Promise<void> {
    // Measured 2026-10-12 against mpv v0.41.0-dev: the `set` command name answers
    // "invalid parameter" while `set_property` succeeds, so every setter spells it out.
    await this.command(['set_property', 'playback-time', Math.max(0, ms / 1000)]);
    this.emit({ positionMs: ms });
  }
  async seekBy(deltaMs: number): Promise<void> {
    const cur = (await this.prop('time-pos')) || 0;
    await this.seekTo((cur + deltaMs / 1000) * 1000);
  }
  async setVolume(v: number): Promise<void> {
    const vol = Math.max(0, Math.min(150, Math.round(v)));
    await this.command(['set_property', 'volume', vol]);
    this.emit({ volume: vol });
  }
  async setMuted(m: boolean): Promise<void> { await this.command(['set_property', 'mute', m]); this.emit({ muted: m }); }
  async setSubtitleIndex(i: number | 'auto' | 'no'): Promise<void> { await this.command(['set_property', 'sid', i]); this.emit({ subtitleIndex: i as number }); }

  private startPolling(): void {
    this.stopPolling();
    this.poll = setInterval(async () => {
      if (!this.sock?.writable) return;
      const [pos, dur, paused, vol, muted, cache, w, h, fps] = await Promise.all([
        this.prop('time-pos'), this.prop('duration'), this.prop('pause'), this.prop('volume'),
        this.prop('mute'), this.prop('demuxer-cache-time'),
        this.prop('video-params/w'), this.prop('video-params/h'), this.prop('video-params/fps'),
      ]);
      const patch: Partial<PlayerState> = {};
      if (typeof pos === 'number') patch.positionMs = Math.round(pos * 1000);
      if (typeof dur === 'number') patch.durationMs = Math.round(dur * 1000);
      if (typeof paused === 'boolean') patch.paused = paused;
      if (typeof vol === 'number') patch.volume = vol;
      if (typeof muted === 'boolean') patch.muted = muted;
      if (typeof cache === 'number') patch.bufferedMs = Math.round(cache * 1000);
      if (typeof fps === 'number') patch.fps = Math.round(fps * 100) / 100;
      if (typeof w === 'number' && typeof h === 'number') { patch.videoWidth = w; patch.videoHeight = h; }
      if (patch.status === undefined && (this.state?.status === 'idle' || this.state?.status === 'error') && typeof pos === 'number') {
        patch.status = paused ? 'paused' : 'playing';
      }
      this.emit(patch);
    }, 300);
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  async quit(): Promise<void> {
    this.stopPolling();
    if (this.sock?.writable) {
      try { await this.command(['quit'], 1500); } catch {}
      this.sock.end();
    }
    this.sock = null;
    const p = this.proc;
    this.proc = null;
    if (p) {
      await new Promise<void>(res => {
        const t = setTimeout(() => { if (p.exitCode === null) p.kill('SIGKILL'); res(); }, 1200);
        p.once('exit', () => { clearTimeout(t); res(); });
      });
    }
    this.pending.forEach(v => v.reject(new Error('player closed')));
    this.pending.clear();
  }
}
