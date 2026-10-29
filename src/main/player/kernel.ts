import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MpvPipe, type MpvMessage } from './mpv-pipe';
import { ANIME4K_SHADERS, type Anime4kLevel } from '../../shared/anime4k';
import { cleanTrackTitle } from '../track-title';
import {
  VOLUME_MAX,
  type FitMode,
  type PlayerChapter,
  type PlayerMedia,
  type PlayerState,
  type PlayerStatus,
  type PlayerTrack,
  type TrackSelection,
} from '../../shared/types';

export interface KernelLaunch {
  hwnd: string;
  prefs: { hwdec: string; fit: FitMode; anime4k: Anime4kLevel };
}

export function mpvExecutable(): string {
  const dir = path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'resources', 'mpv');
  const exe = path.join(dir, 'mpv.exe');
  if (existsSync(exe)) return exe;
  throw new Error(`没有找到 mpv.exe（${dir}），运行 \`npm run mpv\` 获取它`);
}

/** The bundled Anime4K chain, resolved beside mpv rather than from a URL: the shaders ship with the app
 *  (resources/shaders/anime4k, MIT) and a level is nothing but a list of files inside it. Packaged builds
 *  put that folder under process.resourcesPath, exactly like resources/mpv above. */
export function shaderPaths(level: Anime4kLevel): string[] {
  const root = path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'resources', 'shaders', 'anime4k');
  return ANIME4K_SHADERS[level].map(f => path.join(root, f));
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
  /** Bytes per second the demuxer is pulling off the wire, smoothed over the window below. */
  netRate: number;
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
  /** False while 拉伸填满 is in force: the frame no longer keeps its own shape. */
  keepaspect: boolean;
  fullscreen: boolean;
}

