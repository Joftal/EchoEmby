import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MpvPipe, type MpvMessage } from './mpv-pipe';
import {
  VOLUME_MAX,
  type PlayerChapter,
  type PlayerMedia,
  type PlayerState,
  type PlayerStatus,
  type PlayerTrack,
  type TrackSelection,
} from '../../shared/types';

export interface KernelLaunch {
  hwnd: string;
  prefs: { hwdec: string; hdrHint: boolean; render: 'smooth' | 'hq' };
}

export function mpvExecutable(): string {
  const dir = path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'resources', 'mpv');
  const exe = path.join(dir, 'mpv.exe');
  if (existsSync(exe)) return exe;
  throw new Error(`没有找到 mpv.exe（${dir}），运行 \`npm run mpv\` 获取它`);
}

/** What the pipe reports, kept verbatim so a change can be diffed rather than recomputed. */
interface Raw {
  loaded: boolean;
  /** start-file has been answered but file-loaded has not. */
  opening: boolean;
  error?: string;
  timePos?: number;
  duration?: number;
  paused?: boolean;
  volume?: number;
  muted?: boolean;
  speed?: number;
  cacheEnd?: number;
  eof: boolean;
  hwdec: string;
  fps: number;
  width: number;
  height: number;
  hdr: boolean;
  colorSpace?: string;
  tracks: PlayerTrack[];
  chapters: PlayerChapter[];
  subtitle: TrackSelection;
  audio: TrackSelection;
  video: TrackSelection;
  subDelay: number;
  audioDelay: number;
  subScale: number;
  subPos: number;
  aspect: TrackSelection;
  panscan: number;
  fullscreen: boolean;
}

const freshRaw = (): Raw => ({
  loaded: false,
  opening: false,
  eof: false,
  hwdec: '',
  fps: 0,
  width: 0,
  height: 0,
  hdr: false,
  tracks: [],
  chapters: [],
  subtitle: 'auto',
  audio: 'auto',
  video: 'auto',
  subDelay: 0,
  audioDelay: 0,
  subScale: 100,
  subPos: 100,
  aspect: 'no',
  panscan: 0,
  fullscreen: false,
});

/** The one set of properties the kernel reads, and the only way it learns anything: each name is
 *  observed once at startup and pushed back as a `property-change` event. Polling was the old design and
 *  it cost nine round trips every 300 ms, several of them for names this build does not answer. */
const OBSERVED = [
  'time-pos',
  'duration',
  'pause',
  'volume',
  'mute',
  'speed',
  'eof-reached',
  'demuxer-cache-state',
  'hwdec-current',
  'video-params',
  'container-fps',
  'track-list',
  'chapter-list',
  'sid',
  'aid',
  'vid',
  'sub-delay',
  'audio-delay',
  'sub-scale',
  'sub-pos',
  'video-aspect-override',
  'panscan',
];

const sec = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** mpv calls a subtitle track `sub`; everything else on the panel is named the way the app names it.
 *  An attached picture is a cover inside an audio file, not a picture anyone chose to watch. */
const mapTrack = (t: any): Omit<PlayerTrack, 'ordinal'> | null => {
  if (!t || typeof t.id !== 'number') return null;
  if (t.type === 'video' && t.attached_pic) return null;
  const kind: PlayerTrack['kind'] = t.type === 'sub' ? 'subtitle' : t.type === 'audio' ? 'audio' : 'video';
  return {
    id: t.id,
    kind,
    title: typeof t.title === 'string' && t.title ? t.title : undefined,
    lang: typeof t.lang === 'string' && t.lang ? t.lang : undefined,
    codec: typeof t.codec === 'string' ? t.codec : undefined,
    selected: !!t.selected,
    default: !!t.default,
    forced: !!t.forced,
    external: !!t.external,
  };
};

/** Emby counts each kind on its own, and mpv lists the demuxer's order, so the ordinal is simply the
 *  position within the group. It is what a progress report has to send for the streams to be remembered. */
