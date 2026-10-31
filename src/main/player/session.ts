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
import { pickTracks, type TrackPick } from '../../shared/track-pick';
import { MpvKernel } from './kernel';
import { StreamBridge } from './bridge';
import { mediaCache } from '../media-cache';
import { Thumbnails, type ThumbAnswer, type ThumbOpen } from './thumbs';
import { PlayerWindows } from './windows';
import { WindowsHdr } from './hdr';
import * as subs from '../subtitles';
import type { LocalSubtitle } from '../subtitles';

/** What the renderer is told, and when. The controller never touches ipc itself, so the same object can
 *  be driven from a test with three arrays to collect into. */
export interface PlayerOut {
  state(s: PlayerState): void;
  session(s: PlayerSession | null): void;
  media(m: PlayerMedia): void;
  /** Where the film stopped, sent on the way out so the lobby can write the number onto the card it
   *  already holds instead of re-reading the whole page to find it. */
  watched(w: WatchedRecord): void;
  /** 播放时隐藏主程序 — asked once per viewing, when the picture actually starts. The controller does not
   *  decide whether the row is on: that answer lives in the settings and is read where the window is.
   *  Answers whether the window was actually hidden, so a call that changed nothing does not use up the
   *  one ask this viewing gets. */
  hideMain(): boolean;
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
  /** The end of this item has already been handled. Kept apart from `reported`, which a re-watch starts
   *  with true (the server already marks the film 已播放) — sharing one flag made 自动下一集 dead on every
   *  episode the viewer had watched before. */
  ended: boolean;
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

/** The year an Emby date says, or nothing. Emby writes them 「2013-04-07T00:00:00.0000000Z」. */
const yearOfDate = (s?: string): number | undefined => {
  const year = Number((s || '').slice(0, 4));
  return Number.isFinite(year) && year > 1900 ? year : undefined;
};

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
  /** The bridge address of the file that is playing, kept so a preview worker can still be started after the
   *  fact — a setting turned on mid-film, or one turned off and back on. Empty when nothing is loaded. */
  private thumbUrl = '';
  /** 进度条预览图: a second, unwatched mpv that decodes a frame every few dozen seconds of the file on
   *  screen. It follows the viewing — opened after a load, closed with the session. */
  private thumbs = new Thumbnails();
  private current: Current | null = null;
  /** This viewing's claim on the desktop's own HDR switch: on for a file that has HDR, back off when the
   *  film leaves, and only ever for a switch this app made itself. */
  private screen = new WindowsHdr();
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
  /** 本地字幕 this viewing carries: the copy the viewer brought, the account:item it is remembered under,
   *  and the track mpv gave it. One at a time, like a sidecar — and it outranks one, because a file brought
   *  for this film is a deliberate choice where a sidecar is only a language preference being guessed at. */
  private local: { entry: LocalSubtitle; key: string; trackId: number } | null = null;
  /** Watch that puts a 本地字幕 back in front while mpv finishes opening the file. See `holdLocal`. */
  private localHold: ReturnType<typeof setInterval> | null = null;
  /** One re-add at a time; see `repairLocal`. */
  private localRepair = false;
  /** The version of a show this machine has been playing, keyed by series and spelled by the one word the
   *  version's own name says about its shape — 「2160p」, 「tv」, 「mobile」 — which is the word
   *  `versionLabel` reads out and the 播放资源 card and the player's 播放源 card both print. A
   *  `MediaSourceId` belongs to one file, so it cannot travel to the next episode; the shape word can.
   *  See `play`, which answers a sibling's negotiation from it. */
  private seriesVersion = new Map<string, string>();
  /** Whether this viewing has already asked for the library window to be hidden. Per viewing, not per item:
   *  a user who brought the page back while a film played must not have it taken away again by 下一集. */
  private hidMain = false;
  /** The version of *this* file this machine has decided to play, per item — and the only place that answer
   *  is kept. Both cards write it: the 播放源 card inside the player and, through `chooseSource`, the
   *  播放资源 card on the page, which used to hold a second copy of the same choice and hand it to `play`
   *  on top of this one. Two memories ranked against each other is how a switch made in the player lost to
   *  an older click on the page. Every negotiation writes it too, so the version that actually played is
   *  the one the next 播放 takes. */
  private itemVersion = new Map<string, string>();
  /** The year a season first aired, asked for only when the episode has none, and kept per season.
   *  弹幕's ranking needs a year to tell 第一季 from 完结篇 THE LAST ATTACK, and Emby leaves it off the episode
   *  row: measured 2026-10-30, 進撃の巨人 S01E01 and 银魂 S01E01-E02 both answer null to ProductionYear *and*
   *  PremiereDate, while the season — and, for season 1, the series — carries a date. The season's own date
   *  is the right one; the series' is only borrowed by season 1, because a long show's later seasons are not
   *  the year it began. */
  private seasonYear = new Map<string, number | undefined>();

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
    // Every byte this player ever reads comes through the bridge, so the cache is installed here once and
    // sees the gateway URLs themselves - rewritten playlist entries included.
    this.bridge.useCache(mediaCache);
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

