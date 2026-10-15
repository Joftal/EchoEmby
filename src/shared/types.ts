export interface Account {
  accountId: string;
  serverName: string;
  /** Name typed on this machine; every gateway calls itself OkEmby, so this is the only way to tell two apart. */
  label?: string;
  baseUrl: string;
  username: string;
  userId: string;
  accessToken: string;
  lastUsed: number;
}

export interface Settings {
  player: PlayerPrefs;
  /** Which route the whole app takes to reach the server. Every request this client makes - API,
   *  images, the playback bridge, the outside metadata services - goes through Chromium's net.fetch,
   *  so one session proxy setting covers all of them. */
  proxyMode: 'system' | 'manual' | 'none';
  /** The 手动代理 address: `127.0.0.1:7897`, `http://host:port`, `socks5://host:port`, optionally with
   *  `user:pass@` in front of the host. */
  proxyUrl: string;
  danmaku: DanmakuSettings;
}

/** A settings write may name only the rows the user touched, so every nested block is partial too; the
 *  main process rebuilds each block from its own defaults before it lands in the file. */
export type SettingsPatch = Omit<Partial<Settings>, 'player' | 'danmaku'> & {
  player?: Partial<PlayerPrefs>;
  danmaku?: Omit<Partial<DanmakuSettings>, 'source'> & { source?: Partial<DanmakuSourceConfig> };
};

/** Knobs that belong to the player itself. `tier` and `hwdec` are read again when the next stream is
 *  negotiated and when mpv is launched, so neither needs a restart. */
export interface PlayerPrefs {
  /** The bitrate cap offered to the server during PlaybackInfo. 0 is 原片: ask for the file itself and
   *  forbid transcoding, which is what 原片 means to Emby. */
  tier: number;
  hwdec: 'd3d11va' | 'cuda' | 'auto' | 'no';
  /** ← / →, and the two skip buttons either side of the play button. */
  seekStepMs: number;
  /** How long the controls stay up after the pointer stops moving. */
  controlsTimeoutMs: number;
  /** Hand the HDR signal to the display instead of letting mpv tone-map it to SDR. Off by default: a
   *  screen that cannot show it renders the picture washed out. */
  hdrHint: boolean;
  /** 'smooth' spends the GPU on frames, 'hq' spends it on sharpness (gpu-hq + interpolation). */
  render: 'smooth' | 'hq';
  /** Move to the next episode when the file reaches its end. */
  autoNext: boolean;
}

export interface DanmakuSourceConfig {
  /** 'bilibili' needs no key but only knows titles that aired there; 'dandan' is any
   *  dandanplay-compatible service, self-hosted or not, and carries its own address and token. */
  type: 'bilibili' | 'dandan';
  url: string;
  token: string;
}

export interface DanmakuSettings {
  /** Off by default: with this off the app never asks a danmaku service about what you watch. */
  enabled: boolean;
  source: DanmakuSourceConfig;
  /** 0 asks the source with whatever the library calls the show, 1 only accepts an exact title. */
  matchMode: 0 | 1;
  /** Fraction of the picture height the scrolling lanes may use. */
  displayArea: number;
  opacity: number;
  fontScale: number;
  /** How long one comment takes to cross. */
  durationMs: number;
  /** The wall: a dense timeline past this count drops comments rather than frames. */
  maxOnScreen: number;
  /** Commas or newlines. Filtered on the way in, so the cached track is already clean. */
  blockedWords: string;
}

/** What the 连接测试 row answers with: one round trip to the gateway and one to an address echo, both
 *  through whatever route is set right now. */
export interface NetProbe {
  serverMs: number | null;
  egressIp: string;
  egressRegion: string;
  /** Already in Chinese, and only about the leg that failed; empty when both answered. */
  error: string;
}

export interface AppConfig {
  deviceId: string;
  deviceName: string;
  clientName: string;
  clientVersion: string;
  accounts: Account[];
  activeAccountId: string | null;
  settings: Settings;
  meta?: MetaKeys;
}

/** User-supplied keys for outside metadata sources; both fields are encrypted at rest. */
export interface MetaKeys {
  tmdbV4Token?: string;
  traktClientId?: string;
}

/** One choice in a filter dropdown. Genres filter by name and Studios by id, so a facet row carries both. */
export interface FacetOption {
  name: string;
  id?: string;
}

/** A production company as the server names it. Both servers answer `{Name,Id}` rows on the list
 *  endpoints; the id is optional because the filter needs it and a bare-string answer would not have one. */
