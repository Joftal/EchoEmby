import type { Account, AppConfig, IpcResult, LibraryItem, LibraryRow, PlayerState } from './types';

export interface EchoEmbyApi {
  app: {
    getConfig(): Promise<IpcResult<AppConfig>>;
    login(input: { baseUrl: string; username: string; password: string }): Promise<IpcResult<Account>>;
    removeAccount(accountId: string): Promise<IpcResult<string | null>>;
    updateAccount(input: { accountId: string; label?: string; baseUrl: string; username: string; password?: string }): Promise<IpcResult<boolean>>;
    pingServer(baseUrl: string): Promise<IpcResult<{ serverName: string; version: string }>>;
    accountCounts(accountId: string): Promise<IpcResult<{ movies: number; series: number }>>;
    switchAccount(accountId: string): Promise<IpcResult<boolean>>;
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
