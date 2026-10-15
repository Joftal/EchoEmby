import * as config from '../config';
import { QUALITY_TIERS } from '../config';
import { EmbyClient, type Identity, type ProgressInput } from '../emby/client';
import { explain } from '../emby/errors';
import {
  emptyPlayerMedia,
  emptyPlayerState,
  type DanmakuQuery,
  type LibraryItem,
  type PlayerCommand,
  type PlayerMedia,
  type PlayerNav,
  type PlayerSession,
  type PlayerState,
  type PlayerPrefs,
  type PlaybackSource,
  type PlayMethod,
  type QualityTier,
} from '../../shared/types';
import { MpvKernel } from './kernel';
import { StreamBridge } from './bridge';
import { PlayerWindows } from './windows';

/** What the renderer is told, and when. The controller never touches ipc itself, so the same object can
 *  be driven from a test with three arrays to collect into. */
export interface PlayerOut {
  state(s: PlayerState): void;
  session(s: PlayerSession | null): void;
  media(m: PlayerMedia): void;
  /** Bring the library window back once the player is gone. */
  reveal(): void;
}

/** What is playing right now. Replaced whole on every load, so no half-switched session can be reported
 *  while a quality change is in flight. */
interface Current {
  itemId: string;
  name: string;
  line: string;
  seriesId?: string;
  seasonId?: string;
  sources: PlaybackSource[];
  sourceIndex: number;
  playSessionId: string;
  method: PlayMethod | '';
  hdr: boolean;
  /** The upstream address the bridge is mounted on: kept so a new mpv process can be handed the same
   *  stream without asking the server what it decided again. */
  url: string;
  tiers: QualityTier[];
  /** The rung this stream was actually negotiated at, which is not necessarily the one the settings row
   *  shows while a change is still in flight. */
  tier: number;
  next: PlayerNav | null;
  prev: PlayerNav | null;
  danmaku: DanmakuQuery | null;
  /** Completing the same item twice must not POST 已播放 twice. */
  reported: boolean;
}

const tierLabel = (bitrate: number): string => (bitrate === 0 ? '原片' : `${Math.round(bitrate / 1_000_000)} Mbps`);

/** The ladder is a fixed list; the verdict on each rung is the server's, and only becomes known once that
 *  rung has been negotiated in this item's session. */
const tiersFor = (tier: number, method: PlayMethod, seen: Record<number, PlayMethod>): QualityTier[] =>
  QUALITY_TIERS.map(b => ({ bitrate: b, label: tierLabel(b), method: b === tier ? method : seen[b] }));

const navLabel = (it: LibraryItem): string => (it.indexNumber != null ? `第 ${it.indexNumber} 集` : it.name);

/**
 * The player's whole lifecycle: the mpv process, the two windows, the negotiation behind the stream and
 * the session reports that keep the server's copy of "where you are" true.
 *
 * One instance lives for the app's lifetime and holds no Emby client of its own, because the active
 * account can change between any two of its calls.
 */
export class PlayerController {
  private kernel: MpvKernel | null = null;
  private bridge = new StreamBridge();
  private current: Current | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private state: PlayerState = emptyPlayerState();
  private media: PlayerMedia = emptyPlayerMedia();
  private seenMethods = new Map<string, Record<number, PlayMethod>>();
  /** A deliberate close must not be reported as a crash by the process's exit handler. */
  private tearing = false;

  constructor(
    private windows: PlayerWindows,
    private out: PlayerOut,
    private rendererUrl: (hash: string) => string,
  ) {
    // The overlay can be closed by the window manager as well as by our own button, and mpv must not keep
    // painting into a host whose controls are gone.
    this.windows.onClosed = () => {
      if (!this.tearing) void this.close().catch(() => undefined);
    };
    this.windows.onFullscreen = on => this.kernel?.setFullscreen(on);
  }

  get running(): boolean {
    return !!this.kernel?.running;
  }