  /** One frame of the file that is playing, as a data URL, for the bar's tip. 空 while the worker has
   *  not got there yet — asking is what moves that part of the file to the front of its queue. `precise`
   *  asks for the exact second under the pointer instead of the grid cell that covers it. */
  thumbAt(ms: number, precise = true): ThumbAnswer {
    // The setting is read here rather than only at play time: a viewer who turns 进度条预览图 on while
    // something is playing expects the tip to fill in, and one who turns it off expects the worker to go.
    const on = config.get().settings.player.thumbPreview;
    if (!on) {
      if (this.thumbs.running) this.thumbs.close();
      return { url: null, exact: false };
    }
    // `active`, not `running`: during the worker's quiet period there is no process yet, but the grid is
    // already open and filling. Re-opening here on every pointer move threw away each frame as it arrived.
    if (this.thumbUrl && !this.thumbs.active) {
      this.thumbs.open(this.thumbUrl, this.current?.runtimeMs || 0, this.thumbOpen());
    }
    return this.thumbs.at(ms, precise);
  }

  /** What the preview worker needs from the session: which file the grid belongs to, where the playhead is
   *  so it fills that part first, and whether the film is starving. */
  private thumbOpen(): ThumbOpen {
    return {
      key: this.thumbKey(),
      now: () => this.state.positionMs,
      starving: () => this.starving(),
    };
  }

  /** Which file a preview grid belongs to. The item alone is not enough: 2160p and 1080p of one episode are
   *  two files with two different pictures, and a grid cut from one must never answer for the other. */
  private thumbKey(): string {
    const c = this.current;
    if (!c) return '';
    return c.itemId + '|' + (c.sources[c.sourceIndex]?.id || '');
  }

  /** 清理全部缓存 also drops the preview grids: one button called 全部 must not leave a second cache of the
   *  same film behind on disk. The frames already in memory stay for this viewing; the folder is rebuilt on
   *  the next cell that gets decoded. */
  async clearThumbs(): Promise<void> {
    await this.thumbs.clearCache();
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
  async play(itemId: string, fromStart = false): Promise<void> {
    this.tearing = false;
    // A prefetch belongs to the item that was playing; leaving it runs in the background of a picture nobody
    // is going to look at, and it competes for the same connection the new item is about to need.
    mediaCache.cancelPrefetch();
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
    // Which of a file's versions plays is one question with one answer, kept in `itemVersion`: what the
    // reader last pressed — on the page's 播放资源 card or on the player's own 播放源 card — or, where
    // nobody has pressed, the version the last negotiation of this item took. Without it the negotiation
    // answers `sources[0]`, which on a two-version file is the 4K one this machine decodes at 0.15× real
    // time.
    // `seriesVersion` stands behind that for a show, because a walk through a season does not come back
    // through any card: 下一集, the 选集 panel and the manual next/prev all ask for a sibling by id alone.
    // It is keyed on `versionLabel` rather than on the server's `Name` because a name cannot travel —
    // measured 2026-10-27 over the item endpoint's 800 sampled rows, 5 of 400 episode rows carry two or
    // three versions and 14,992 of 15,000 episode version names embed their own 「S01E04」, so
    // 「… - S01E01 - 第 1 集 - tv」 is never the next episode's name and the raw comparison hit nothing at
    // all in a live three-episode walk. The shape word is the one that repeats: asked of the live item
    // endpoint over eight episodes per show, 哺乳动物星球 S01 carries 「tv」 on 6 of 6 of them, so a pick
    // made on 第 1 集 answers 第 2–6 集. The other four two-version shows name their versions with no shape
    // word at all — 黑袍纠察队 gives both rows the same 「… - S03E08 - 第 8 集」 — and those write nothing,
    // so their siblings take their own first source, which is where they would have landed anyway.
    const sameShape = item.seriesId ? this.seriesVersion.get(item.seriesId) : undefined;
    const fromSeries = sameShape && (item.sources || []).length > 1
      ? item.sources?.find(s => versionLabel(s.name).toLowerCase() === sameShape)?.id
      : undefined;
    const wanted = this.itemVersion.get(itemId) || fromSeries;
    const neg = await c.negotiate(itemId, { sourceId: wanted });
    this.rememberVersion(itemId, item.seriesId, neg.sources[neg.sourceIndex]);

    // 首选语言: which of this version's tracks opens. Answered against the streams the server just described,
    // before mpv holds a file — the pick travels with the load (see `setNextTracks`) instead of being written
    // onto a pipe that has nothing to write it to yet. Nothing set means nothing forced: an empty preference
    // leaves mpv's own order in charge, which is what every file got before this row existed.
    const pick = pickTracks(neg.sources[neg.sourceIndex], prefs);

    // HDR has to be decided before mpv exists. A process started into an SDR swapchain stays mapped to SDR
    // until it opens the next file (measured 2026-10-29: its log keeps saying RGB_FULL_G22_NONE_P709 on a
    // desktop that has since switched), and the switch itself blanks the screen for about a second — so it
    // is asked for here, while there is still nothing to look at, rather than in front of a first frame.
    await this.hdrFor(prefs, neg.hdr);

    // The windows only open once the server has agreed to serve something: a refused negotiation should
    // fail on the page 播放 was pressed from, not on a black screen with no controls.
    if (!this.windows.isOpen) this.windows.open(this.rendererUrl('#/player'));
    await this.ensureKernel(prefs);

    const url = await this.bridge.mount(neg.url);
    this.thumbUrl = url;

    // 弹幕 asks by name and year, and the year is the only thing that separates 进击的巨人 (2013) from
    // 完结篇 THE LAST ATTACK (2024) — an episode row carries no year of its own, so the season supplies one.
    const dmYear = await this.yearFor(c, item);

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
      danmaku: this.danmakuOf(item, dmYear),
      reported: resume.played,
      ended: false,
      flushedMs: -1,
      runtimeMs: Math.round((item.runTimeTicks || 0) / 1e4),
      startMs: resume.startMs,
    };
    this.out.session(this.getSession());
    this.raise();

    // Before the load, so a picture subtitle is in place when mpv opens the file (see `syncExternal`).
    await this.syncExternal(this.current);
    this.kernel!.setNextTracks(this.trackWanted(pick));
    try {
      await this.kernel!.load(url, { startMs: fromStart ? 0 : resume.startMs, paused: false });
    } catch (e) {
      this.fail(e);
      throw e;
    }

    // A subtitle file the viewer brought for this item comes back on its own, and after the sidecar: which
    // of the two is on screen should be the deliberate choice, not whichever promise resolved last.
    const here = this.current;
    // A sidecar that cannot be fetched must not cost the viewer the file they brought: the two are chained
    // the other way round, sidecar first and only then 本地字幕, and a failure there is swallowed alone.
    void this.openPickedSidecar(pick)
      .catch(() => undefined)
      .then(() => this.restoreLocal(here));
    // The start report carries the offset the *server* holds, never the 0 a 「播放」 button loaded at:
    // measured on bangumi, an open that reports 0 rewrites the item to 0 about a minute later while the
    // session is live, so a hard-killed app left 187396 sitting at nothing and the next 看到 had no number
    // to print. An open that reports the stored offset leaves that offset standing.
    void this.announceStart(resume.startMs, Math.round((item.runTimeTicks || 0) / 1e4)).catch(() => undefined);
    // 进度条预览图. Started here rather than at mount so the worker's first seek cannot land while the
    // film itself is still opening its file; it reads through the same bridge, so the preview pays for no
    // second TLS handshake and no second proxy route.
    if (prefs.thumbPreview) this.thumbs.open(url, this.current?.runtimeMs || 0, this.thumbOpen());
    // 追剧时预取下一集: only after this one is actually up, so the film being watched never waits behind a
    // speculative fetch. `nav.next` is the neighbour inside the season - the same row 下一集 would take.
    const next = this.current?.next;
    if (next && item.type === 'Episode') this.prefetchNext(c, next.itemId, item.seriesId);
  }

