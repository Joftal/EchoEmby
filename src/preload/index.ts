import { contextBridge, ipcRenderer } from 'electron';
import type { EchoEmbyApi } from '../shared/api';

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api: EchoEmbyApi = {
  app: {
    getConfig: () => invoke('app:getConfig'),
    login: input => invoke('app:login', input),
    removeAccount: accountId => invoke('app:removeAccount', accountId),
    updateAccount: input => invoke('app:updateAccount', input),
    pingServer: baseUrl => invoke('app:pingServer', baseUrl),
    accountCounts: accountId => invoke('app:accountCounts', accountId),
    switchAccount: accountId => invoke('app:switchAccount', accountId),
    setSettings: patch => invoke('app:setSettings', patch),
  },
  emby: {
    views: () => invoke('emby:views'),
    homeRows: () => invoke('emby:homeRows'),
    items: params => invoke('emby:items', params),
    item: id => invoke('emby:item', id),
    seasons: seriesId => invoke('emby:seasons', seriesId),
    episodes: params => invoke('emby:episodes', params),
    favorite: params => invoke('emby:favorite', params),
    imageUrl: params => invoke('emby:imageUrl', params),
  },
  meta: {
    rt: imdb => invoke('meta:rt', imdb),
    tmdb: input => invoke('meta:tmdb', input),
    tmdbStills: input => invoke('meta:tmdbStills', input),
    tmdbSimilar: input => invoke('meta:tmdbSimilar', input),
    tmdbImages: input => invoke('meta:tmdbImages', input),
    csm: input => invoke('meta:csm', input),
    setKeys: patch => invoke('meta:setKeys', patch),
  },
  player: {
    play: itemId => invoke('player:play', itemId),
    command: cmd => invoke('player:command', cmd),
    fullscreen: on => invoke('player:fullscreen', on),
    close: () => invoke('player:close'),
    state: () => invoke('player:state'),
    onState: cb => {
      const handler = (_e: unknown, s: any) => cb(s);
      ipcRenderer.on('player:state', handler);
      return () => ipcRenderer.removeListener('player:state', handler);
    },
  },
  ui: {
    window: action => ipcRenderer.send('ui:window', { action }),
  },
};

contextBridge.exposeInMainWorld('echoemby', api);