const withOrdinals = (list: Omit<PlayerTrack, 'ordinal'>[]): PlayerTrack[] => {
  const seen = { video: 0, audio: 0, subtitle: 0 };
  return list.map(t => ({ ...t, ordinal: seen[t.kind]++ }));
};

/** sid/aid/vid read back as a track id, or as the string "auto". Measured against the bundled 0.41
 *  build: a selection turned off answers with the boolean `false`, not with the string "no", so mapping
 *  it to anything else makes 「关闭字幕」 come back on the panel as 「自动选择」. */
const selection = (v: unknown): TrackSelection =>
  typeof v === 'number' && Number.isFinite(v) ? v : v === 'auto' ? 'auto' : v === false || v === 'no' ? 'no' : 'auto';

/** `video-aspect-override` reads back as a number when forced and as the string "no" when it is not. */
const aspectSelection = (v: unknown): TrackSelection => (typeof v === 'number' && v > 0 ? v : 'no');

/**
 * The player process and its state machine.
 *
 * It owns nothing about Emby: it launches mpv into a window handle, keeps one property cache warm, and
 * answers commands. Everything that knows about media sources, quality or progress lives in `session.ts`,
 * so this file can be read - and tested - without a server.
 */
export class MpvKernel {
  private proc: ChildProcess | null = null;
  private pipe = new MpvPipe();
  private raw: Raw = freshRaw();
  private startAt = 0;
  private timer: NodeJS.Timeout | null = null;
  /** A process we asked to quit is not a crash, so its exit must not be reported as a failure. */
  private quitting = false;
  /** The launch's render profile, so a change to it is visible without re-reading the config. */
  private launchedRender = '';
  readonly pipeName = `echoemby-mpv-${randomUUID().slice(0, 8)}`;

  onState: (s: PlayerState) => void = () => undefined;
  onMedia: (m: PlayerMedia) => void = () => undefined;
  /** The process is gone: whoever owns the session must stop talking to a dead player. */
  onGone: (message?: string) => void = () => undefined;

  get running(): boolean {
    return !!this.proc;
  }

  /** 'smooth' and 'hq' are chosen by the launch arguments, not at runtime: mpv's `gpu-hq` profile is a
   *  bundle of settings that cannot be un-set, so switching it means a new process. */
  get renderProfile(): string {
    return this.launchedRender;
  }

  private args(l: KernelLaunch): string[] {
    const hq = l.prefs.render === 'hq';
    const a = [
      `--wid=${l.hwnd}`,
      `--input-ipc-server=${this.pipeName}`,
      '--no-config',
      '--terminal=no',
      '--msg-level=all=error',
      '--idle=once',
      // Without this mpv tears itself down at the end of a file, so 重播 and 下一集 would each need a new
      // process. It also means eof never arrives as an end-file event, which is why `eof-reached` is observed.
      '--keep-open=yes',
      '--force-window=yes',
      '--no-osc',
      '--no-osd-bar',
      // yt-dlp is not installed and ytdl_hook otherwise grabs every failed open, turning one bad connect
      // into ~10s of subprocess probing.
      '--no-ytdl',
      // A transcode playlist is a live stream to ffmpeg unless told otherwise; this makes it seekable.
      '--force-seekable=yes',
      `--hwdec=${l.prefs.hwdec}`,
      '--vo=gpu',
      '--gpu-api=d3d11',
      `--profile=${hq ? 'gpu-hq' : 'fast'}`,
      '--hr-seek=yes',
      '--video-sync=' + (hq ? 'display-resample' : 'audio'),
      '--interpolation=' + (hq ? 'yes' : 'no'),
      '--demuxer-max-bytes=220MiB',
      '--demuxer-max-back-bytes=120MiB',
      '--demuxer-readahead-secs=20',
      '--network-timeout=30',
      // Which subtitle the demuxer should pick when the file marks nothing: Chinese first, then whatever
      // exists, so a bilingual file does not open in the language that happens to be track 1.
      '--slang=zh,chi,zho,c*,en*,eng',
      '--sub-bold=yes',
      '--sub-border-size=3',
      '--sub-shadow-offset=1',
      '--sub-font-size=52',
      `--volume-max=${VOLUME_MAX}`,
      // One --demuxer-lavf-o per process: mpv replaces rather than merges the list.
      // Streams arrive over loopback from the bridge, so reconnecting here makes mpv re-request localhost
      // while Chromium retries the real server behind it.
      `--demuxer-lavf-o=${['reconnect=1', 'reconnect_streamed=1', 'reconnect_delay_max=5'].join(',')}`,
    ];
    if (hq) a.push('--scale=ewa_lanczossharp', '--cscale=ewa_lanczossharp', '--tscale=oversample');
    // Give the display the HDR signal instead of tone-mapping it. Off by default: on a screen that cannot
    // show it the picture washes out, which is worse than mpv's own mapping.
    if (l.prefs.hdrHint) a.push('--target-colorspace-hint=yes');
    return a;
  }

