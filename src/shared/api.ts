import type { Account, AppConfig, BangumiScore, CsmGuide, FacetOption, ImdbRating, IpcResult, LibraryItem, LibraryRow, MetaKeys, NetProbe, PlayerState, RtScores, Settings, TmdbMeta, TmdbSimilar, TmdbStills, TraktScores } from './types';

export interface EchoEmbyApi {
  app: {
    getConfig(): Promise<IpcResult<AppConfig>>;
    login(input: { baseUrl: string; username: string; password: string }): Promise<IpcResult<Account>>;
    removeAccount(accountId: string): Promise<IpcResult<string | null>>;
    updateAccount(input: { accountId: string; label?: string; baseUrl: string; username: string; password?: string }): Promise<IpcResult<boolean>>;
    pingServer(baseUrl: string): Promise<IpcResult<{ serverName: string; version: string }>>;
    accountCounts(accountId: string): Promise<IpcResult<{ movies: number; series: number }>>;
    switchAccount(accountId: string): Promise<IpcResult<boolean>>;
    setSettings(patch: Partial<Settings>): Promise<IpcResult<Settings>>;
  };
  net: {
    /** One round trip to the gateway and one to an address echo, through the route that is live now. */
    probe(): Promise<IpcResult<NetProbe>>;
  };
  emby: {
    views(): Promise<IpcResult<LibraryItem[]>>;
    homeRows(): Promise<IpcResult<LibraryRow[]>>;
    items(params: Record<string, string | number | boolean>): Promise<IpcResult<LibraryItem[]>>;
    /** The library's own genre labels, used to fill the 分类 dropdown. */
    genres(): Promise<IpcResult<FacetOption[]>>;
    item(id: string): Promise<IpcResult<LibraryItem>>;
    seasons(seriesId: string): Promise<IpcResult<LibraryItem[]>>;
    episodes(params: { seriesId: string; seasonId: string }): Promise<IpcResult<LibraryItem[]>>;
    favorite(params: { id: string; on: boolean }): Promise<IpcResult<boolean>>;
    imageUrl(params: { id: string; tag?: string; width: number; type?: 'primary' | 'backdrop' }): Promise<IpcResult<string>>;
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
    csm(input: { kind: 'movie' | 'tv'; title: string }): Promise<IpcResult<CsmGuide | null>>;
    setKeys(patch: Partial<MetaKeys>): Promise<IpcResult<MetaKeys | undefined>>;
  };
  player: {
    play(itemId: string): Promise<IpcResult<boolean>>;
    command(cmd: { action: string; value?: any }): Promise<IpcResult<boolean>>;
    fullscreen(on: boolean): Promise<IpcResult<boolean>>;
    close(): Promise<IpcResult<boolean>>;
    state(): Promise<PlayerState>;
    onState(cb: (s: PlayerState) => void): () => void;
  };
  ui: {
    window(action: 'minimize' | 'maximize' | 'close'): void;
  };
}