export interface StudioRef {
  name: string;
  id?: string;
}

export interface LibraryItem {
  id: string;
  type: string;
  name: string;
  /** The server's non-localised title; outside sources slug off this because `name` is often Chinese. */
  originalTitle?: string;
  seriesName?: string;
  productionYear?: number;
  officialRating?: string;
  communityRating?: number;
  genres?: string[];
  studio?: string;
  /** Every company the server credits, ids included: the 公司 filter is built from these and sent back as StudioIds. */
  studios?: StudioRef[];
  /** ISO string as the server returns it; the UI decides how much of it to show. */
  premiereDate?: string;
  overview?: string;
  runTimeTicks?: number;
  primaryImageTag?: string;
  backdropImageTag?: string;
  /** The film's title treatment (艺术字), stored by the server as its own image type. */
  logoImageTag?: string;
  parentId?: string;
  /** Both halves of an episode's address, kept apart because the fork answers ParentId with the *Season*
   *  id and only gives SeriesId when it is requested in Fields — collapsing them into parentId loses one
   *  of them, and the player needs both to list the rest of the season. */
  seriesId?: string;
  seasonId?: string;
  indexNumber?: number;
  parentIndexNumber?: number;
  childCount?: number;
  /** Newest added episode behind a Series card; the Latest endpoint has no episode position of its own. */
  latestEpisode?: { season?: number; episode: number };
  userData?: { playedPercentage?: number; isFavorite?: boolean };
  /** External ids the server already scraped. Every outside source is keyed off these instead of the
   *  title, which matters because our item names are Chinese and the outside databases are not. */
  providers?: Providers;
  /** Detail endpoint only: the list payload does not carry People. */
  people?: Person[];
  /** Detail endpoint only: the technical description of the file the server can actually serve.
   *  A source is one container with its video/audio/subtitle streams; this library only ever has one
   *  per item, so it feeds the 视频/音频 table, not a source switcher. */
  sources?: PlaybackSource[];
  /** Detail endpoint only: when the item entered the library. */
  dateCreated?: string;
  /** Detail endpoint only: the movie's marketing line. */
  tagline?: string;
}

export interface Providers {
  imdb?: string;
  tmdb?: string;
  tvdb?: string;
}

export interface Person {
  id: string;
  name: string;
  /** Emby uses the same field for the craft role (Director/Writer) and for Actor. */
  type: string;
  /** Character name for an Actor, empty for craft roles. */
  role?: string;
  imageTag?: string;
}

/** Rotten Tomatoes numbers for one title, cached by its IMDb id. */
export interface RtScores {
  tomatometer?: number;
  tomatoCertified?: boolean;
  popcorn?: number;
  /** The title's own RT page, from the slug the Wikidata bridge resolved. Absent only for a cache
   *  written before slugs were kept, where the badge still shows but has nowhere to link. */
  url?: string;
  fetchedAt: number;
}

/** IMDb's own 10-point average, cached by IMDb id. */
export interface ImdbRating {
  rating: number;
  fetchedAt: number;
}

/** Trakt's audience average for a title we address by its IMDb id, cached by `kind:imdbId`. */
export interface TraktScores {
  rating?: number;
  fetchedAt: number;
}

/** Bangumi's 10-point average for a CJK title, cached by the searched name. `name` is the subject that
 *  was matched, which is not always the title we searched for (a series resolves to its first season). */
export interface BangumiScore {
  score: number;
  subjectId: number;
  name: string;
  fetchedAt: number;
}

/** TMDB fields we merge in for one title, cached by `kind:tmdbId`. Every field here fills a hole the
 *  Emby server left empty; none of them replaces data the server already returns. */
export interface TmdbMeta {
  overviewZh?: string;
  voteAverage?: number;
  voteCount?: number;
  /** Names from the Writing department, up to three, only used when the server has no Writer people. */
  writers?: string[];
  /** US certification (`PG-13`, `TV-14`) or the closest first-listed country when there is no US entry. */
  cert?: string;
  /** The language TMDB records the work as having been made in (`ja`, `ko`, `zh`). Always present on
   *  entries written since the logo ranking started using it as its fourth tier; `''` when TMDB has no
   *  record. The Emby server does not carry this field, so this is the only copy we have. */
  originalLanguage: string;
  fetchedAt: number;
}

/** Episode stills for one season; keys are TMDB's episode numbers (1-based), values are image.tmdb.org paths. */
export type TmdbStills = Record<number, string>;

