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
