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
  userData?: { playedPercentage?: number };
  /** External ids the server already scraped. Every outside source is keyed off these instead of the
   *  title, which matters because our item names are Chinese and the outside databases are not. */
  providers?: Providers;
  /** Detail endpoint only: the list payload does not carry People. */
  people?: Person[];
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
  whereToWatch?: string[];
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
