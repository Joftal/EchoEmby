import type { Account, AppConfig, BangumiScore, CsmGuide, DanmakuQuery, DanmakuTrack, DanmakuTrackInfo, FacetOption, ImdbRating, IpcResult, LibraryItem, LibraryRow, MetaKeys, NetProbe, PlayerCommand, PlayerMedia, PlayerSession, PlayerState, RtScores, Settings, SettingsPatch, TmdbMeta, TmdbSimilar, TmdbStills, TraktScores, WatchedRecord } from './types';

export interface EchoEmbyApi {
  app: {
    getConfig(): Promise<IpcResult<AppConfig>>;
    login(input: { baseUrl: string; username: string; password: string }): Promise<IpcResult<Account>>;
    removeAccount(accountId: string): Promise<IpcResult<string | null>>;
    updateAccount(input: { accountId: string; label?: string; baseUrl: string; username: string; password?: string }): Promise<IpcResult<boolean>>;
    pingServer(baseUrl: string): Promise<IpcResult<{ serverName: string; version: string }>>;
    accountCounts(accountId: string): Promise<IpcResult<{ movies: number; series: number }>>;
    switchAccount(accountId: string): Promise<IpcResult<boolean>>;
    setSettings(patch: SettingsPatch): Promise<IpcResult<Settings>>;
  };
  net: {
    /** One round trip to the gateway and one to an address echo, through the route that is live now. */
    probe(): Promise<IpcResult<NetProbe>>;
  };
  emby: {
    views(): Promise<IpcResult<LibraryItem[]>>;
    homeRows(): Promise<IpcResult<LibraryRow[]>>;
    /** Just the 在看 row, for the one moment the lobby has to be re-read: the film that stopped is the
     *  only thing on the page whose row, order or membership can have changed. */
    resumeRow(): Promise<IpcResult<LibraryRow | null>>;
    items(params: Record<string, string | number | boolean>): Promise<IpcResult<LibraryItem[]>>;
    /** The library's own genre labels, used to fill the 分类 dropdown. */
    genres(): Promise<IpcResult<FacetOption[]>>;
    item(id: string): Promise<IpcResult<LibraryItem>>;
    seasons(seriesId: string): Promise<IpcResult<LibraryItem[]>>;
    episodes(params: { seriesId: string; seasonId: string }): Promise<IpcResult<LibraryItem[]>>;
    favorite(params: { id: string; on: boolean }): Promise<IpcResult<boolean>>;
    imageUrl(params: { id: string; tag?: string; width: number; type?: 'primary' | 'backdrop' | 'logo' }): Promise<IpcResult<string>>;
  };
  meta: {
    /** Null is a normal answer: the title simply has no Rotten Tomatoes page we can find. */
    rt(imdb: string): Promise<IpcResult<RtScores | null>>;
    imdb(imdb: string): Promise<IpcResult<ImdbRating | null>>;
    trakt(input: { kind: 'movie' | 'tv'; imdb: string }): Promise<IpcResult<TraktScores | null>>;
    /** Null for a Latin title, which Bangumi's search cannot reach; only CJK names are looked up. */
    bangumi(title: string): Promise<IpcResult<BangumiScore | null>>;
    tmdb(input: { kind: 'movie' | 'tv'; tmdbId: string }): Promise<IpcResult<TmdbMeta | null>>;
    tmdbStills(input: { tmdbId: string; season: number }): Promise<IpcResult<{ value: TmdbStills; any: boolean } | null>>;
    tmdbSimilar(input: { kind: 'movie' | 'tv'; tmdbId: string }): Promise<IpcResult<TmdbSimilar[]>>;
    tmdbImages(input: { kind: 'movie' | 'tv'; tmdbId: string }): Promise<IpcResult<string[]>>;
    /** The title treatments on TMDB's page, ranked 简体中文 → 繁体中文 → 英文 → 影视语言 → 其他. */
    tmdbLogos(input: { kind: 'movie' | 'tv'; tmdbId: string }): Promise<IpcResult<string[]>>;
    csm(input: { kind: 'movie' | 'tv'; title: string }): Promise<IpcResult<CsmGuide | null>>;
    setKeys(patch: Partial<MetaKeys>): Promise<IpcResult<MetaKeys | undefined>>;
  };
  player: {
    play(itemId: string): Promise<IpcResult<boolean>>;
    command(cmd: PlayerCommand): Promise<IpcResult<boolean>>;
    close(): Promise<IpcResult<boolean>>;
    state(): Promise<PlayerState>;
    session(): Promise<IpcResult<PlayerSession | null>>;
    media(): Promise<IpcResult<PlayerMedia>>;
    onState(cb: (s: PlayerState) => void): () => void;
    /** null is the player being closed: the session identity only exists while something is loaded. */
    onSession(cb: (s: PlayerSession | null) => void): () => void;
    onMedia(cb: (m: PlayerMedia) => void): () => void;
    /** Where the file stopped, sent once when playback ends. The lobby needs this and nothing else from
     *  the player, so it is its own channel rather than another reader on the 4 Hz state stream. */
    onWatched(cb: (w: WatchedRecord) => void): () => void;
  };
  danmaku: {
    /** The candidate tracks for one item, from whichever source the settings name. An empty list is a
     *  normal answer, and nothing leaves the machine unless 弹幕 is switched on. Null is the source not
     *  answering at all, which is a different sentence to show the user. */
    search(q: DanmakuQuery): Promise<IpcResult<DanmakuTrackInfo[] | null>>;
    /** One candidate's comments, filtered and sorted; null when the source has nothing for it. */
    track(q: DanmakuQuery, trackId: string): Promise<IpcResult<DanmakuTrack | null>>;
  };
  ui: {
    window(action: 'minimize' | 'maximize' | 'close'): void;
  };
}