  getState(): PlayerState {
    return this.state;
  }

  getMedia(): PlayerMedia {
    return this.media;
  }

  getSession(): PlayerSession | null {
    const c = this.current;
    if (!c) return null;
    return {
      itemId: c.itemId,
      name: c.name,
      line: c.line,
      sourceId: c.sources[c.sourceIndex]?.id || '',
      sources: c.sources,
      sourceIndex: c.sourceIndex,
      tiers: c.tiers,
      tier: c.tier,
      method: c.method,
      hdr: c.hdr,
      next: c.next,
      prev: c.prev,
      seriesId: c.seriesId,
      seasonId: c.seasonId,
      danmaku: c.danmaku,
    };
  }

  private identity(): Identity {
    const c = config.get();
    return { deviceId: c.deviceId, deviceName: c.deviceName, clientName: c.clientName, clientVersion: c.clientVersion, language: 'zh-cn' };
  }

  private client(): EmbyClient {
    const acc = config.activeAccount();
    if (!acc) throw new Error('还没有登录任何服务器');
    return new EmbyClient(acc, this.identity());
  }

  /** Load one item into a player that may or may not exist yet. Everything the user can start — a card,
   *  下一集, the 选集 panel — comes through here, so a switch is a reload and never a restart. */
  async play(itemId: string): Promise<void> {
    this.tearing = false;
    const c = this.client();
    const prefs = config.get().settings.player;
    const item = await c.item(itemId);
    const [resume, nav] = await Promise.all([c.resumePoint(itemId), this.navFor(c, item)]);
    const neg = await c.negotiate(itemId, { tier: prefs.tier });

    // The windows only open once the server has agreed to serve something: a refused negotiation should
    // fail on the page 播放 was pressed from, not on a black screen with no controls.
    if (!this.windows.isOpen) this.windows.open(this.rendererUrl('#/player'));
    await this.ensureKernel(prefs);

    const url = await this.bridge.mount(neg.url);
    const seen = this.seenMethods.get(itemId) || {};
    seen[prefs.tier] = neg.method;
    this.seenMethods.set(itemId, seen);

    this.current = {
      itemId,
      name: item.name,
      line: this.lineOf(item),
      seriesId: item.seriesId,
      seasonId: item.type === 'Episode' ? item.seasonId || item.parentId : undefined,
      sources: neg.sources,
      sourceIndex: neg.sourceIndex,
      playSessionId: neg.playSessionId,
      method: neg.method,
      hdr: neg.hdr,
      url: neg.url,
      tiers: tiersFor(prefs.tier, neg.method, seen),
      tier: prefs.tier,
      next: nav.next,
      prev: nav.prev,
      danmaku: this.danmakuOf(item),
      reported: resume.played,
    };
    this.out.session(this.getSession());
    this.raise();

    try {
      await this.kernel!.load(url, { startMs: resume.startMs });
    } catch (e) {
      this.fail(e);
      throw e;
    }
    void this.report('start');
    this.startTicker();
  }

  /** The one line under a title: the season and episode for a show, the year for everything else. */
  private lineOf(item: LibraryItem): string {
    if (item.type === 'Episode') {
      const s = item.parentIndexNumber;
      const e = item.indexNumber;
      if (e == null) return item.seriesName || item.name;
      return [item.seriesName, s != null ? `第 ${s} 季` : '', `第 ${e} 集`].filter(Boolean).join(' · ');
    }
    return [item.productionYear ? String(item.productionYear) : '', item.officialRating || ''].filter(Boolean).join(' · ');
  }

  /** What a danmaku service is asked about. An episode called 「第 3 集」 matches nothing, so the series
   *  name travels with it and the layer keys the track to this item. */
  private danmakuOf(item: LibraryItem): DanmakuQuery {
    return {
      itemId: item.id,
      title: item.name,
      seriesName: item.type === 'Episode' ? item.seriesName || item.name : item.name,
      season: item.parentIndexNumber,
      episode: item.indexNumber,
    };
  }