  async start(l: KernelLaunch): Promise<void> {
    if (this.proc) throw new Error('mpv 已经在运行');
    const exe = mpvExecutable();
    this.launchedRender = l.prefs.render;
    this.quitting = false;
    this.raw = { ...freshRaw(), volume: 100 };
    this.proc = spawn(exe, this.args(l), { cwd: path.dirname(exe), windowsHide: true });
    this.proc.on('exit', (code, signal) => {
      this.proc = null;
      this.pipe.close();
      this.clearTimer();
      if (this.quitting) return;
      this.onGone(signal ? undefined : `播放器进程退出了（代码 ${code}）`);
    });
    this.proc.stderr?.setEncoding('utf8');
    this.proc.stderr?.on('data', d => {
      const t = String(d).trim();
      if (t) console.error('[mpv]', t.slice(0, 300));
    });

    await this.pipe.connect(this.pipeName);
    this.pipe.onEvent = m => this.onMessage(m);
    this.pipe.onSocketClose = () => this.onGone('播放器断开了连接');
    await Promise.all(OBSERVED.map(name => this.pipe.tryCall(['observe_property', 1, name])));
    // mpv only reports the first volume/speed values on change, so read the launch defaults once.
    for (const name of ['volume', 'mute', 'pause', 'speed']) await this.pullInitial(name);
    this.mark(true);
  }

  private async pullInitial(name: string): Promise<void> {
    const v = await this.pipe.tryCall(['get_property', name]);
    this.apply(name, v);
  }

  private onMessage(m: MpvMessage): void {
    switch (m.event) {
      case 'property-change':
        if (m.name) {
          this.apply(m.name, m.data);
          this.mark();
        }
        return;
      case 'start-file':
        this.raw = { ...freshRaw(), volume: this.raw.volume, muted: this.raw.muted, speed: this.raw.speed, fullscreen: this.raw.fullscreen, loaded: true, opening: true };
        this.mark(true);
        return;
      case 'file-loaded': {
        this.raw.opening = false;
        // `options/start` is not writable in this build (measured), so the resume position is applied here,
        // when mpv finally has a timeline to seek against.
        if (this.startAt > 0) {
          void this.pipe.call(['set_property', 'playback-time', this.startAt]).catch(() => undefined);
          this.startAt = 0;
        }
        this.mark(true);
        return;
      }
      case 'end-file':
        // eof never arrives here while --keep-open=yes is on; a `stop` is our own reload (a quality switch)
        // and a `redirect` is a server sending us elsewhere, so neither may be painted as a failure.
        if (m.reason === 'error') {
          this.raw.error = '无法打开这条视频流，可能是服务器端的问题';
          this.raw.opening = false;
        }
        this.mark(true);
        return;
      default:
        return;
    }
  }