/** One video/audio/subtitle track as the server describes it. Field presence depends on Type, so all
 *  are optional; the table renders whichever the stream carries. */
export interface MediaStreamInfo {
  type: string; // Video | Audio | Subtitle
  codec?: string;
  displayTitle?: string;
  lang?: string;
  title?: string;
  width?: number;
  height?: number;
  bitDepth?: number;
  range?: string; // HDR / HDR10 / SDR / DoVi
  chroma?: string;
  fps?: number;
  bitRate?: number;
  channels?: number;
  sampleRate?: number;
  profile?: string;
  isDefault?: boolean;
  isForced?: boolean;
}

/** One playable version the server holds for an item. This library keeps exactly one per item, but the
 *  shape is a list because the API is, and the panel has to say something when there is only one. */
export interface PlaybackSource {
  /** MediaSources[].Id — the id every progress report has to name. */
  id: string;
  index: number;
  name?: string;
  container?: string;
  bitRate?: number;
  sizeBytes?: number;
  video?: MediaStreamInfo;
  audio: MediaStreamInfo[];
  subtitle: MediaStreamInfo[];
  /** What the last negotiation answered for this source at the current tier. */
  method?: PlayMethod;
}

/** Common Sense Media content advisories, one entry per category. `level` is CSM's 0–5 dot scale. */
export interface CsmCategory {
  key: string;
  label: string;
  level: number;
}
export interface CsmGuide {
  categories: CsmCategory[];
  /** Recommended minimum age from the page's JSON-LD `typicalAgeRange` (e.g. 13 in "13-18"). */
  minAge?: number;
  fetchedAt: number;
}

/** A TMDB similar/recommended title, kept as a read-only strip: we cannot resolve these back into the
 *  library, so they link nowhere and carry only the poster image.tmdb.org can serve. */
export interface TmdbSimilar {
  tmdbId: number;
  title: string;
  posterPath?: string;
  year?: string;
  voteAverage?: number;
}

export interface LibraryRow {
  key: string;
  title: string;
  items: LibraryItem[];
}

export type PlayMethod = 'DirectPlay' | 'DirectStream' | 'Transcode';

/** One rung of the quality ladder. The rungs are ours, the verdict is the server's: a tier only learns
 *  its `method` when it has been negotiated, so an untried rung makes no promise about direct play. */
export interface QualityTier {
  /** Negotiation cap in bits/s; 0 is 原片. */
  bitrate: number;
  label: string;
  method?: PlayMethod;
}

/** What the current file contains, as mpv reports it after the demuxer has opened it. Everything here
 *  can differ from what the server advertised (a subtitle the muxer dropped, a second audio track). */
export interface PlayerTrack {
  /** mpv's track id, which is what sid/aid/vid take. */
  id: number;
  kind: 'video' | 'audio' | 'subtitle';
  /** Position among the tracks of its own kind, which is the index Emby's progress report wants: the
   *  server counts audio and subtitle streams separately, while mpv numbers each kind from 1. */
  ordinal: number;
  title?: string;
  lang?: string;
  codec?: string;
  selected: boolean;
  default: boolean;
  forced?: boolean;
  external?: boolean;
}

export interface PlayerChapter {
  index: number;
  title: string;
  timeMs: number;
}

export type TrackSelection = number | 'auto' | 'no';

export interface PlayerMedia {
  width: number;
  height: number;
  /** The container's frame rate; 0 until the file is loaded (measured: `video-params/fps` does not exist
   *  in this build, so the value comes from the `video-params` object). */
  fps: number;
  /** The decoder mpv settled on, read back rather than assumed: `auto` and a silent fallback both land here. */
  hwdec: string;
  hdr: boolean;
  colorSpace?: string;
  trackCount: number;
  tracks: PlayerTrack[];
  chapters: PlayerChapter[];
  subtitle: TrackSelection;
  audio: TrackSelection;
  video: TrackSelection;
  subtitleDelayMs: number;
  audioDelayMs: number;
  subtitleScale: number;
  subtitlePos: number;
  /** 'no' means fit to the window; a number is a forced display aspect. */
  aspect: TrackSelection;
  panscan: number;
}

export interface PlayerNav {
  itemId: string;
  /** 已有集号时是「第 3 集」，没有时是那一集自己的名字。 */
  label: string;
}

/** The identity of what is playing, plus everything the panels list. Changes only when the file or the
 *  negotiation changes, so it travels on its own channel rather than inside the 4 Hz state. */
