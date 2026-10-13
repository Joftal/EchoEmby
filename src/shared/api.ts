import type { Account, AppConfig, IpcResult, LibraryItem, LibraryRow, MetaKeys, PlayerState, RtScores, Settings, TmdbMeta, TmdbStills } from './types';

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
  emby: {
    views(): Promise<IpcResult<LibraryItem[]>>;
    homeRows(): Promise<IpcResult<LibraryRow[]>>;
    items(params: Record<string, string | number | boolean>): Promise<IpcResult<LibraryItem[]>>;
    item(id: string): Promise<IpcResult<LibraryItem>>;
    seasons(seriesId: string): Promise<IpcResult<LibraryItem[]>>;
    episodes(params: { seriesId: string; seasonId: string }): Promise<IpcResult<LibraryItem[]>>;
    imageUrl(params: { id: string; tag?: string; width: number; type?: 'primary' | 'backdrop' }): Promise<IpcResult<string>>;
  };
  meta: {
    /** Null is a normal answer: the title simply has no Rotten Tomatoes page we can find. */
    rt(imdb: string): Promise<IpcResult<RtScores | null>>;
    tmdb(input: { kind: 'movie' | 'tv'; tmdbId: string }): Promise<IpcResult<TmdbMeta | null>>;
    tmdbStills(input: { tmdbId: string; season: number }): Promise<IpcResult<{ value: TmdbStills; any: boolean } | null>>;
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