  private apply(name: string, v: any): void {
    const r = this.raw;
    switch (name) {
      case 'time-pos': {
        const s = sec(v);
        if (s !== undefined) r.timePos = s;
        // A user seek out of the end must clear the end flag; mpv does it itself but only after the seek
        // lands, and the bar would flicker back to 重播 in between.
        if (s !== undefined && r.eof && s < (r.duration ?? 0) - 1) r.eof = false;
        return;
      }
      case 'duration': {
        const s = sec(v);
        if (s !== undefined) r.duration = s;
        return;
      }
      case 'pause':
        if (typeof v === 'boolean') r.paused = v;
        return;
      case 'volume':
        if (typeof v === 'number') r.volume = Math.round(v);
        return;
      case 'mute':
        if (typeof v === 'boolean') r.muted = v;
        return;
      case 'speed':
        if (typeof v === 'number') r.speed = v;
        return;
      case 'eof-reached':
        r.eof = v === true;
        return;
      case 'demuxer-cache-state':
        r.cacheEnd = sec(v?.['cache-end']);
        return;
      case 'hwdec-current':
        r.hwdec = typeof v === 'string' ? v : v == null ? '' : String(v);
        return;
      case 'container-fps':
        r.fps = sec(v) ?? 0;
        return;
      case 'video-params':
        r.width = Number(v?.w) || 0;
        r.height = Number(v?.h) || 0;
        r.fps = sec(v?.fps) ?? r.fps;
        {
          const gamma = String(v?.gamma ?? '');
          const primaries = String(v?.['color-primaries'] ?? '');
          r.hdr = gamma === 'pq' || gamma === 'hlg' || primaries === 'bt.2020';
          r.colorSpace = v?.['color-space'] ? String(v['color-space']) : undefined;
        }
        return;
      case 'track-list':
        r.tracks = Array.isArray(v) ? withOrdinals(v.map(mapTrack).filter(Boolean) as Omit<PlayerTrack, 'ordinal'>[]) : [];
        return;
      case 'chapter-list':
        r.chapters = Array.isArray(v)
          ? v.map((c: any, i: number): PlayerChapter | null => (c && Number.isFinite(c.time) ? { index: Number(c.id ?? i), title: String(c.title || `章节 ${i + 1}`), timeMs: Math.round(c.time * 1000) } : null)).filter((c): c is PlayerChapter => !!c)
          : [];
        return;
      case 'sid':
        r.subtitle = selection(v);
        return;
      case 'aid':
        r.audio = selection(v);
        return;
      case 'vid':
        r.video = selection(v);
        return;
      case 'sub-delay':
        r.subDelay = Math.round((sec(v) ?? 0) * 1000);
        return;
      case 'audio-delay':
        r.audioDelay = Math.round((sec(v) ?? 0) * 1000);
        return;
      case 'sub-scale':
        // Measured on this build: `sub-scale` is a multiplier (1 = 100%), so the panel's percent is
        // divided on the way in and multiplied on the way back out.
        r.subScale = Math.round((sec(v) ?? 1) * 100);
        return;
      case 'sub-pos':
        r.subPos = Math.round(sec(v) ?? 100);
        return;
      case 'video-aspect-override':
        r.aspect = aspectSelection(v);
        return;
      case 'panscan':
        r.panscan = Number(v) || 0;
        return;
      default:
        return;
    }
  }

  private status(): PlayerStatus {
    const r = this.raw;
    if (r.error) return 'error';
    if (!r.loaded) return 'idle';
    if (r.opening) return 'opening';
    if (r.eof) return 'ended';
    return r.paused ? 'paused' : 'playing';
  }