export interface PlayerSession {
  itemId: string;
  name: string;
  sourceId: string;
  sources: PlaybackSource[];
  sourceIndex: number;
  tiers: QualityTier[];
  tier: number;
  method: PlayMethod | '';
  /** The server's own label for the file's dynamic range, shown whether or not the hint is on. */
  hdr: boolean;
  next: PlayerNav | null;
  prev: PlayerNav | null;
  /** Both ids the 选集 panel needs to list the rest of the show without asking the player first. */
  seriesId?: string;
  seasonId?: string;
  /** What the danmaku search asks about. An episode called 「第 3 集」 matches nothing, so the series name
   *  travels with it and the layer keys the track to this item. */
  danmaku: DanmakuQuery | null;
}

export interface DanmakuQuery {
  itemId: string;
  title: string;
  seriesName?: string;
  season?: number;
  episode?: number;
}

export interface DanmakuComment {
  timeSec: number;
  text: string;
  color: string;
  mode: 'scroll' | 'top' | 'bottom';
}

/** One candidate track the source offered for an item. */
export interface DanmakuTrackInfo {
  id: string;
  title: string;
  /** Only a source that counts comments can fill this; 0 is rendered as 未知. */
  count?: number;
}

export interface DanmakuTrack {
  id: string;
  title: string;
  comments: DanmakuComment[];
  fetchedAt: number;
}

export type PlayerStatus = 'idle' | 'opening' | 'playing' | 'paused' | 'ended' | 'error';

/** 100% is the file's own level - what the operating system would play - so the slider and the system
 *  volume mixer mean the same number. mpv's software boost above unity is switched off rather than
 *  exposed: the slider runs to this ceiling and the kernel clamps to it, so neither end can disagree
 *  about what 100% means. */
export const VOLUME_MAX = 100;

/** The transport half of the player: what the clock says. */
export interface PlayerState {
  status: PlayerStatus;
  positionMs: number;
  durationMs: number;
  /** Where the demuxer has read to, so the bar can show what a seek would be free. */
  bufferedMs: number;
  /** What the demuxer is pulling off the wire right now, measured over a few seconds of its byte counter.
   *  0 while paused or before the first samples land. Measured on the bundled 0.41 build: the cumulative
   *  counter inside `demuxer-cache-state` is `total-bytes`; `raw-bytes` does not exist there. */
  netBytesPerSec: number;
  paused: boolean;
  volume: number;
  muted: boolean;
  speed: number;
  fullscreen: boolean;
  error?: string;
}

/** One control the overlay can ask for. A closed union so a typo is a type error rather than an
 *  `unknown action` at runtime. */
export type PlayerCommand =
  | { action: 'toggle' }
  | { action: 'seekMs'; value: number }
  | { action: 'skip'; value: number }
  | { action: 'speed'; value: number }
  | { action: 'volume'; value: number }
  | { action: 'mute'; value: boolean }
  | { action: 'track'; value: { kind: 'video' | 'audio' | 'subtitle'; id: TrackSelection } }
  | { action: 'subtitleDelay'; value: number }
  | { action: 'audioDelay'; value: number }
  | { action: 'subtitleStyle'; value: { scale?: number; pos?: number } }
  | { action: 'aspect'; value: TrackSelection }
  | { action: 'panscan'; value: number }
  | { action: 'chapter'; value: number }
  | { action: 'frameStep'; value: number }
  | { action: 'restart' }
  | { action: 'source'; value: number }
  | { action: 'quality'; value: number }
  | { action: 'next' }
  | { action: 'prev' }
  | { action: 'fullscreen'; value: boolean };

export interface IpcResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export const emptyPlayerState = (): PlayerState => ({
  status: 'idle',
  positionMs: 0,
  durationMs: 0,
  bufferedMs: 0,
  netBytesPerSec: 0,
  paused: true,
  volume: 100,
  muted: false,
  speed: 1,
  fullscreen: false,
});

export const emptyPlayerMedia = (): PlayerMedia => ({
  width: 0,
  height: 0,
  fps: 0,
  hwdec: '',
  hdr: false,
  trackCount: 0,
  tracks: [],
  chapters: [],
  subtitle: 'auto',
  audio: 'auto',
  video: 'auto',
  subtitleDelayMs: 0,
  audioDelayMs: 0,
  subtitleScale: 100,
  subtitlePos: 100,
  aspect: 'no',
  panscan: 0,
});
