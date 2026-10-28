import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as config from '../config';
import { EmbyClient, type Identity, type ProgressInput } from '../emby/client';
import { explain } from '../emby/errors';
import { appBytesPerSec } from '../netmeter';
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
  type WatchedRecord,
} from '../../shared/types';
import { episodeSlot } from '../../shared/episode-slot';
import { versionLabel } from '../../shared/version-label';
import { MpvKernel } from './kernel';
import { StreamBridge } from './bridge';
import { PlayerWindows } from './windows';

/** What the renderer is told, and when. The controller never touches ipc itself, so the same object can
 *  be driven from a test with three arrays to collect into. */
export interface PlayerOut {
  state(s: PlayerState): void;
  session(s: PlayerSession | null): void;
  media(m: PlayerMedia): void;
  /** Where the film stopped, sent on the way out so the lobby can write the number onto the card it
   *  already holds instead of re-reading the whole page to find it. */
  watched(w: WatchedRecord): void;
  /** Bring the library window back once the player is gone. */
  reveal(): void;
}

/** What is playing right now. Replaced whole on every load, so no half-switched session can be reported
 *  while a version change is in flight. */
interface Current {
  itemId: string;
  /** The server this viewing was opened on, kept for its whole life: `client()` reads it, because the
   *  lobby can move to another machine while a stream is still running. */
  accountId: string;
  name: string;
  seriesId?: string;
  seasonId?: string;
  /** The position this episode holds in its season, as the server numbers it. The 选集 panel marks its own
   *  row with it (see `navFor` for why the id alone is not enough), and nothing else reads it. */
  indexNumber?: number;
  /** Which season that position is in, as a number: the shelf and the series' own season list can hand out
   *  two ids for one season, so `seasonId` cannot be the panel's "am I looking at the playing season" test. */
  seasonNumber?: number;
  sources: PlaybackSource[];
  sourceIndex: number;
  playSessionId: string;
  method: PlayMethod | '';
  hdr: boolean;
  next: PlayerNav | null;
  prev: PlayerNav | null;
  danmaku: DanmakuQuery | null;
  /** Completing the same item twice must not POST 已播放 twice. */
  reported: boolean;
  /** The length this item has according to the server, in ms. mpv's own number is preferred while it is on
   *  screen, but the stop write used to have only that one source: a file whose duration never arrived left
   *  no stop at all, even though 开场 two functions away had already used the server's length for the same item. */
  runtimeMs: number;
  /** The offset the server held when this session opened — the number the start report carried with it. A
   *  position under a second cannot be allowed to overwrite it, because that is precisely how a write that
   *  never got going erases a stop that was already stored. */
  startMs: number;
  /** The stop position this item has already been given to the server, or -1 while it has not been left
   *  yet. Every exit path funnels through one write, and this is what keeps two of them — 播完 then the
   *  close that follows it — from posting the same item twice. */
  flushedMs: number;
}

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
  private state: PlayerState = emptyPlayerState();
  private media: PlayerMedia = emptyPlayerMedia();
  /** A deliberate close must not be reported as a crash by the process's exit handler. */
  private tearing = false;
  /** The sidecar subtitle this viewing has handed to mpv: the server row it came from, the file its bytes
   *  were written to, and the track number mpv gave it. One at a time, because two sets of cues on the same
   *  frame is not a choice anyone made. */
  private sidecar: { index: number; file: string; trackId: number } | null = null;
  /** Scratch directory for those files, created on the first pick and cleared with the viewing. */
  private sidecarDir: string | null = null;
  /** The version of a show this machine has been playing, keyed by series and spelled by the one word the
   *  version's own name says about its shape — 「2160p」, 「tv」, 「mobile」 — which is the word
   *  `versionLabel` reads out and the 播放资源 card and the player's 播放源 card both print. A
   *  `MediaSourceId` belongs to one file, so it cannot travel to the next episode; the shape word can.
   *  See `play`, which answers a sibling's negotiation from it. */
  private seriesVersion = new Map<string, string>();
  /** The version of *this* file the player last ended up on, per item. The 播放源 card inside the player
   *  writes it, and so does every negotiation, because a switch made there is the user's most recent word
   *  on a file that has more than one — and until it existed, the next 播放 of the same file went back to
   *  whichever row the negotiation happened to take first. */
  private itemVersion = new Map<string, string>();

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
      sourceId: c.sources[c.sourceIndex]?.id || '',
      sources: c.sources,
      sourceIndex: c.sourceIndex,
      method: c.method,
      hdr: c.hdr,
      next: c.next,
      prev: c.prev,
      seriesId: c.seriesId,
      seasonId: c.seasonId,
      indexNumber: c.indexNumber,
      seasonNumber: c.seasonNumber,
      danmaku: c.danmaku,
    };
  }

  private identity(): Identity {
    const c = config.get();
    return { deviceId: c.deviceId, deviceName: c.deviceName, clientName: c.clientName, clientVersion: c.clientVersion, language: 'zh-cn' };
  }

  /** The server the thing being talked about lives on. While a viewing is open that is the one it was
   *  opened on, not whichever one the lobby moved to: 换服务器 does not close the player window, and an
   *  item id means something only on the machine that issued it — measured 2026-10-28, 240037 is 小鬼当家
   *  on emby.bangumi.ca and 「Erlinda Villalobos」 on OkEmby, so a stop sent after a switch wrote to, and
   *  then believed, a stranger's film. `play` below is the one caller that must not read this answer,
   *  because the item it is loading belongs to the lobby's new server. */
  private client(): EmbyClient {
    const id = this.current?.accountId;
    const acc = (id && config.get().accounts.find(a => a.accountId === id)) || config.activeAccount();
    if (!acc) throw new Error('还没有登录任何服务器');
    return new EmbyClient(acc, this.identity());
  }

  /** Whether the viewing's own server has left the account list. `client()` falls back to whichever one
   *  is active for reads, the least-bad answer for a stream that is still running; a *write* about an id
   *  that machine has never seen has no acceptable answer, so the reports refuse instead. */
  private serverGone(): boolean {
    const id = this.current?.accountId;
    return !!id && !config.get().accounts.some(a => a.accountId === id);
  }

  /** Load one item into a player that may or may not exist yet. Everything the user can start — a card,
   *  下一集, the 选集 panel — comes through here, so a switch is a reload and never a restart.
   *  `fromStart` drops the server's offset: the heroes pass it whenever their own button reads 「播放」,
   *  so a label can never promise a first view the player then starts halfway through. */
  async play(itemId: string, fromStart = false, sourceId?: string): Promise<void> {
    this.tearing = false;
    // Leaving an item for another one is an exit just as surely as closing the window is, so the episode
    // the user walked away from gets its stop written before anything new is asked for.
    const leaving = this.current;
    if (leaving && leaving.itemId !== itemId) {
      const w = await this.flushStop(undefined, 'switch');
      if (w) this.out.watched(w);
    }
    // A new item is asked for from the server the lobby is pointed at; `this.current` is still the episode
    // being left, so its account cannot be the answer here.
    const acc = config.activeAccount();
    if (!acc) throw new Error('还没有登录任何服务器');
    const c = new EmbyClient(acc, this.identity());
    const prefs = config.get().settings.player;
    const item = await c.item(itemId);
    const [resume, nav] = await Promise.all([c.resumePoint(itemId), this.navFor(c, item)]);
    // The card the reader picked a version on is the one surface that knows which of the file's versions
    // was being read; without its answer the negotiation takes sources[0], which on a two-version file is
    // the 4K one this machine decodes at 0.15× real time.
    // Two memories stand behind that answer. `itemVersion` holds the version this machine last actually
    // played for this exact file — including one switched inside the player's 播放源 card, which the page
    // can never see — and `seriesVersion` holds the version's shape word for the whole show, because a walk
    // through a season does not come back through any card: 下一集, the 选集 panel and the manual
    // next/prev all ask for a sibling by id alone. It is keyed on `versionLabel` rather than on the
    // server's `Name` because a name cannot travel — measured 2026-10-27 over the item endpoint's 800
    // sampled rows, 5 of 400 episode rows carry two or three versions and 14,992 of 15,000 episode version
    // names embed their own 「S01E04」, so 「… - S01E01 - 第 1 集 - tv」 is never the next episode's name and
    // the raw comparison hit nothing at all in a live three-episode walk. The shape word is the one that
    // repeats: asked of the live item endpoint over eight episodes per show, 哺乳动物星球 S01 carries
    // 「tv」 on 6 of 6 of them, so a pick made on 第 1 集 answers 第 2–6 集. The other four two-version
    // shows name their versions with no shape word at all — 黑袍纠察队 gives both rows the same
    // 「… - S03E08 - 第 8 集」 — and those write nothing, so their siblings take their own first source,
    // which is where they would have landed anyway.
    // An explicit pick from the card outranks both, because the card is showing it pressed.
    const sameShape = item.seriesId ? this.seriesVersion.get(item.seriesId) : undefined;
    const fromSeries = sameShape && (item.sources || []).length > 1
      ? item.sources?.find(s => versionLabel(s.name).toLowerCase() === sameShape)?.id
      : undefined;
    const wanted = sourceId || this.itemVersion.get(itemId) || fromSeries;
    const neg = await c.negotiate(itemId, { sourceId: wanted });
    this.rememberVersion(itemId, item.seriesId, neg.sources[neg.sourceIndex]);

    // The windows only open once the server has agreed to serve something: a refused negotiation should
    // fail on the page 播放 was pressed from, not on a black screen with no controls.
    if (!this.windows.isOpen) this.windows.open(this.rendererUrl('#/player'));
    await this.ensureKernel(prefs);

    const url = await this.bridge.mount(neg.url);

    this.current = {
      itemId,
      accountId: acc.accountId,
      name: item.name,
      seriesId: item.seriesId,
      seasonId: item.type === 'Episode' ? item.seasonId || item.parentId : undefined,
      indexNumber: item.type === 'Episode' ? item.indexNumber : undefined,
      seasonNumber: item.type === 'Episode' ? item.parentIndexNumber : undefined,
      sources: neg.sources,
      sourceIndex: neg.sourceIndex,
      playSessionId: neg.playSessionId,
      method: neg.method,
      hdr: neg.hdr,
      next: nav.next,
      prev: nav.prev,
      danmaku: this.danmakuOf(item),
      reported: resume.played,
      flushedMs: -1,
      runtimeMs: Math.round((item.runTimeTicks || 0) / 1e4),
      startMs: resume.startMs,
    };
    this.out.session(this.getSession());
    this.raise();

    try {
      await this.kernel!.load(url, { startMs: fromStart ? 0 : resume.startMs });
    } catch (e) {
      this.fail(e);
      throw e;
    }
    // The start report carries the offset the *server* holds, never the 0 a 「播放」 button loaded at:
    // measured on bangumi, an open that reports 0 rewrites the item to 0 about a minute later while the
    // session is live, so a hard-killed app left 187396 sitting at nothing and the next 看到 had no number
    // to print. An open that reports the stored offset leaves that offset standing.
    void this.announceStart(resume.startMs, Math.round((item.runTimeTicks || 0) / 1e4)).catch(() => undefined);
  }

  /** What a danmaku service is asked about. An episode called 「第 3 集」 matches nothing, so the series
   *  name travels with it and the layer keys the track to this item. */
  private danmakuOf(item: LibraryItem): DanmakuQuery {
    return {
      itemId: item.id,
      title: item.name,
      seriesName: item.type === 'Episode' ? item.seriesName || item.name : item.name,
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
    // One season's rows, so the list is the season and `sameSeason` is simply true here.
    const i = episodeSlot(eps, item, true);
    if (i < 0) return none;
    const at = (x?: LibraryItem): PlayerNav | null => (x ? { itemId: x.id, label: navLabel(x) } : null);
    return { next: at(eps[i + 1]), prev: at(eps[i - 1]) };
  }

  /** mpv only renders into a window handed to it at launch, so the handle has to be right before anything
   *  loads. The launch shape itself never changes now — one render profile, chosen in the command line — so
   *  a process that is already up is reused and only the runtime-settable decoder is moved. */
  private async ensureKernel(prefs: PlayerPrefs): Promise<void> {
    if (this.kernel?.running) {
      await this.kernel.setHwdec(prefs.hwdec).catch(() => undefined);
      return;
    }
    const k = new MpvKernel();
    k.onState = s => this.onKernelState(s);
    k.onMedia = m => this.onKernelMedia(m);
    k.onGone = message => this.onGone(message);
    this.kernel = k;
    await k.start({ hwnd: this.windows.hostHwnd(), prefs: { hwdec: prefs.hwdec, hdrHint: prefs.hdrHint } });
    await this.windows.raiseVideoWhenReady();
  }

  private raise(): void {
    this.windows.raiseVideo();
    this.windows.focus();
  }

  private onGone(message?: string): void {
    this.kernel = null;
    if (this.tearing) return;
    // The process died on its own: no close(), no quit, nothing after this but an error line on the overlay.
    // mpv's clock went with it, but the last position it reported is still in this.state and is the only
    // number this viewing session will ever have. Left unwritten, the gateway keeps holding whatever 开场
    // carried — which for a film started fresh is 0.
    void this.flushStop(undefined, 'gone')
      .then(w => {
        if (w) this.out.watched(w);
      })
      .catch(() => undefined);
    this.state = { ...this.state, status: 'error', error: message || '播放器退出了' };
    this.out.state(this.state);
  }

  private fail(e: unknown): void {
    this.state = { ...this.state, status: 'error', error: explain(e) };
    this.out.state(this.state);
  }

  private onKernelState(s: PlayerState): void {
    // The read-out answers "what is this app pulling right now", and the posters on screen belong to that
    // answer even though they never pass through the player. mpv's own counter is the video; this is
    // everything else on Chromium's stack, refreshed on the same tick the player reports.
    const merged: PlayerState = { ...s, netBytesPerSec: s.netBytesPerSec + Math.round(appBytesPerSec()) };
    this.state = merged;
    this.out.state(merged);
    if (s.status === 'ended') void this.onEnded().catch(e => this.fail(e));
  }

  private onKernelMedia(m: PlayerMedia): void {
    // mpv's own track list is the only witness that a sidecar is still loaded. Loading another file — a
    // version switch, 下一集 — drops every track `sub-add` made, and a menu that kept
    // marking its row 正在用 would be pointing at a track the process no longer has.
    const loaded = this.sidecar;
    const live = loaded && m.tracks.some(t => t.kind === 'subtitle' && t.id === loaded.trackId) ? loaded : null;
    if (loaded && !live) {
      this.sidecar = null;
      void rm(loaded.file, { force: true }).catch(() => undefined);
    }
    this.media = { ...m, sidecar: live ? { trackId: live.trackId, index: live.index } : null };
    this.out.media(this.media);
  }

  /** Reaching the end is the only moment the server is told this item is finished, and it is also what
   *  makes 下一集 automatic. Measured: with --keep-open=yes the end never arrives as an end-file event —
   *  that is why the old `status === 'ended'` branch, and with it markPlayed, never ran. */
  private async onEnded(): Promise<void> {
    const c = this.current;
    if (!c || c.reported) return;
    c.reported = true;
    const w = await this.flushStop(this.state.durationMs, 'ended');
    // Reaching the end is what earns the 已播放 mark, and it does not depend on the position write having
    // landed. These were chained: a stopped report the server refused used to leave a finished film
    // unmarked as well as unfindable.
    // Same answer as the position write: no 已播放 mark is left on a machine that never served the file.
    const played = this.serverGone() ? false : await this.client().markPlayed(c.itemId);
    if (w) {
      w.played = played;
      this.out.watched(w);
    }
    const next = config.get().settings.player.autoNext ? c.next : null;
    if (next) await this.play(next.itemId);
  }

  /** Emby's session event names a stream by the server's own number for it inside the file, while the menu
   *  the viewer clicked is numbered by mpv, which restarts at 1 inside each kind — so the two never share
   *  an address. They do share the container's number: mpv reports `ff-index`, and measured 2026-10-27 over
   *  212,468 server stream rows the server's `Index` is that same probe-order number (it names the default
   *  audio track on 22,890 of 23,027 sources, where a position within the audio rows would fit 79). A
   *  track the server has no row for — a cover, a sidecar subtitle the file never carries — sends nothing,
   *  which `progressBody` omits rather than guessing: the gateway writes what it is told into the item, and
   *  the next client then resumes on a track the viewer never picked. */
  private serverStreamIndex(kind: 'video' | 'audio' | 'subtitle'): number | undefined {
    const c = this.current;
    const src = c ? c.sources[c.sourceIndex] : undefined;
    if (!src) return undefined;
    const picked = this.media.tracks.find(t => t.kind === kind && t.selected && !t.external);
    if (picked?.ffIndex === undefined) return undefined;
    const rows = kind === 'video' ? (src.video ? [src.video] : []) : kind === 'audio' ? src.audio : src.subtitle;
    return rows.some(r => r.index === picked.ffIndex) ? picked.ffIndex : undefined;
  }

  private progressInput(paused: boolean, atMs: number, durationMs = this.state.durationMs): ProgressInput {
    const c = this.current!;
    return {
      itemId: c.itemId,
      sourceId: c.sources[c.sourceIndex]?.id || '',
      playSessionId: c.playSessionId,
      positionMs: atMs,
      durationMs,
      paused,
      rate: this.state.speed,
      volume: this.state.muted ? 0 : this.state.volume,
      videoIndex: this.serverStreamIndex('video'),
      audioIndex: this.serverStreamIndex('audio'),
      subtitleIndex: this.serverStreamIndex('subtitle'),
    };
  }

  /** The one 开场 a viewing gets, sent from 播开那一步 — a stream rebuilt for a version switch is still the
   *  same viewing and stays quiet, because FirstPlay is what stamps PlayCount. Nothing is
   *  written while the film runs: 进度 used to post every 15 s, and every one of those numbers was already
   *  stale by the time it landed. `atMs`/`durationMs` are the offset the server already holds rather than the
   *  live clock, because mpv has not reported one yet — and the number a start carries is the number the
   *  gateway writes back into the item about a minute later (368040 became 59000 there while nothing was
   *  being sent, 187396 became 0 after a start at 0), so it is the one number this app must not guess at. */
  private async announceStart(atMs?: number, durationMs?: number): Promise<void> {
    const c = this.current;
    const k = this.kernel;
    if (!c) return;
    const at = atMs ?? (k?.running ? await k.positionMs().catch(() => this.state.positionMs) : this.state.positionMs);
    if (this.current !== c) return;
    // The number 开场 carries is the number the gateway writes back into the item a minute later, so the
    // record of it is worth one line: 2026-10-24 a 小鬼当家 open printed nothing at all, and only the
    // server's own PlayCount 1→2 proved the start had gone out.
    console.log('[player] 开场', c.itemId, `pos=${Math.round(at)}`, `len=${Math.round(durationMs ?? this.state.durationMs)}`, `mpv=${k?.running ? '在' : '没'}`);
    await this.client().session(this.progressInput(false, at, durationMs ?? this.state.durationMs), 'start');
  }

  /** Say once, at the moment the item is left, where it actually stopped — the only write that decides
   *  what 看到 shows anywhere in the app. Returns the number the server took — asked for after
   *  the report lands, because a 2xx only says it was heard (see confirmHeld) — or null when there was
   *  nothing to say or the server did not take it; a caller must not patch a card with a position the
   *  server refused, because the next re-read would contradict it.
   *  `atMs` is the end-of-file override: mpv's clock at the last frame is a frame short of the runtime.
   *  A refusal says so; a write that landed also says so, because measured 2026-10-24 on 小鬼当家 the 开场
   *  landed (PlayCount 1→2, LastPlayedDate moved to 22:04) while `PlaybackPositionTicks` stayed 0 with an
   *  empty log — from the outside a silent success, a silent early return and a server that accepts a
   *  number and does not keep it are one and the same picture, and only the number in the line separates
   *  them. `reason` is which exit asked, so the line says what the screen was doing at that moment. */
  private async flushStop(atMs?: number, reason = 'exit'): Promise<WatchedRecord | null> {
    const c = this.current;
    if (!c) return null;
    console.log('[player] 退出', reason, c.itemId, `pos=${Math.round(this.state.positionMs)}`,
      `dur=${Math.round(this.state.durationMs)}`, `runtime=${Math.round(c.runtimeMs)}`, `start=${Math.round(c.startMs)}`,
      `flushed=${c.flushedMs}`, `mpv=${this.kernel?.running ? '在' : '没'}`);
    if (this.serverGone()) {
      console.warn('[player] 停止没写：这条流来的服务器已被移除', reason, c.itemId, `account=${c.accountId}`);
      return null;
    }
    // mpv's length when it has reported one, the server's when it has not — the same two sources 开场 reads,
    // in the same order of preference.
    const durationMs = this.state.durationMs || c.runtimeMs;
    if (!durationMs) {
      console.warn('[player] 停止没写：说不清这部片多长', reason, c.itemId);
      return null;
    }
    if (c.flushedMs >= durationMs) return null;
    const k = this.kernel;
    const at = atMs ?? (k?.running ? await k.positionMs().catch(() => this.state.positionMs) : this.state.positionMs);
    if (this.current !== c) return null;
    // The same number goes to the server once. mpv's own death writes the stop here, and the close that
    // follows it asks again with a clock that can no longer move.
    if (c.flushedMs === at) return null;
    // Under a second is not a stop, and posting one is how a session that never got going erases the offset
    // it opened with — the write would land, and the gateway would keep it: the 「看到 0:00」 the cards already
    // refuse to print, published to every other client.
    if (at < 1000 && c.startMs >= 1000) {
      console.warn('[player] 停止没写：位置不足一秒，保住开场的偏移', reason, c.itemId, `start=${Math.round(c.startMs)}`);
      return null;
    }
    const client = this.client();
    let ok = await client.session(this.progressInput(true, at, durationMs), 'stopped');
    if (!ok) ok = await client.session(this.progressInput(true, at, durationMs), 'stopped');
    if (!ok) {
      console.warn('[player] 停止没写出去', reason, c.itemId, `pos=${Math.round(at)}`, `len=${durationMs}`, `start=${Math.round(c.startMs)}`);
      return null;
    }
    // What the server took, even when it took 0: an accepted number that the item never shows is only
    // tellable apart from a write that never went out by having the number on the record.
    console.log('[player] 停止已写', reason, c.itemId, `pos=${Math.round(at)}`, `len=${durationMs}`);
    const held = await this.confirmHeld(client, c.itemId, at, durationMs, reason);
    c.flushedMs = at;
    // The server's number, not ours: publishing the sent one is how a button came to read 「看到 1:07」
    // over a film the gateway had just zeroed (measured 2026-10-28, 240037).
    return { itemId: c.itemId, positionMs: held ?? at, durationMs };
  }

  /** The item's own answer about where it now parks the viewer. A 2xx on the report only means the gateway
   *  heard it, not that it kept the number: measured 2026-10-28 on bangumi, a stop at 66,858 ms (1.08% of
   *  小鬼当家's 6,173,633) was accepted and the item came back 0 — and the 369,828 ms (5.99%) it had been
   *  holding went to 0 with it. A position under this gateway's threshold (which the three runs put in
   *  (2.55%, 3.47%], the same rule OkEmby's 325273 answers by at (2.56%, 34.4%]) is not ignored but cleared,
   *  so the write the card is patched from has to be the read-back. One read is not enough: the gateway
   *  folds a report in a moment after it answers, so a disagreement is re-read before it is believed, and
   *  only then published. A stop at the file's own length is the 已看 case, where the position is meaningless
   *  and markPlayed is the authority — that one goes unverified. Null means the item could not be asked, and
   *  the caller keeps today's behaviour of publishing what it sent. */
  private async confirmHeld(client: EmbyClient, itemId: string, at: number, durationMs: number, reason: string): Promise<number | null> {
    if (at >= durationMs - 1500) return null;
    const ask = () => client.resumePoint(itemId).catch(() => null);
    const first = await ask();
    if (!first) return null;
    if (Math.abs(first.startMs - at) <= 1500) return first.startMs;
    await new Promise(r => setTimeout(r, 700));
    const again = await ask();
    const held = again ? again.startMs : first.startMs;
    console.warn('[player] 停止被抹', reason, itemId, `sent=${Math.round(at)}`, `held=${Math.round(held)}`, `start=${Math.round(this.current?.startMs ?? 0)}`);
    return held;
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
        return;
      }
      case 'seekMs':
        await k.seekTo(cmd.value);
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
      case 'sidecarSubtitle':
        await this.useSidecar(cmd.value);
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

  /** A subtitle the server keeps as a file beside the video is not inside the stream mpv opened, so `sid`
   *  cannot reach it and its bytes have to be fetched. The gateway answers at exactly one address —
   *  `/Videos/{item}/{source}/Subtitles/{index}/Stream.{codec}`, measured 2026-10-27 on 4 of 4 sidecars
   *  while `/Stream`, `/Download` and the source-less form all said 找不到文件 — and main fetches it rather
   *  than handing mpv a URL because the route to that host sometimes needs the system proxy (one of those
   *  four arrived only through it) and the child process knows nothing about a proxy or a token.
   *  The old sidecar is dropped after the new one is in: a fetch that fails mid-click must leave the
   *  subtitle the viewer was reading where it was, not on screen with nothing. */
  private async useSidecar(index: number): Promise<void> {
    const c = this.current;
    const k = this.kernel;
    if (!c || !k) throw new Error('没有在播放任何东西');
    const src = c.sources[c.sourceIndex];
    if (!src) throw new Error('没有这个播放源');
    // `isTextSubtitle !== false` rather than `=== true`: the field is absent on servers that do not answer
    // it, and 781 of the 784 rows that do carry it are true — the 3 that are not are .sup pictures mpv
    // can only decode inside a container, and a row that dies when clicked belongs in no menu.
    const row = src.subtitle.find(t => t.index === index && t.isExternal && t.isTextSubtitle !== false);
    if (!row) throw new Error('这台服务器没有把这条外挂字幕放在当前版本里');
    if (this.sidecar?.index === index) {
      await k.setTrack('subtitle', this.sidecar.trackId);
      return;
    }
    const dir = this.sidecarDir || (this.sidecarDir = await mkdtemp(join(tmpdir(), 'echoemby-sub-')));
    const codec = (row.codec || 'srt').toLowerCase();
    const bytes = await this.client().subtitleBytes(c.itemId, src.id, index, codec);
    if (this.current !== c) return;
    const file = join(dir, `sub-${index}.${codec}`);
    await writeFile(file, bytes);
    const trackId = await k.addSubtitleFile(file, row.displayTitle || row.title || '外挂字幕');
    if (trackId === null) {
      await rm(file, { force: true }).catch(() => undefined);
      throw new Error('播放器读不了这条字幕文件');
    }
    const prev = this.sidecar;
    this.sidecar = { index, file, trackId };
    await k.setTrack('subtitle', trackId);
    if (prev) {
      await k.removeSubtitleFile(prev.trackId).catch(() => undefined);
      void rm(prev.file, { force: true }).catch(() => undefined);
    }
  }

  /** Another version of the same item, if the server holds more than one. */
  private async useSource(index: number): Promise<void> {
    const c = this.current;
    const src = c?.sources[index];
    if (!c || !src) throw new Error('没有这个播放源');
    if (src.id === c.sources[c.sourceIndex]?.id) return;
    await this.replay({ sourceId: src.id });
  }

  /** The version the next 播放 of this item takes — the same answer `play` reads, so the page's 播放资源
   *  card can open on the strip that is really pressed instead of keeping a second copy of the choice.
   *  Empty means nobody has chosen and the card falls on the first playable row. */
  lastSource(itemId: string): string {
    return this.itemVersion.get(itemId) || '';
  }

  /** A pick made on the page, before anything is played. It lands in the one memory rather than in a ref
   *  the library window holds, because a switch inside the player writes that same map and the newer word
   *  has to win: ranked against each other, the page's older click used to outrank the player's newer one.
   *  The show's shape word is not written here — 下一集 gets it from `rememberVersion` when this pick
   *  actually plays, which is the moment it becomes an answer about the rest of the season. */
  chooseSource(itemId: string, sourceId: string): void {
    this.itemVersion.set(itemId, sourceId);
  }

  /** File the player is now on, into both memories. Called from `play` and from `replay`, which is what a
   *  播放源 or 画质 card inside the player drives — a switch made there is as much the user's answer as one
   *  made on the page, and the page has no way to see it: the player is a second window whose session object
   *  never reaches the library renderer. */
  private rememberVersion(itemId: string, seriesId: string | undefined, src: PlaybackSource | undefined): void {
    if (!src) return;
    this.itemVersion.set(itemId, src.id);
    const shape = versionLabel(src.name).toLowerCase();
    if (seriesId && shape) this.seriesVersion.set(seriesId, shape);
  }

  private async replay(opts: { sourceId?: string }): Promise<void> {
    const c = this.current;
    const k = this.kernel;
    if (!c || !k) throw new Error('没有在播放任何东西');
    const itemId = c.itemId;
    const wasAt = await k.positionMs();
    const speed = this.state.speed;
    const neg = await this.client().negotiate(itemId, opts);
    if (this.current !== c) return;
    const url = await this.bridge.mount(neg.url);
    c.sourceIndex = neg.sourceIndex;
    c.sources = neg.sources;
    this.rememberVersion(itemId, c.seriesId, neg.sources[neg.sourceIndex]);
    c.playSessionId = neg.playSessionId || c.playSessionId;
    c.method = neg.method;
    c.hdr = neg.hdr;
    this.out.session(this.getSession());
    try {
      await k.load(url, { startMs: wasAt });
    } catch (e) {
      this.fail(e);
      throw e;
    }
    await k.setSpeed(speed).catch(() => undefined);
    // No second 开场 here. This is the same item inside the same session, and FirstPlay is the event that
    // stamps PlayCount and LastPlayedDate — measured 2026-10-24, one open of 小鬼当家 answers PlayCount 1 —
    // so re-announcing on every knob move would publish another 收看过 for something that was never a new
    // viewing. The stopped report on the way out carries the source this stream actually ended on.
  }

  /** The decoder is the only knob that can move while something is playing. There is nothing else to do
   *  here: the render shape is fixed at launch and the version is chosen before the stream opens, so no
   *  setting can still ask for a reload or a new process. */
  applyPrefs(prefs: PlayerPrefs): void {
    const k = this.kernel;
    if (!k?.running) return;
    void k.setHwdec(prefs.hwdec).catch(() => undefined);
  }

  /** The fetched sidecars are a copy of something the server still holds, so they live only as long as the
   *  viewing does. Both teardown paths call this, and neither waits on the delete: a scratch file that
   *  outlives the app by a few seconds is a worse trade than the exit it would have delayed. */
  private dropSidecar(): void {
    this.sidecar = null;
    if (this.sidecarDir) void rm(this.sidecarDir, { recursive: true, force: true }).catch(() => undefined);
    this.sidecarDir = null;
  }

  async close(): Promise<void> {
    this.tearing = true;
    // The stop is written before anything is torn down: mpv still holds the real position, and the number
    // the lobby is handed must be the one the server just took.
    const w = await this.flushStop(undefined, 'close');
    this.current = null;
    await this.kernel?.quit().catch(() => undefined);
    this.kernel = null;
    this.bridge.close();
    this.windows.close();
    this.dropSidecar();
    this.state = emptyPlayerState();
    this.media = emptyPlayerMedia();
    this.out.state(this.state);
    if (w) this.out.watched(w);
    this.out.session(null);
    this.out.media(this.media);
    this.out.reveal();
  }

  /** Quit-time teardown: the same shutdown, but a window that is already going away must not be talked to.
   *  The server still gets the stopped report; the lobby's write-back does not, because the page that
   *  would read it is being destroyed and the ask it triggers would only delay the exit. */
  async shutdown(): Promise<void> {
    await this.flushStop(undefined, 'quit');
    this.current = null;
    await this.kernel?.quit().catch(() => undefined);
    this.kernel = null;
    this.bridge.close();
    this.windows.close();
    this.dropSidecar();
  }
}
