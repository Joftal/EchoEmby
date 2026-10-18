import { contextBridge, ipcRenderer } from 'electron';
import type { EchoEmbyApi } from '../shared/api';

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>;

/** Each main→renderer channel has one listener per subscription, and the unsubscribe has to name the
 *  same function object Electron registered. */
const on = <T>(channel: string, cb: (payload: T) => void): (() => void) => {
  const handler = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

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
  net: {
    probe: () => invoke('net:probe'),
  },
  emby: {
    views: () => invoke('emby:views'),
    homeRows: () => invoke('emby:homeRows'),
    resumeRow: () => invoke('emby:resumeRow'),
    items: params => invoke('emby:items', params),
    genres: () => invoke('emby:genres'),
    item: id => invoke('emby:item', id),
    seasons: seriesId => invoke('emby:seasons', seriesId),
    episodes: params => invoke('emby:episodes', params),
    favorite: params => invoke('emby:favorite', params),
    imageUrl: params => invoke('emby:imageUrl', params),
  },
  meta: {
    rt: imdb => invoke('meta:rt', imdb),
    imdb: imdb => invoke('meta:imdb', imdb),
    trakt: input => invoke('meta:trakt', input),
    bangumi: title => invoke('meta:bangumi', title),
    tmdb: input => invoke('meta:tmdb', input),
    tmdbStills: input => invoke('meta:tmdbStills', input),
    tmdbSeasonCast: input => invoke('meta:tmdbSeasonCast', input),
    tmdbSimilar: input => invoke('meta:tmdbSimilar', input),
    tmdbImages: input => invoke('meta:tmdbImages', input),
    tmdbLogos: input => invoke('meta:tmdbLogos', input),
    csm: input => invoke('meta:csm', input),
    setKeys: patch => invoke('meta:setKeys', patch),
  },
  player: {
    play: (itemId, fromStart) => invoke('player:play', itemId, fromStart),
    command: cmd => invoke('player:command', cmd),
    close: () => invoke('player:close'),
    state: () => invoke('player:state'),
    session: () => invoke('player:session'),
    media: () => invoke('player:media'),
    onState: cb => on('player:state', cb),
    onSession: cb => on('player:session', cb),
    onMedia: cb => on('player:media', cb),
    onWatched: cb => on('player:watched', cb),
  },
  danmaku: {
    search: q => invoke('danmaku:search', q),
    track: (q, trackId) => invoke('danmaku:track', { q, trackId }),
  },
  ui: {
    window: action => ipcRenderer.send('ui:window', { action }),
  },
};

contextBridge.exposeInMainWorld('echoemby', api);