  private state(): PlayerState {
    const r = this.raw;
    return {
      status: this.status(),
      positionMs: Math.round((r.timePos ?? 0) * 1000),
      durationMs: Math.round((r.duration ?? 0) * 1000),
      bufferedMs: Math.round((r.cacheEnd ?? r.timePos ?? 0) * 1000),
      paused: !!r.paused,
      volume: r.volume ?? 100,
      muted: !!r.muted,
      speed: r.speed ?? 1,
      fullscreen: r.fullscreen,
      error: r.error,
    };
  }

  private media(): PlayerMedia {
    const r = this.raw;
    return {
      width: r.width,
      height: r.height,
      fps: r.fps,
      hwdec: r.hwdec,
      hdr: r.hdr,
      colorSpace: r.colorSpace,
      trackCount: r.tracks.length,
      tracks: r.tracks,
      chapters: r.chapters,
      subtitle: r.subtitle,
      audio: r.audio,
      video: r.video,
      subtitleDelayMs: r.subDelay,
      audioDelayMs: r.audioDelay,
      subtitleScale: r.subScale,
      subtitlePos: r.subPos,
      aspect: r.aspect,
      panscan: r.panscan,
    };
  }

  /** time-pos arrives often enough to be worth coalescing; a status change must not wait behind that. */
  private mark(now = false): void {
    if (now) {
      this.clearTimer();
      this.emit();
      return;
    }
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.emit(); }, 200);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private lastState?: PlayerState;
  private lastMedia?: PlayerMedia;

  private emit(): void {
    const s = this.state();
    if (!this.lastState || JSON.stringify(s) !== JSON.stringify(this.lastState)) {
      this.lastState = s;
      this.onState(s);
    }
    const m = this.media();
    // Tracks and chapters only change with the file, so this half is only sent when it really differs.
    if (!this.lastMedia || JSON.stringify(m) !== JSON.stringify(this.lastMedia)) {
      this.lastMedia = m;
      this.onMedia(m);
    }
  }

  setFullscreen(on: boolean): void {
    this.raw.fullscreen = on;
    this.mark(true);
  }

  /** Position without waiting for the next event, for a progress report that has to be exact. */
  async positionMs(): Promise<number> {
    const v = await this.pipe.tryCall(['get_property', 'time-pos']);
    const s = sec(v);
    if (s === undefined) return this.state().positionMs;
    return Math.round(s * 1000);
  }

  async load(url: string, opts: { startMs?: number } = {}): Promise<void> {
    this.startAt = Math.max(0, (opts.startMs || 0) / 1000);
    await this.pipe.call(['loadfile', url, 'replace']);
  }

  async setPaused(on: boolean): Promise<void> {
    await this.pipe.call(['set_property', 'pause', on]);
    // eof is a property that latches while keep-open holds the file; pausing at the end is still 已结束,
    // but resuming from it has to rewind first or nothing visibly happens.
    if (!on && this.raw.eof) await this.rewind();
  }

  /** Play from the top of a file that has reached its end. Measured: at eof the four commands that look
   *  right (`revert-seek`, `playlist-next`, `loadfile` with no flags, `set pause`) all do nothing; a seek
   *  back inside the same file is the one that works. */
  async rewind(): Promise<void> {
    this.raw.eof = false;
    await this.pipe.call(['set_property', 'playback-time', 0]).catch(() => undefined);
    await this.pipe.call(['set_property', 'pause', false]).catch(() => undefined);
    this.mark(true);
  }

  async seekTo(ms: number): Promise<void> {
    const to = Math.max(0, ms / 1000);
    if (this.raw.eof && to < (this.raw.duration ?? 0) - 1) this.raw.eof = false;
    await this.pipe.call(['set_property', 'playback-time', to]);
    this.raw.timePos = to;
    this.mark(true);
  }

  async seekBy(deltaMs: number): Promise<void> {
    const cur = sec(await this.pipe.tryCall(['get_property', 'time-pos'])) ?? this.raw.timePos ?? 0;
    await this.seekTo((cur + deltaMs / 1000) * 1000);
  }

  async seekFraction(ratio: number): Promise<void> {
    const dur = sec(await this.pipe.tryCall(['get_property', 'duration'])) ?? this.raw.duration ?? 0;
    await this.seekTo(Math.max(0, Math.min(1, ratio)) * dur * 1000);
  }

  async setVolume(v: number): Promise<void> {
    await this.pipe.call(['set_property', 'volume', Math.max(0, Math.min(VOLUME_MAX, Math.round(v)))]);
  }

  async setMuted(on: boolean): Promise<void> {
    await this.pipe.call(['set_property', 'mute', on]);
  }

  async setSpeed(v: number): Promise<void> {
    await this.pipe.call(['set_property', 'speed', Math.max(0.1, Math.min(4, v))]);
  }

  /** sid/aid/vid take a track id, "no" (off) or "auto" (let mpv choose). */
  async setTrack(kind: 'video' | 'audio' | 'subtitle', id: TrackSelection): Promise<void> {
    const prop = kind === 'video' ? 'vid' : kind === 'audio' ? 'aid' : 'sid';
    await this.pipe.call(['set_property', prop, id]);
  }

  async setSubtitleDelay(ms: number): Promise<void> {
    await this.pipe.call(['set_property', 'sub-delay', ms / 1000]);
  }

  async setAudioDelay(ms: number): Promise<void> {
    await this.pipe.call(['set_property', 'audio-delay', ms / 1000]);
  }

  async setSubtitleStyle(v: { scale?: number; pos?: number }): Promise<void> {
    // The percent the panel shows becomes the multiplier this build expects; sending 130 is refused
    // outright (measured: 「unsupported format for accessing property」), and 1.3 is what means 130%.
    if (v.scale !== undefined) await this.pipe.call(['set_property', 'sub-scale', Math.max(0.5, Math.min(2.5, v.scale / 100))]);
    if (v.pos !== undefined) await this.pipe.call(['set_property', 'sub-pos', Math.max(0, Math.min(100, v.pos))]);
  }

  async setAspect(v: TrackSelection): Promise<void> {
    await this.pipe.call(['set_property', 'video-aspect-override', v]);
  }

  async setPanscan(v: number): Promise<void> {
    await this.pipe.call(['set_property', 'panscan', Math.max(0, Math.min(1, v))]);
  }

  /** mpv's chapter ids are indices into chapter-list. */
  async jumpChapter(index: number): Promise<void> {
    await this.pipe.call(['set_property', 'chapter', index]);
  }

  /** Measured: `frame-step` and `frame-back-step` take no arguments — passing a count is answered with
   *  「error running command」 — and both only succeed while the file is paused, so the pause comes first
   *  and a count becomes a loop. */
  async frameStep(n: number): Promise<void> {
    const steps = Math.max(1, Math.min(30, Math.round(Math.abs(n))));
    if (!this.raw.paused) await this.pipe.call(['set_property', 'pause', true]);
    const command = n < 0 ? 'frame-back-step' : 'frame-step';
    for (let i = 0; i < steps; i++) await this.pipe.call([command]);
    this.mark(true);
  }

  async setHwdec(v: string): Promise<void> {
    await this.pipe.call(['set_property', 'hwdec', v]);
  }

  async quit(): Promise<void> {
    this.clearTimer();
    const p = this.proc;
    this.quitting = true;
    this.proc = null;
    // Best effort: an idle mpv answers `quit`, a wedged one does not, and either way the process must not
    // outlive the player window.
    await this.pipe.call(['quit'], 1500).catch(() => undefined);
    this.pipe.close();
    if (!p) return;
    await new Promise<void>(resolve => {
      const t = setTimeout(() => {
        if (p.exitCode === null) p.kill('SIGKILL');
        resolve();
      }, 1500);
      p.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.raw = freshRaw();
    this.lastState = undefined;
    this.lastMedia = undefined;
  }
}