  /** Prev and next are the neighbours inside this season. Walking out of it is the 选集 panel's job: the
   *  server has no NextUp answer to lean on (measured: /Shows/NextUp is empty on this gateway), and a
   *  guess across season boundaries would land on the wrong episode. */
  private async navFor(c: EmbyClient, item: LibraryItem): Promise<{ next: PlayerNav | null; prev: PlayerNav | null }> {
    const none = { next: null, prev: null };
    if (item.type !== 'Episode' || !item.seriesId) return none;
    const seasonId = item.seasonId || item.parentId;
    if (!seasonId) return none;
    const eps = await c.episodes(item.seriesId, seasonId).catch(() => []);
    const i = eps.findIndex(x => x.id === item.id);
    if (i < 0) return none;
    const at = (x?: LibraryItem): PlayerNav | null => (x ? { itemId: x.id, label: navLabel(x) } : null);
    return { next: at(eps[i + 1]), prev: at(eps[i - 1]) };
  }

  /** mpv only renders into a window handed to it at launch, so the handle and the profile must both be
   *  right before anything loads. A changed render profile is the one thing that needs a new process:
   *  `gpu-hq` is a bundle of settings mpv cannot un-set, so it is chosen by the command line. */
  private async ensureKernel(prefs: PlayerPrefs): Promise<void> {
    if (this.kernel?.running) {
      if (this.kernel.renderProfile === prefs.render) {
        // hwdec is runtime-settable, so switching decoders costs neither a reload nor a restart.
        await this.kernel.setHwdec(prefs.hwdec).catch(() => undefined);
        return;
      }
      await this.kernel.quit().catch(() => undefined);
      this.kernel = null;
    }
    const k = new MpvKernel();
    k.onState = s => this.onKernelState(s);
    k.onMedia = m => this.onKernelMedia(m);
    k.onGone = message => this.onGone(message);
    this.kernel = k;
    await k.start({ hwnd: this.windows.hostHwnd(), prefs: { hwdec: prefs.hwdec, hdrHint: prefs.hdrHint, render: prefs.render } });
    await this.windows.raiseVideoWhenReady();
  }

  private raise(): void {
    this.windows.raiseVideo();
    this.windows.focus();
  }

  private onGone(message?: string): void {
    this.stopTicker();
    this.kernel = null;
    if (this.tearing) return;
    this.state = { ...this.state, status: 'error', error: message || '播放器退出了' };
    this.out.state(this.state);
  }

  private fail(e: unknown): void {
    this.state = { ...this.state, status: 'error', error: explain(e) };
    this.out.state(this.state);
  }

  private onKernelState(s: PlayerState): void {
    this.state = s;
    this.out.state(s);
    if (s.status === 'ended') void this.onEnded().catch(e => this.fail(e));
  }

  private onKernelMedia(m: PlayerMedia): void {
    this.media = m;
    this.out.media(m);
  }

  /** Reaching the end is the only moment the server is told this item is finished, and it is also what
   *  makes 下一集 automatic. Measured: with --keep-open=yes the end never arrives as an end-file event —
   *  that is why the old `status === 'ended'` branch, and with it markPlayed, never ran. */
  private async onEnded(): Promise<void> {
    const c = this.current;
    if (!c || c.reported) return;
    c.reported = true;
    const client = this.client();
    await client.session(this.progressInput(false, this.state.durationMs), 'stopped');
    await client.markPlayed(c.itemId);
    const next = config.get().settings.player.autoNext ? c.next : null;
    if (next) await this.play(next.itemId);
  }

