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
  /** Cap offered to the server during PlaybackInfo negotiation, in bits/s. */
  maxStreamingBitrate: number;
  hwdec: 'd3d11va' | 'cuda' | 'auto' | 'no';
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
  /** ISO string as the server returns it; the UI decides how much of it to show. */
  premiereDate?: string;
  overview?: string;
  runTimeTicks?: number;
  primaryImageTag?: string;
  backdropImageTag?: string;
  parentId?: string;
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
  sources?: MediaSourceInfo[];
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
 *  shape is a list because the API is. */
export interface MediaSourceInfo {
  name?: string;
  container?: string;
  bitRate?: number;
  sizeBytes?: number;
  isHls?: boolean;
  video?: MediaStreamInfo;
  audio: MediaStreamInfo[];
  subtitle: MediaStreamInfo[];
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

export interface PlaybackResult {
  mediaSourceId: string;
  playSessionId: string;
  playMethod: 'DirectPlay' | 'DirectStream' | 'Transcode' | string;
  directUrl: string;
  name?: string;
}

export type PlayerStatus = 'idle' | 'opening' | 'playing' | 'paused' | 'ended' | 'error';

export interface PlayerState {
  status: PlayerStatus;
  positionMs: number;
  durationMs: number;
  bufferedMs: number;
  paused: boolean;
  volume: number;
  muted: boolean;
  title: string;
  playMethod: string;
  direct: boolean;
  videoWidth: number;
  videoHeight: number;
  fullscreen: boolean;
  error?: string;
  fps?: number;
  subtitleIndex?: number;
}

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
  paused: true,
  volume: 100,
  muted: false,
  title: '',
  playMethod: '',
  direct: false,
  videoWidth: 0,
  videoHeight: 0,
  fullscreen: false,
});