  /** Pulls the opening minutes of the next episode into the media cache, in the version this show is being
   *  watched in: a season picked at 1080p must not prefetch 4K. Failure is silent by design - a prefetch that
   *  cannot happen is the state the app was in before this feature existed. */
  private prefetchNext(c: EmbyClient, nextId: string, seriesId?: string): void {
    const prefs = config.get().settings.mediaCache;
    if (!prefs.enabled || !prefs.prefetchNext) return;
    const shape = seriesId ? this.seriesVersion.get(seriesId) : undefined;
    void (async () => {
      const next = await c.item(nextId);
      const sourceId = shape && (next.sources || []).length > 1
        ? next.sources?.find(s => versionLabel(s.name).toLowerCase() === shape)?.id
        : undefined;
      const neg = await c.negotiate(nextId, { sourceId: sourceId || this.itemVersion.get(nextId) });
      await mediaCache.prefetch(neg.url, Math.round((next.runTimeTicks || 0) / 1e4));
    })().catch(() => undefined);
  }

  /** Which year the thing being played belongs to, for 弹幕's ranking.
   *
   *  The item's own year wins. An episode usually has none, so the season is asked — one request per season,
   *  remembered, and skipped entirely for films and for seasons that carry their own year. Season 1 may fall
   *  back to the series date, which is the year the show began; later seasons may not, because a show that
   *  has run for a decade did not start in its third season's year, and borrowing it would rank every season
   *  against the first one's rows. */
  private async yearFor(c: EmbyClient, item: LibraryItem): Promise<number | undefined> {
    const own = item.productionYear || yearOfDate(item.premiereDate);
    if (own || item.type !== 'Episode') return own;
    const seasonId = item.seasonId || item.parentId || '';
    const key = seasonId || `${item.seriesId || item.id}#${item.parentIndexNumber ?? 1}`;
    if (this.seasonYear.has(key)) return this.seasonYear.get(key);
    let year: number | undefined;
    try {
      const season = seasonId ? await c.item(seasonId) : null;
      year = season?.productionYear || yearOfDate(season?.premiereDate);
      if (!year && (item.parentIndexNumber ?? 1) <= 1 && item.seriesId) {
        const series = await c.item(item.seriesId);
        year = series?.productionYear || yearOfDate(series?.premiereDate);
      }
    } catch {
      year = undefined;
    }
    this.seasonYear.set(key, year);
    return year;
  }