  private progressInput(paused: boolean, atMs: number): ProgressInput {
    const c = this.current!;
    const ordinal = (kind: 'video' | 'audio' | 'subtitle') => this.media.tracks.find(t => t.kind === kind && t.selected)?.ordinal;
    return {
      itemId: c.itemId,
      sourceId: c.sources[c.sourceIndex]?.id || '',
      playSessionId: c.playSessionId,
      positionMs: atMs,
      durationMs: this.state.durationMs,
      paused,
      rate: this.state.speed,
      volume: this.state.muted ? 0 : this.state.volume,
      videoIndex: ordinal('video'),
      audioIndex: ordinal('audio'),
      subtitleIndex: ordinal('subtitle'),
    };
  }

  /** One event to the server, with the position read at the moment of sending rather than from the last
   *  throttled repaint — a 15 s ticker that reports a stale clock is how a resume point drifts. */
  private async report(event: 'start' | 'progress' | 'stopped'): Promise<void> {
    const c = this.current;
    const k = this.kernel;
    if (!c) return;
    const at = event === 'stopped' || !k ? this.state.positionMs : await k.positionMs().catch(() => this.state.positionMs);
    if (this.current !== c) return;
    await this.client().session(this.progressInput(event === 'progress' ? this.state.paused : event === 'stopped', at), event);
  }