const freshRaw = (): Raw => ({
  loaded: false,
  opening: false,
  netRate: 0,
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
  keepaspect: true,
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
  'keepaspect',
];

const sec = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** mpv calls a subtitle track `sub`; everything else on the panel is named the way the app names it.
 *  An attached picture is a cover inside an audio file, not a picture anyone chose to watch: measured on
 *  the bundled 0.41 build against a file of known stream order, that row comes back as `image:true` and
 *  there is no `attached_pic` key at all. `id` restarts at 1 inside each kind and is what sid/aid/vid take,
 *  while `ff-index` is the container's own number for the stream — the number the server uses too. */
const mapTrack = (t: any): PlayerTrack | null => {
  if (!t || typeof t.id !== 'number') return null;
  if (t.type === 'video' && t.image) return null;
  const kind: PlayerTrack['kind'] = t.type === 'sub' ? 'subtitle' : t.type === 'audio' ? 'audio' : 'video';
  return {
    id: t.id,
    kind,
    ffIndex: sec(t['ff-index']),
    title: typeof t.title === 'string' ? cleanTrackTitle(t.title) : undefined,
    lang: typeof t.lang === 'string' && t.lang ? t.lang : undefined,
    codec: typeof t.codec === 'string' ? t.codec : undefined,
    // Only the count: demux-channels answered 「unknown6」 on a 5.1 track of the file this was measured on,
    // so the layout word has to come from the server's own row for the same stream number.
    channels: sec(t['demux-channel-count']),
    selected: !!t.selected,
    default: !!t.default,
    forced: !!t.forced,
    external: !!t.external,
  };
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
  /** Paused at the moment the file was replaced, re-applied once the new file is loaded: mpv discards a
   *  pause set between the loadfile command and the demuxer opening the next file, so the reload behind a
   *  HDR switch used to start a film the viewer had left on a frame (measured 2026-10-29). */
  private pausedAtLoad = false;
  /** What the caller asked the file being loaded to do about pause, when it said anything. mpv carries its
   *  own `pause` across `loadfile`, so a film that ended (keep-open leaves the process paused) used to hand
   *  that pause to whatever opened next — 自动下一集 opened the next episode frozen at 0:00 (measured
   *  2026-10-29). `null` keeps the inherit-what-was-playing rule the HDR switch depends on. */
  private pausedWanted: boolean | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** A process we asked to quit is not a crash, so neither its exit nor the socket that goes down with it
   *  may reach `onGone` - that is the session's last-resort write of the position, and a socket with no
   *  such guard turned every deliberate teardown into a server report: measured 2026-10-27, one viewing
   *  whose two mid-play restarts each logged `[player] 退出 gone` + `停止已写` before the real
   *  `close` one. */
  private quitting = false;
  /** One process dies once. A real death announces itself twice - the child's `exit`, and the pipe socket
   *  that `exit` closes a line later - and each notice used to run the write: measured the same day by
   *  killing a playing mpv, two `退出 gone` lines and two identical POSTs, because `flushStop` reads
   *  `flushedMs` before it awaits the request, so the second one checks a number the first has not
   *  stamped yet. */
  private goneReported = false;
  readonly pipeName = `echoemby-mpv-${randomUUID().slice(0, 8)}`;

  onState: (s: PlayerState) => void = () => undefined;
  onMedia: (m: PlayerMedia) => void = () => undefined;
  /** The process is gone: whoever owns the session must stop talking to a dead player. */
  onGone: (message?: string) => void = () => undefined;

  get running(): boolean {
    return !!this.proc;
  }

  private args(l: KernelLaunch): string[] {
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
      // A library kept as an HLS folder reaches mpv as a stream that looks live, and this is what lets the
      // bar move on it anyway.
      '--force-seekable=yes',
      `--hwdec=${l.prefs.hwdec}`,
      // gpu-next, not gpu: measured on this machine 2026-10-29 against the same frames — libplacebo's renderer
      // lands 19% darker-shadow detail and 5 points more saturation on HDR10, and 12 points more on Dolby
      // Vision, which the legacy path does not reshape at all. It costs ~40% more of one core (0.96 s vs
      // 0.69 s of CPU per 12 s of 4K HDR), which the machine has to spare.
      '--vo=gpu-next',
      '--gpu-api=d3d11',
      // One launch shape for every file. `gpu-hq` is a bundle of settings mpv cannot un-set at runtime, so
      // it can only be chosen here — and with no knob to move, the choice is the one this machine has been
      // running on: the sharp scalers, at the cost of some GPU work the player no longer trades away.
      '--profile=gpu-hq',
      '--scale=ewa_lanczossharp',
      '--cscale=ewa_lanczossharp',
      '--tscale=oversample',
      '--hr-seek=yes',
      // Pacing never comes from the display. Measured 2026-10-27 on a 144 Hz screen with a 24 fps file:
      // `display-resample` advanced mpv's own `time-pos` at 5.94-6.05× wall clock (6 = 144 ÷ 24) while
      // `speed` stayed 1, `duration` matched the server's to the second and not one frame was dropped —
      // so the film's clock, not the picture, was running fast, and every 看到 offset inherited it.
      // Switching `video-sync` at runtime wedges playback outright (the clock froze for 90 s and did not
      // resume when switched back), so the only place to decide this is here, before the process starts.
      '--video-sync=audio',
      // Interpolation is display-sync's companion — mpv's own docs warn about A/V drift when it runs on an
      // audio clock — so gpu-hq keeps its spatial scalers and lets this one go.
      '--interpolation=no',
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
    /* No --target-colorspace-hint: what that flag did was tell mpv to describe the display instead of asking
       it, and on a desktop already in HDR mpv reads the mode back on its own (measured 2026-10-29: the same
       PQ swapchain with and without it). Whether the desktop is in HDR at all is now decided before launch,
       by the window HDR switch in session.ts — see player/hdr.ts. */
    /* The picture fit travels the same way, and for the same reason: panscan and keepaspect are plain
       options, and a run that started in the wrong pair would draw bars (or a squashed frame) for the
       fraction of a second before the runtime call landed. */
    if (l.prefs.fit === 'fill') a.push('--panscan=1.0');
    if (l.prefs.fit === 'stretch') a.push('--keepaspect=no');
    /* 画质增强 travels the same way, and for a sharper reason: a shader list moved by a property write after
       the file is open recompiles the chain under a frame already on screen. Appending one argument per file
       is the spelling this build accepts on a command line — one argument holding `a;b` is read as one
       filename and answered with 「Error parsing option glsl-shaders」. */
    for (const f of shaderPaths(l.prefs.anime4k)) a.push(`--glsl-shaders-append=${f}`);
    return a;
  }

  /** The one door out of a live process: a teardown we asked for never goes through it, and a death that
   *  announces itself twice only gets one notice through. */
  private fireGone(message?: string): void {
    if (this.quitting || this.goneReported) return;
    this.goneReported = true;
    this.onGone(message);
  }

  async start(l: KernelLaunch): Promise<void> {
    if (this.proc) throw new Error('mpv 已经在运行');
    const exe = mpvExecutable();
    this.quitting = false;
    this.goneReported = false;
    this.raw = { ...freshRaw(), volume: 100 };
    this.proc = spawn(exe, this.args(l), { cwd: path.dirname(exe), windowsHide: true });
    this.proc.on('exit', (code, signal) => {
      this.proc = null;
      this.pipe.close();
      this.clearTimer();
      this.fireGone(signal ? undefined : `播放器进程退出了（代码 ${code}）`);
    });
    this.proc.stderr?.setEncoding('utf8');
    this.proc.stderr?.on('data', d => {
      const t = String(d).trim();
      if (t) console.error('[mpv]', t.slice(0, 300));
    });

    await this.pipe.connect(this.pipeName);
    this.pipe.onEvent = m => this.onMessage(m);
    this.pipe.onSocketClose = () => this.fireGone('播放器断开了连接');
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
        /* A new file resets the per-file half of this state, and mpv announces that half again as it loads —
           but the picture fit is not per-file. `--panscan` and `--keepaspect` are launch options that a
           later `set_property` only moves: mpv keeps them across files and so pushes no event, which made
           this wholesale reset report the defaults over the picture actually on screen (measured 2026-10-29:
           a process started with `--keepaspect=no` showed 拉伸填满 in the 画面 panel's own reading of mpv,
           and 适应屏幕 in the app). They ride across beside volume and speed for that reason. */
        this.raw = { ...freshRaw(), volume: this.raw.volume, muted: this.raw.muted, speed: this.raw.speed, fullscreen: this.raw.fullscreen, aspect: this.raw.aspect, panscan: this.raw.panscan, keepaspect: this.raw.keepaspect, loaded: true, opening: true };
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
        this.applyWanted();
        if (this.pausedWanted !== null) {
          const want = this.pausedWanted;
          this.pausedWanted = null;
          this.pausedAtLoad = false;
          this.raw.paused = want;
          void this.pipe.call(['set_property', 'pause', want]).catch(() => undefined);
        } else if (this.pausedAtLoad) {
          this.pausedAtLoad = false;
          // mpv already held the film still, so this write changes nothing on its side and it announces
          // nothing back; the start-file reset above had cleared the only local record of it (measured
          // 2026-10-29: mpv answered pause=true while the app still drew 播放中).
          this.raw.paused = true;
          void this.pipe.call(['set_property', 'pause', true]).catch(() => undefined);
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
        this.sampleRate(sec(v?.['total-bytes']));
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
          // The key names are mpv's own, read off the live pipe on 2026-10-28: `video-params` answers
          // `colormatrix`/`primaries`/`gamma`/`colorlevels`, and there is no `color-space` or
          // `color-primaries` in it at all. Both of those names used to be read here, so the 色彩空间 row
          // could only ever print its dash and the bt.2020 half of the HDR test never ran.
          const gamma = String(v?.gamma ?? '');
          const primaries = String(v?.primaries ?? '');
          r.hdr = gamma === 'pq' || gamma === 'hlg' || primaries === 'bt.2020';
          // 色彩空间 asks which primaries the picture is drawn in, and that is `primaries`: measured on the
          // same pipe a minute later, the 挽救计划 杜比视界 version answers `primaries: bt.2020` while its
          // `colormatrix` says `dolbyvision` — a Y′CbCr matrix name, not a colour space, and the same word
          // the 这条片源 line above it already prints. The matrix is the fallback for a file whose primaries
          // are absent, and `colorSpaceWord` refuses to print it when it says `dolbyvision`.
          r.colorSpace = primaries || (v?.colormatrix ? String(v.colormatrix) : '');
        }
        return;
      case 'track-list':
        r.tracks = Array.isArray(v) ? v.map(mapTrack).filter(Boolean) as PlayerTrack[] : [];
        this.applyWanted();
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
        break;
      case 'keepaspect':
        r.keepaspect = v === true || v === 'yes';
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

  /** mpv only answers `demuxer-cache-state` when the cache moves, so the samples arrive in bursts; a
   *  three-second window is what keeps the read-out from flickering between a spike and zero. */
  private rateWin: { t: number; b: number }[] = [];

  /** The rate the window last measured, kept across the gaps between bursts. */
  private rateHold = 0;

  private sampleRate(bytes: number | undefined): void {
    const r = this.raw;
    const now = Date.now();
    if (bytes != null) {
      // A counter that went backwards is a new file: the old window would report the last stream's rate.
      if (this.rateWin.length && bytes < this.rateWin[this.rateWin.length - 1].b) {
        this.rateWin = [];
        this.rateHold = 0;
      }
      this.rateWin.push({ t: now, b: bytes });
    }
    while (this.rateWin.length > 1 && now - this.rateWin[0].t > 3000) this.rateWin.shift();
    const first = this.rateWin[0];
    const last = this.rateWin[this.rateWin.length - 1];
    // Nothing has arrived for longer than the window itself, so the window is describing a stream that
    // is no longer running: this is the one case where 「0」 is the truth rather than a gap in sampling.
    if (!last || now - last.t > 3000) {
      this.rateWin = [];
      this.rateHold = 0;
      r.netRate = 0;
      return;
    }
    /* Dividing the window's bytes by the window's own span, not by `now`: a tick between two bursts has
       one sample in it, and one sample has no slope, so the previous reading used to be written `0` — the
       corner snapped to 「0 KB/s」 for a quarter to two thirds of a second, several times a row, while the
       stream never stopped. Holding the last measured slope instead costs nothing when bytes do arrive,
       because the span always contains at least as much time as the burst did. */
    const secs = (last.t - first!.t) / 1000;
    if (secs > 0.4) this.rateHold = Math.max(0, (last.b - first!.b) / secs);
    r.netRate = this.rateHold;
  }

  private state(): PlayerState {
    const r = this.raw;
    return {
      status: this.status(),
      positionMs: Math.round((r.timePos ?? 0) * 1000),
      durationMs: Math.round((r.duration ?? 0) * 1000),
      bufferedMs: Math.round((r.cacheEnd ?? r.timePos ?? 0) * 1000),
      netBytesPerSec: Math.round(r.netRate),
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
      keepaspect: r.keepaspect,
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

  async load(url: string, opts: { startMs?: number; paused?: boolean } = {}): Promise<void> {
    this.startAt = Math.max(0, (opts.startMs || 0) / 1000);
    this.pausedAtLoad = this.raw.paused === true;
    this.pausedWanted = typeof opts.paused === 'boolean' ? opts.paused : null;
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

  /** The streams the 首选语言 settings answered with, waiting for the file to be open: `audio`/`subtitle` are
   *  the server's own `Index` for those streams — the one number mpv repeats as `ff-index` — and `'no'` is
   *  关闭字幕.
   *
   *  It cannot be set before the load. mpv's `aid`/`sid` take a *track* id, which is handed out when a file
   *  is opened and means nothing before that, so a property written on an idle pipe would either be refused or,
   *  worse, sit waiting and land on whatever opened next. The list mpv publishes with the file is the first
   *  moment both numbers exist and can be lined up, and `file-loaded` is the second chance for a file whose
   *  list arrives in more than one pass as the demuxer adds streams. Each answer is applied once and then
   *  forgotten, so a knob the viewer turns by hand later is never pulled back. */
  private wanted: { audio?: number; subtitle?: number | 'no' } | null = null;

  /** Called by the session before every load — a first play and a version switch alike — with the answer for
   *  the file about to open, or null when nothing is to be forced. Null is a real answer: it is what clears a
   *  pick that the previous file never matched. */
  setNextTracks(w: { audio?: number; subtitle?: number | 'no' } | null): void {
    this.wanted = w && (w.audio !== undefined || w.subtitle !== undefined) ? w : null;
  }

  private applyWanted(): void {
    const w = this.wanted;
    if (!w) return;
    const tracks = this.raw.tracks;
    if (!tracks.length) return;
    if (w.audio !== undefined) {
      const t = tracks.find(t => t.kind === 'audio' && t.ffIndex === w.audio);
      if (t) {
        w.audio = undefined;
        void this.pipe.call(['set_property', 'aid', t.id]).catch(() => undefined);
      }
    }
    if (w.subtitle !== undefined) {
      const want = w.subtitle;
      if (want === 'no') {
        w.subtitle = undefined;
        void this.pipe.call(['set_property', 'sid', 'no']).catch(() => undefined);
      } else {
        const t = tracks.find(t => t.kind === 'subtitle' && t.ffIndex === want);
        if (t) {
          w.subtitle = undefined;
          void this.pipe.call(['set_property', 'sid', t.id]).catch(() => undefined);
        }
      }
    }
    if (w.audio === undefined && w.subtitle === undefined) this.wanted = null;
  }
  /** sid/aid/vid take a track id, "no" (off) or "auto" (let mpv choose). */
  async setTrack(kind: 'video' | 'audio' | 'subtitle', id: TrackSelection): Promise<void> {
    const prop = kind === 'video' ? 'vid' : kind === 'audio' ? 'aid' : 'sid';
    await this.pipe.call(['set_property', prop, id]);
  }

  /** Hand mpv a subtitle that lives outside the stream it opened. `sub-add` gives it a track of its own,
   *  numbered after the file's, and the only way to learn that number is to read the list back — which is
   *  also what makes a second pick replace the first instead of piling up. */
  async addSubtitleFile(file: string, title: string): Promise<number | null> {
    await this.pipe.call(['sub-add', file, 'auto', title]);
    const list = await this.pipe.tryCall(['get_property', 'track-list']);
    const subs = Array.isArray(list) ? list as any[] : [];
    for (let i = subs.length - 1; i >= 0; i--) {
      const t = subs[i];
      if (t?.type === 'sub' && t?.external && typeof t.id === 'number') return t.id;
    }
    return null;
  }

  async removeSubtitleFile(id: number): Promise<void> {
    await this.pipe.call(['sub-remove', id]);
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

  /** 适应屏幕 / 填满屏幕 / 拉伸填满, in mpv's own two words. `keepaspect` goes first: panscan only means
   *  anything while the frame keeps its own shape, and a 1.0 left behind under a stretched frame would crop
   *  the picture again on the next resize. */
  async setFit(mode: FitMode): Promise<void> {
    await this.pipe.call(['set_property', 'keepaspect', mode !== 'stretch']);
    await this.setPanscan(mode === 'fill' ? 1 : 0);
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

  /** mpv announces `hwdec-current` only when it changes, and a switch that lands on the decoder already in
   *  use changes nothing - so picking D3D11 while 自动 had already settled on d3d11va left the 解码 row on
   *  「正在用 —」 until the next file (measured 2026-10-29). The value is read back because the switch itself
   *  reports nothing; a decoder that is still tearing down answers empty for a moment, hence the retries. */
  async setHwdec(v: string): Promise<void> {
    await this.pipe.call(['set_property', 'hwdec', v]);
    for (let i = 0; i < 4; i++) {
      const now = await this.pipe.call(['get_property', 'hwdec-current']).catch(() => null);
      if (typeof now === 'string' && now) {
        this.raw.hwdec = now;
        this.mark(true);
        return;
      }
      await new Promise(r => setTimeout(r, 250));
    }
  }

  /** 画质增强, as one property write: mpv reparses and recompiles the whole list on every change, so a shader
   *  at a time would compile the chain again for each member of it. An empty array is 关闭 and is not the
   *  same as leaving the property alone — it is how the chain leaves a player that is already running.
   *  Measured 2026-10-29 on a running file: the swap happens between frames, the position does not move and
   *  nothing is dropped. */
  async setAnime4k(level: Anime4kLevel): Promise<void> {
    await this.pipe.call(['set_property', 'glsl-shaders', shaderPaths(level)]);
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