  /** What a danmaku service is asked about. An episode called 「第 3 集」 matches nothing, so the series
   *  name travels with it; the series id lets one hand-made link cover a whole show, and the TMDB id — when
   *  the library carries one — is the single answer the service resolves without reading a title at all.
   *  Episodes rarely carry providers of their own, so the id is simply absent there and the ladder guesses
   *  from the name as it did before. */
  private danmakuOf(item: LibraryItem, year?: number): DanmakuQuery {
    return {
      itemId: item.id,
      title: item.name,
      seriesName: item.type === 'Episode' ? item.seriesName || item.name : item.name,
      episode: item.indexNumber,
      seriesId: item.seriesId,
      season: item.parentIndexNumber,
      year: item.productionYear || year,
      tmdbId: item.providers?.tmdb,
      originalTitle: item.type === 'Episode' ? undefined : item.originalTitle,
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

  /** Puts the desktop into HDR for a file that has it, and takes it back out for one that does not.
   *
   *  Only asked when the row is on: the switch blanks the screen for a moment and nothing should do that to
   *  someone who never asked for it. A panel that cannot switch, a driver that refuses, a desktop already
   *  in HDR — all three end here with no picture changing, and mpv tone-maps the file as it always did. */
  private async hdrFor(prefs: PlayerPrefs, isHdr: boolean): Promise<void> {
    if (!prefs.hdr || !isHdr) {
      this.screen.restore();
      return;
    }
    if (await this.screen.on()) console.log('[hdr] Windows 已切到 HDR');
  }

  /** mpv only renders into a window handed to it at launch, so the handle has to be right before anything
   *  loads. The launch shape itself never changes now — one render profile, chosen in the command line — so
   *  a process that is already up is reused and only the knobs mpv can still move are set: the decoder and
   *  the picture fit. */
  private async ensureKernel(prefs: PlayerPrefs): Promise<void> {
    if (this.kernel?.running) {
      await this.kernel.setHwdec(prefs.hwdec).catch(() => undefined);
      await this.kernel.setFit(prefs.fit).catch(() => undefined);
      await this.kernel.setAnime4k(prefs.anime4k).catch(() => undefined);
      return;
    }
    const k = new MpvKernel();
    k.onState = s => this.onKernelState(s);
    k.onMedia = m => this.onKernelMedia(m);
    k.onGone = message => this.onGone(message);
    this.kernel = k;
    await k.start({ hwnd: this.windows.hostHwnd(), prefs: { hwdec: prefs.hwdec, fit: prefs.fit, anime4k: prefs.anime4k } });
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
    /* The picture died with the process, so the screen must not stay in HDR behind an error line: the only
       thing left on it is 「播放器断开了连接」, and every other window on the machine would sit washed out
       until this one is closed. Measured 2026-10-29 by killing a playing mpv: the desktop stayed 0x3 for as
       long as the overlay was open. A restore only undoes a switch this app made, so a viewer who runs HDR
       all day keeps it, and a retry goes back through hdrFor like any other start. */
    this.screen.restore();
    this.state = { ...this.state, status: 'error', error: message || '播放器退出了' };
    this.out.state(this.state);
  }

  private fail(e: unknown): void {
    this.state = { ...this.state, status: 'error', error: explain(e) };
    this.out.state(this.state);
  }

  /** Whether playback is short of data right now. The preview sweep asks this before every cell: on a slow
   * link the worker and the film compete for the same bytes, and a stutter costs more than a preview gives. */
  private starving(): boolean {
    const s = this.state;
    return s.status === 'playing' && s.bufferedMs > 0 && s.bufferedMs - s.positionMs < 5_000;
  }

  private onKernelState(s: PlayerState): void {
    // The read-out answers "what is this app pulling right now", and the posters on screen belong to that
    // answer even though they never pass through the player. mpv's own counter is the video; this is
    // everything else on Chromium's stack, refreshed on the same tick the player reports.
    const merged: PlayerState = { ...s, netBytesPerSec: s.netBytesPerSec + Math.round(appBytesPerSec()) };
    this.state = merged;
    this.out.state(merged);
    /* 播放时隐藏主程序 happens on the first frame rather than when 播放 was pressed: mpv takes a beat to open
       the file, and a window that vanished before the picture arrived would leave the desktop empty for
       that whole beat — the one moment where nothing on screen even says what is going on. */
    if (merged.status === 'playing' && !this.hidMain) this.hidMain = this.out.hideMain();
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
    // Same witness for 本地字幕. The remembered file is not dropped when its track goes missing: mpv drops
    // every added track on a load, and the re-add that follows such a load is what puts one back.
    const here = this.local;
    const localLive = here && m.tracks.some(t => t.kind === 'subtitle' && t.id === here.trackId) ? here : null;
    // A load can also take away a track that was added a moment too early: put it back rather than leave the
    // viewer reading the film's own subtitles after they chose a file of their own.
    if (here && !localLive && this.state.durationMs > 0) void this.repairLocal();
    this.media = {
      ...m,
      sidecar: live ? { trackId: live.trackId, index: live.index } : null,
      localSub: localLive
        ? { trackId: localLive.trackId, name: localLive.entry.name, bitmap: localLive.entry.bitmap, positioned: localLive.entry.positioned, dx: localLive.entry.dx, dy: localLive.entry.dy }
        : null,
    };
    this.out.media(this.media);
  }

  /** Reaching the end is the only moment the server is told this item is finished, and it is also what
   *  makes 下一集 automatic. Measured: with --keep-open=yes the end never arrives as an end-file event —
   *  that is why the old `status === 'ended'` branch, and with it markPlayed, never ran. */
  private async onEnded(): Promise<void> {
    const c = this.current;
    if (!c || c.ended) return;
    c.ended = true;
    // A re-watch opens with `reported` already true: the server holds 已播放 for it, so there is no stop to
    // publish and nothing to mark. The next episode still has to play — measured 2026-10-29: the flag that
    // stops a second POST also stopped 自动下一集 on any episode already in 看过.
    const fresh = !c.reported;
    c.reported = true;
    const w = fresh ? await this.flushStop(this.state.durationMs, 'ended') : null;
    // Reaching the end is what earns the 已播放 mark, and it does not depend on the position write having
    // landed. These were chained: a stopped report the server refused used to leave a finished film
    // unmarked as well as unfindable.
    // Same answer as the position write: no 已播放 mark is left on a machine that never served the file.
    const played = fresh && !this.serverGone() ? await this.client().markPlayed(c.itemId) : false;
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
  private serverStreamIndex(kind: 'video' | 'audio' | 'subtitle', c: Current | null = this.current): number | undefined {
    const src = c ? c.sources[c.sourceIndex] : undefined;
    if (!src) return undefined;
    const picked = this.media.tracks.find(t => t.kind === kind && t.selected && !t.external);
    if (picked?.ffIndex === undefined) return undefined;
    const rows = kind === 'video' ? (src.video ? [src.video] : []) : kind === 'audio' ? src.audio : src.subtitle;
    return rows.some(r => r.index === picked.ffIndex) ? picked.ffIndex : undefined;
  }

  /** The session is passed in rather than read from `this.current`: a close and an end-of-file can race, and
   *  the loser used to dereference a session the other one had already cleared (logged 2026-10-30 as
   *  「[ipc] player:close TypeError: Cannot read properties of null (reading 'itemId')」). */
  private progressInput(c: Current | null, paused: boolean, atMs: number, durationMs = this.state.durationMs): ProgressInput {
    if (!c) throw new Error('没有在播放任何东西');
    return {
      itemId: c.itemId,
      sourceId: c.sources[c.sourceIndex]?.id || '',
      playSessionId: c.playSessionId,
      positionMs: atMs,
      durationMs,
      paused,
      rate: this.state.speed,
      volume: this.state.muted ? 0 : this.state.volume,
      videoIndex: this.serverStreamIndex('video', c),
      audioIndex: this.serverStreamIndex('audio', c),
      subtitleIndex: this.serverStreamIndex('subtitle', c),
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
    await this.client().session(this.progressInput(c, false, at, durationMs ?? this.state.durationMs), 'start');
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
    // The number is claimed before the request, not after it: an end-of-file and the close that follows it
    // both read a free slot and both posted the same stop (2026-10-30, two 「停止没写出去」 lines for one
    // exit). A failure frees the slot again, because a report that never landed is worth another try.
    c.flushedMs = at;
    let ok = await client.session(this.progressInput(c, true, at, durationMs), 'stopped');
    if (!ok) ok = await client.session(this.progressInput(c, true, at, durationMs), 'stopped');
    if (!ok) {
      c.flushedMs = -1;
      console.warn('[player] 停止没写出去', reason, c.itemId, `pos=${Math.round(at)}`, `len=${durationMs}`, `start=${Math.round(c.startMs)}`);
      return null;
    }
    // What the server took, even when it took 0: an accepted number that the item never shows is only
    // tellable apart from a write that never went out by having the number on the record.
    console.log('[player] 停止已写', reason, c.itemId, `pos=${Math.round(at)}`, `len=${durationMs}`);
    const held = await this.confirmHeld(client, c.itemId, at, durationMs, reason);
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
    // One percent of the film, or 1.5 s, whichever is longer. Measured 2026-10-28 on 挽救计划: a stop sent
    // at 717,083 ms came back 711,336 — 0.61% apart, which is this gateway running its own progress clock,
    // not the clearing the line below exists to catch.
    const near = Math.max(1500, durationMs * 0.01);
    if (Math.abs(first.startMs - at) <= near) return first.startMs;
    await new Promise(r => setTimeout(r, 700));
    const again = await ask();
    const held = again ? again.startMs : first.startMs;
    // 被抹 is a specific claim: the position went away rather than moved. A gateway clears anything under
    // ~3% (the three runs put the threshold in (2.55%, 3.47%]), so that is the test — anything else is the
    // same rounding, and a healthy close that logs a warning is a warning nobody can trust later. The
    // number published is `held` either way.
    const floor = durationMs * 0.03;
    if (at >= floor && held < floor) {
      console.warn('[player] 停止被抹', reason, itemId, `sent=${Math.round(at)}`, `held=${Math.round(held)}`, `start=${Math.round(this.current?.startMs ?? 0)}`);
    }
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
        // A hand-made choice wins over the watch that keeps a 本地字幕 in front.
        if (cmd.value.kind === 'subtitle') this.stopHold();
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
      case 'subtitleSpeed':
        await k.setSubtitleSpeed(cmd.value);
        return;
      case 'subtitleShift':
        await this.shiftLocal(cmd.value.dx, cmd.value.dy);
        return;
      case 'dropLocalSubtitle':
        await this.dropLocal();
        return;
      case 'aspect':
        await k.setAspect(cmd.value);
        return;
      case 'fit':
        await k.setFit(cmd.value);
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

  /** The pick, in the numbers the kernel can act on: the server's `Index` per stream — the same number mpv
   *  repeats as `ff-index`, which `serverStreamIndex` above is the measurement for — and `'no'` for 关闭字幕.
   *  Null when neither preference named a language, so the kernel never keeps a half-answer to apply later. */
  private trackWanted(pick: TrackPick): { audio?: number; subtitle?: number | 'no' } | null {
    const w: { audio?: number; subtitle?: number | 'no' } = {};
    if (pick.audio?.index !== undefined) w.audio = pick.audio.index;
    if (pick.subtitle === 'off') w.subtitle = 'no';
    // An external pick is not a number mpv can be handed: a sidecar gets its own track id only after
    // sub-add, and its ff-index is -1 — a server Index it can never equal. Leaving it in the list would
    // keep a pick pending for the whole viewing, ready to land on any later track-list event (a second
    // sidecar, a remux), so it is fetched and selected by openPickedSidecar instead.
    else if (pick.subtitle && !pick.subtitle.isExternal && pick.subtitle.index !== undefined) w.subtitle = pick.subtitle.index;
    return w.audio === undefined && w.subtitle === undefined ? null : w;
  }

  /** A preferred subtitle the server keeps beside the file rather than inside it. mpv can only reach those
   *  once the bytes are on disk, so the pick is fetched and added after the load — and a failure here stays
   *  silent on purpose: the file's own subtitles are on screen by then, which is the state the app was in
   *  before the setting existed. `pickTracks` already ruled out the rows that cannot work (a `sup` picture
   *  is not something mpv can read from a file), so what is left is a dropped connection or a gateway that
   *  no longer holds it. */
  private async openPickedSidecar(pick: TrackPick): Promise<void> {
    const sub = pick.subtitle;
    if (!sub || sub === 'off' || !sub.isExternal || sub.index === undefined) return;
    if (sub.isTextSubtitle === false) return;
    const c = this.current;
    if (!c) return;
    try {
      await this.useSidecar(sub.index);
    } catch {
      /* 外挂取不回来时，内封的轨道还在，画面照常 */
    }
  }
  /** 本地字幕: a file the viewer picked off their own disk. Copied in and remembered against the item, so the
   *  next viewing has it back without the picker — and, unlike a sidecar, it survives the app being closed.
   *  The copy is what mpv reads: the original may be on a drive that is gone tomorrow. */
  async useLocalSubtitle(source: string): Promise<void> {
    const c = this.current;
    const k = this.kernel;
    if (!c || !k) throw new Error('没有在播放任何东西');
    const entry = await subs.importFile(source);
    if (entry.bitmap) {
      // A picture track cannot be handed to a file that is already open: it enters as an external file, and
      // mpv reads that list when it opens one. So the item is remembered first and a reload is what puts it in
      // front — `restoreLocal` then finds the track and selects it like any other 本地字幕.
      // The entry in memory belongs to the file being replaced, and `restoreLocal` prefers it over the index —
      // dropping it first is what lets the reload find the picture track it was just handed.
      this.stopHold();
      this.local = null;
      await subs.remember(c.accountId, c.itemId, entry);
      await k.setExternalFiles([entry.file]);
      await this.replay({});
      return;
    }
    await this.attachLocal(c, entry);
    await subs.remember(c.accountId, c.itemId, entry);
  }

  /** mpv's external-file list is how a picture subtitle travels, and it outlives a load: without this, one
   *  film's `.sup` would be handed to the next episode as well. Written before every load, empty or not. */
  private async syncExternal(c: { accountId: string; itemId: string } | null): Promise<void> {
    const k = this.kernel;
    if (!k) return;
    let entry: LocalSubtitle | null = null;
    if (c) {
      try {
        entry = await subs.recall(c.accountId, c.itemId);
      } catch {
        entry = null;
      }
    }
    await k.setExternalFiles(entry?.bitmap ? [entry.file] : []).catch(() => undefined);
  }

  /** Put one 本地字幕 in front of the picture: the shifted copy on disk, through `sub-add`, and selected by
   *  the id mpv answers with. The previous one is removed only after the new one is in, so a file that fails
   *  to load leaves the subtitle the viewer was reading untouched. */
  private async attachLocal(c: Current, entry: LocalSubtitle): Promise<void> {
    const k = this.kernel;
    if (!k) throw new Error('播放器已经关闭');
    let trackId: number | null;
    if (entry.bitmap) {
      // Already in mpv: the external list was written before this file was opened. Nothing to shift either —
      // a picture track has no coordinates we can rewrite.
      trackId = await k.findBitmapSubtitle();
      if (trackId === null) throw new Error('播放器还没读到这条图像字幕');
    } else {
      const file = await subs.shiftedFile(entry, entry.dx, entry.dy);
      trackId = await k.addSubtitleFile(file, entry.name);
      if (trackId === null) throw new Error('播放器读不了这条字幕文件');
    }
    const prev = this.local;
    this.local = { entry, key: subs.subtitleKey(c.accountId, c.itemId), trackId };
    await k.setTrack('subtitle', trackId);
    this.holdLocal(trackId);
    if (prev && prev.trackId !== trackId) await k.removeSubtitleFile(prev.trackId).catch(() => undefined);
  }

  /** mpv finishes opening a file after `sub-add` has already answered, and its own default pick can then land
   *  on top of the `sid` written above — measured 2026-10-31: switching a film to its 1080p cut listed the
   *  local track first, the write went through, and the film's own 简体 was on screen seconds later. This
   *  watch puts the viewer's own file back in front, and stops the moment they pick a track by hand. */
  private holdLocal(trackId: number): void {
    this.stopHold();
    /* A load can take ten seconds on a remote file, and mpv only makes its own pick once it is open — so the
       watch runs until the file is really open and the choice has then held for three ticks, not for a fixed
       number of tries. One property read per tick; the write only happens when mpv has taken the track away. */
    let left = 60;
    let settled = 0;
    this.localHold = setInterval(() => {
      const k = this.kernel;
      if (!k || !this.local || this.local.trackId !== trackId || left <= 0) {
        this.stopHold();
        return;
      }
      left -= 1;
      /* The track list, not `sid`: mpv answers 'auto' there after a load even when the row it is showing is
         the one written (it only fires the property's change event for a value that differs). */
      if (this.media.tracks.some((t) => t.kind === 'subtitle' && t.id === trackId && t.selected)) {
        if (this.state.durationMs > 0 && ++settled >= 3) this.stopHold();
        return;
      }
      settled = 0;
      void k.setTrack('subtitle', trackId).catch(() => undefined);
    }, 500);
  }

  private stopHold(): void {
    if (this.localHold) clearInterval(this.localHold);
    this.localHold = null;
  }

  /** mpv dropped the added track on a load (or refused it while still opening). Hand the same file over
   *  again — once at a time, because a re-add that is already running will be seen by the same witness. */
  private async repairLocal(): Promise<void> {
    if (this.localRepair) return;
    const c = this.current;
    const here = this.local;
    if (!c || !here) return;
    this.localRepair = true;
    try {
      await new Promise((r) => setTimeout(r, 300));
      if (this.current !== c || this.local !== here) return;
      if (this.media.tracks.some((t) => t.kind === 'subtitle' && t.id === here.trackId)) return;
      await this.attachLocal(c, here.entry);
    } catch {
      /* the film's own tracks are still there; a file mpv cannot read must not become a 播放错误 */
    } finally {
      this.localRepair = false;
    }
  }

  /** Called after every load — the first play, a version switch, 下一集. mpv forgets added files on a load, so
   *  the same file has to be handed over again rather than re-selected; the shift the viewer dialled in is
   *  part of what is handed over, which is why it lives in the entry and not in mpv's properties. */
  private async restoreLocal(c: Current): Promise<void> {
    this.stopHold();
    if (this.current !== c) return;
    let entry: LocalSubtitle | null = null;
    try {
      const key = subs.subtitleKey(c.accountId, c.itemId);
      entry = this.local && this.local.key === key ? this.local.entry : await subs.recall(c.accountId, c.itemId);
    } catch {
      entry = null;
    }
    this.local = null;
    if (!entry) return;
    /* A version switch answers before mpv has the new file open, and sub-add in that window leaves no track
       behind — measured: the added file came back with an id, and two seconds later the list held only the
       film's own two tracks. Three tries cover it without making a broken file into a 播放错误. */
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (this.current !== c || !this.kernel) return;
      try {
        await this.attachLocal(c, entry);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
  }

  /** 移除: gone from mpv now and from the memory of this item, so it does not come back on the next 播放. */
  private async dropLocal(): Promise<void> {
    const c = this.current;
    const k = this.kernel;
    const was = this.local;
    this.stopHold();
    this.local = null;
    if (was && k) await k.removeSubtitleFile(was.trackId).catch(() => undefined);
    // A picture track leaves through the same list it came in by, or the next file would inherit it.
    if (was?.entry.bitmap && k) await k.setExternalFiles([]).catch(() => undefined);
    if (c) await subs.forget(c.accountId, c.itemId);
    // mpv does not answer a removal by picking another subtitle: measured 2026-10-31, taking away the selected
    // track left `sid=false` on a file that holds 34 of them. The preference already knows which one the film
    // would have started on, so 移除 puts back what a fresh 播放 gives.
    if (c && k) {
      const pick = pickTracks(c.sources[c.sourceIndex], config.get().settings.player);
      k.applyTracksNow(this.trackWanted(pick));
      void this.openPickedSidecar(pick).catch(() => undefined);
    }
  }

  /** 特效位置: only a file that writes its own coordinates can be moved this way (on those, mpv's `sub-pos`
   *  is a no-op — measured), so the file is rewritten and handed over again. The offset accumulates from the
   *  original copy, never from the already-shifted one. */
  private async shiftLocal(dx: number, dy: number): Promise<void> {
    const c = this.current;
    const was = this.local;
    if (!c || !was) throw new Error('还没有导入本地字幕');
    if (was.entry.bitmap) throw new Error('图像字幕的位置由片子决定，挪不动');
    if (!was.entry.positioned) throw new Error('这条字幕没有自带定位，用「高度」调整');
    const entry: LocalSubtitle = { ...was.entry, dx: was.entry.dx + dx, dy: was.entry.dy + dy };
    await this.attachLocal(c, entry);
    await subs.remember(c.accountId, c.itemId, entry);
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
  async chooseSource(itemId: string, sourceId: string): Promise<void> {
    this.itemVersion.set(itemId, sourceId);
    // A pick about the file already playing is not a note for next time: the page presses that strip and
    // the panel pops up on it, so leaving the old file in mpv made the page and the player disagree about
    // what was on screen. A pick about anything else stays a note — there is nothing to switch yet.
    const c = this.current;
    if (!c || c.itemId !== itemId) return;
    const index = c.sources.findIndex(s => s.id === sourceId);
    if (index < 0 || index === c.sourceIndex) return;
    try {
      await this.useSource(index);
    } catch (e) {
      this.itemVersion.set(itemId, c.sources[c.sourceIndex]?.id || '');
      throw e;
    }
  }

  /** File the player is now on, into both memories. Called from `play` and from `replay`, which is what a
   *  播放源 card inside the player drives — a switch made there is as much the user's answer as one made on
   *  the page, and the page has no way to see it: the player is a second window whose session object never
   *  reaches the library renderer. */
  private rememberVersion(itemId: string, seriesId: string | undefined, src: Pick<PlaybackSource, 'id' | 'name'> | undefined): void {
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
    // A paused film stays paused: this reload exists to make the picture agree with the desktop, and a viewer
    // who left it on a frame did not ask for it to start running again. Measured 2026-10-29: pausing at
    // 20:58 and switching the HDR row off put the film back at 20:58 and playing.
    const wasPaused = this.state.paused === true;
    const neg = await this.client().negotiate(itemId, opts);
    const pick = pickTracks(neg.sources[neg.sourceIndex], config.get().settings.player);
    if (this.current !== c) return;
    // A version change can move the file between HDR and SDR (the 2160p cut of a film and its 1080p copy
    // are not always both HDR), so the desk is asked again: mpv re-reads the display for every new file.
    await this.hdrFor(config.get().settings.player, neg.hdr);
    const url = await this.bridge.mount(neg.url);
    this.thumbUrl = url;
    c.sourceIndex = neg.sourceIndex;
    c.sources = neg.sources;
    this.rememberVersion(itemId, c.seriesId, neg.sources[neg.sourceIndex]);
    c.playSessionId = neg.playSessionId || c.playSessionId;
    c.method = neg.method;
    c.hdr = neg.hdr;
    this.out.session(this.getSession());
    // A remux is a different file: its stream numbers, its subtitle tracks and any sidecar `sub-add` gave it
    // all belong to the version being left. mpv drops external files on a load, so a remembered track id here
    // would name a track that no longer exists and a `sid` write would fail silently — the next sidecar
    // therefore has to be fetched again rather than re-selected.
    this.sidecar = null;
    await this.syncExternal(c);
    this.kernel!.setNextTracks(this.trackWanted(pick));
    try {
      await k.load(url, { startMs: wasAt, paused: wasPaused });
    } catch (e) {
      this.fail(e);
      throw e;
    }
    await k.setSpeed(speed).catch(() => undefined);
    if (wasPaused) await k.setPaused(true).catch(() => undefined);
    void this.openPickedSidecar(pick)
      .catch(() => undefined)
      .then(() => this.restoreLocal(c));
    // The frames belonged to the version that was playing; this one is a different file, so the grid is
    // rebuilt from scratch against it.
    if (config.get().settings.player.thumbPreview) this.thumbs.open(url, c.runtimeMs, this.thumbOpen());
    // No second 开场 here. This is the same item inside the same session, and FirstPlay is the event that
    // stamps PlayCount and LastPlayedDate — measured 2026-10-24, one open of 小鬼当家 answers PlayCount 1 —
    // so re-announcing on every knob move would publish another 收看过 for something that was never a new
    // viewing. The stopped report on the way out carries the source this stream actually ended on.
  }

  /** The knobs mpv can still move while something is playing: the decoder, the picture fit, and, for a file
   *  that has HDR, the desktop's own switch. Nothing here reloads the file: the render profile is fixed at
   *  launch and the version is chosen before the stream opens.
   *
   *  The screen is never touched for an SDR file, and a switch this app did not make is never undone:
   *  pressing 关 means 「不要替我把屏幕切到 HDR」, not 「把我的屏幕从 HDR 里切出来」. */
  applyPrefs(prefs: PlayerPrefs): void {
    // 进度条预览图 is a switch over a second decoder (measured 608 MB resident while it scans a 4K source),
    // so 关 puts that process away on the spot rather than waiting for the next pointer move over the bar.
    if (!prefs.thumbPreview) this.thumbs.close();
    const k = this.kernel;
    if (k?.running) {
      void k.setHwdec(prefs.hwdec).catch(() => undefined);
      void k.setFit(prefs.fit).catch(() => undefined);
      // 画质增强 is a property of the picture, not of the file: the chain is recompiled on the running player
      // and the position does not move (measured 2026-10-29). A file opened later inherits it, because the
      // property is mpv's own and survives loadfile.
      void k.setAnime4k(prefs.anime4k).catch(() => undefined);
    }
    const c = this.current;
    const needSrc = c ? c.sources[c.sourceIndex]?.id : undefined;
    const want = prefs.hdr && c?.hdr === true;
    const was = this.screen.state()?.enabled === true;
    // Even with nothing playing a 关 still has to hand the screen back: that is the only way to undo a HDR
    // left on by a player closed from the taskbar rather than from its own button.
    if (!want) {
      this.screen.restore();
      // Nothing was handed back, so there is nothing below to make the picture agree with.
      if (!k?.running || !c || !was) return;
    }
    void (async () => {
      if (want) await this.screen.on();
      const now = this.screen.state()?.enabled === true;
      // mpv only re-creates its swapchain when it opens a file, so a switch made under a running one leaves
      // the picture describing the mode that just went away — a PQ frame into an SDR desktop is a washed grey
      // picture (measured 2026-10-29: saturation 13.8% → 2.0% with the frame otherwise unchanged). Reloading
      // the same stream at the same position is what makes this switch honest; without it the row would have
      // to say 「合上播放器再打开」, which is the thing it was added to avoid.
      if (now !== was && this.current === c && this.kernel?.running) {
        await this.replay({ sourceId: needSrc }).catch(() => undefined);
      }
    })().catch(() => undefined);
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
    this.hidMain = false;
    mediaCache.cancelPrefetch();
    this.thumbs.close();
    this.thumbUrl = '';
    // The stop is written before anything is torn down: mpv still holds the real position, and the number
    // the lobby is handed must be the one the server just took.
    const w = await this.flushStop(undefined, 'close');
    this.current = null;
    // The film left the screen, so the screen goes back to what it was before this viewing. `restore` only
    // undoes a switch this app made, which is what keeps a viewer who runs HDR all day untouched.
    this.screen.restore();
    await this.kernel?.quit().catch(() => undefined);
    this.kernel = null;
    this.bridge.close();
    this.windows.close();
    this.dropSidecar();
    this.stopHold();
    this.local = null;
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
    this.hidMain = false;
    mediaCache.cancelPrefetch();
    /* The screen comes back before the one POST that can wait: the exit budget is five seconds and a stop
       written onto a cold connection has taken seven, so a desktop left in HDR must not be what the race
       above charges for a write it may cut anyway. */
    this.screen.restore();
    this.thumbs.close();
    this.thumbUrl = '';
    await this.flushStop(undefined, 'quit');
    this.current = null;
    await this.kernel?.quit().catch(() => undefined);
    this.kernel = null;
    this.bridge.close();
    this.windows.close();
    this.dropSidecar();
    this.stopHold();
    this.local = null;
  }
}