  private startTicker(): void {
    this.stopTicker();
    this.ticker = setInterval(() => void this.report('progress').catch(() => undefined), 15000);
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  /** Every control the overlay can ask for. Each arm returns once mpv has been told; the state comes back
   *  through the property events, so nothing here guesses at what the player will do. */
  async command(cmd: PlayerCommand): Promise<void> {
    const k = this.kernel;
    if (!k?.running) throw new Error('播放器没有在运行');
    switch (cmd.action) {
      case 'toggle': {
        if (this.state.status === 'ended') await k.rewind();
        else await k.setPaused(!this.state.paused);
        void this.report('progress').catch(() => undefined);
        return;
      }
      case 'seekMs':
        await k.seekTo(cmd.value);
        void this.report('progress').catch(() => undefined);
        return;
      case 'skip':
        await k.seekBy(cmd.value);
        return;
      case 'speed':
        await k.setSpeed(cmd.value);
        return;
      case 'volume':
        await k.setVolume(cmd.value);
        return;
      case 'mute':
        await k.setMuted(cmd.value);
        return;
      case 'track':
        await k.setTrack(cmd.value.kind, cmd.value.id);
        return;
      case 'subtitleDelay':
        await k.setSubtitleDelay(cmd.value);
        return;
      case 'audioDelay':
        await k.setAudioDelay(cmd.value);
        return;
      case 'subtitleStyle':
        await k.setSubtitleStyle(cmd.value);
        return;
      case 'aspect':
        await k.setAspect(cmd.value);
        return;
      case 'panscan':
        await k.setPanscan(cmd.value);
        return;
      case 'chapter':
        await k.jumpChapter(cmd.value);
        return;
      case 'frameStep':
        await k.frameStep(cmd.value);
        return;
      case 'restart':
        await k.rewind();
        return;
      case 'fullscreen':
        this.windows.setFullscreen(cmd.value);
        return;
      case 'source':
        await this.useSource(cmd.value);
        return;
      case 'quality':
        await this.useTier(cmd.value);
        return;
      case 'next':
        if (this.current?.next) await this.play(this.current.next.itemId);
        else throw new Error('这已经是最后一集');
        return;
      case 'prev':
        if (this.current?.prev) await this.play(this.current.prev.itemId);
        else throw new Error('这已经是第一集');
        return;
    }
  }

  /** Another version of the same item, if the server holds more than one. */
  private async useSource(index: number): Promise<void> {
    const c = this.current;
    const src = c?.sources[index];
    if (!c || !src) throw new Error('没有这个播放源');
    if (src.id === c.sources[c.sourceIndex]?.id) return;
    await this.replay({ tier: c.tier, sourceId: src.id });
  }

  /** Changing rung is a fresh negotiation and a reload that keeps the position and the rate. The chosen
   *  rung is a setting, not per-playback state: Emby's own clients remember it, and so do we. */
  private async useTier(bitrate: number): Promise<void> {
    const c = this.current;
    if (!c) throw new Error('没有在播放任何东西');
    if (!QUALITY_TIERS.includes(bitrate)) throw new Error('没有这个画质档位');
    if (c.tier === bitrate) return;
    config.saveSettings({ player: { tier: bitrate } });
    await this.replay({ tier: bitrate, sourceId: c.sources[c.sourceIndex]?.id });
  }

  private async replay(opts: { tier: number; sourceId?: string }): Promise<void> {
    const c = this.current;
    const k = this.kernel;
    if (!c || !k) throw new Error('没有在播放任何东西');
    const itemId = c.itemId;
    const wasAt = await k.positionMs();
    const speed = this.state.speed;
    const neg = await this.client().negotiate(itemId, opts);
    if (this.current !== c) return;
    const seen = { ...(this.seenMethods.get(itemId) || {}), [opts.tier]: neg.method };
    this.seenMethods.set(itemId, seen);
    const url = await this.bridge.mount(neg.url);
    c.sourceIndex = neg.sourceIndex;
    c.sources = neg.sources;
    c.playSessionId = neg.playSessionId || c.playSessionId;
    c.method = neg.method;
    c.hdr = neg.hdr;
    c.url = neg.url;
    c.tier = opts.tier;
    c.tiers = tiersFor(opts.tier, neg.method, seen);
    this.out.session(this.getSession());
    try {
      await k.load(url, { startMs: wasAt });
    } catch (e) {
      this.fail(e);
      throw e;
    }
    await k.setSpeed(speed).catch(() => undefined);
    void this.report('start').catch(() => undefined);
  }

  /** A knob changed while something is playing: apply live what mpv can apply live, re-negotiate when the
   *  cap moved, and rebuild the process when only a new command line can honour it. Nothing here defers a
   *  change to 「下一次」 — the row would have to explain itself, and a reload that keeps your place is
   *  cheaper than that sentence. */
  applyPrefs(prefs: PlayerPrefs): void {
    const c = this.current;
    if (c && c.tier !== prefs.tier) {
      void this.useTier(prefs.tier).catch(e => this.fail(e));
      return;
    }
    const k = this.kernel;
    if (!k?.running) return;
    void k.setHwdec(prefs.hwdec).catch(() => undefined);
    if (prefs.render !== k.renderProfile) void this.restartFor(prefs).catch(e => this.fail(e));
  }

  /** New process, same seat: the position and the rate are read back first and put on the new load. */
  private async restartFor(prefs: PlayerPrefs): Promise<void> {
    const c = this.current;
    const k = this.kernel;
    if (!c || !k) return;
    const wasAt = await k.positionMs();
    const speed = this.state.speed;
    this.kernel = null;
    await k.quit().catch(() => undefined);
    await this.ensureKernel(prefs);
    const url = await this.bridge.mount(c.url);
    await this.kernel!.load(url, { startMs: wasAt });
    await this.kernel!.setSpeed(speed).catch(() => undefined);
    this.raise();
  }

  async close(): Promise<void> {
    this.tearing = true;
    this.stopTicker();
    if (this.current && this.state.durationMs) await this.report('stopped').catch(() => undefined);
    this.current = null;
    await this.kernel?.quit().catch(() => undefined);
    this.kernel = null;
    this.bridge.close();
    this.windows.close();
    this.state = emptyPlayerState();
    this.media = emptyPlayerMedia();
    this.out.state(this.state);
    this.out.session(null);
    this.out.media(this.media);
    this.out.reveal();
  }

  /** Quit-time teardown: the same shutdown, but a window that is already going away must not be talked to. */
  async shutdown(): Promise<void> {
    this.stopTicker();
    if (this.current && this.state.durationMs) await this.report('stopped').catch(() => undefined);
    this.current = null;
    await this.kernel?.quit().catch(() => undefined);
    this.kernel = null;
    this.bridge.close();
    this.windows.close();
  }
}
