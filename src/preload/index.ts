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
    onSettings: cb => on('app:settings', cb),
  },
  net: {
    probe: () => invoke('net:probe'),
  },
  emby: {
    views: () => invoke('emby:views'),
    homeRows: () => invoke('emby:homeRows'),
    resumeRow: limit => invoke('emby:resumeRow', limit),
    items: params => invoke('emby:items', params),
    genres: (scope?: string) => invoke('emby:genres', scope),
    studios: (scope?: string) => invoke('emby:studios', scope),
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
    tmdbRelated: input => invoke('meta:tmdbRelated', input),
    tmdbImages: input => invoke('meta:tmdbImages', input),
    tmdbLogos: input => invoke('meta:tmdbLogos', input),
    tmdbTitles: query => invoke('meta:tmdbTitles', query),
    csm: input => invoke('meta:csm', input),
    setKeys: patch => invoke('meta:setKeys', patch),
  },
  calendar: {
    schedule: input => invoke('calendar:schedule', input),
  },
  player: {
    play: (itemId, fromStart) => invoke('player:play', itemId, fromStart),
    lastSource: itemId => invoke('player:lastSource', itemId),
    chooseSource: (itemId, sourceId) => invoke('player:chooseSource', itemId, sourceId),
    command: cmd => invoke('player:command', cmd),
    close: () => invoke('player:close'),
    state: () => invoke('player:state'),
    session: () => invoke('player:session'),
    media: () => invoke('player:media'),
    thumb: (timeMs, precise) => invoke('player:thumb', timeMs, precise),
    pickSubtitle: () => invoke('player:pickSubtitle'),
    onState: cb => on('player:state', cb),
    onSession: cb => on('player:session', cb),
    onMedia: cb => on('player:media', cb),
    onWatched: cb => on('player:watched', cb),
  },
  danmaku: {
    lookup: q => invoke('danmaku:lookup', q),
    track: (q, trackId, shift) => invoke('danmaku:track', { q, trackId, shift }),
    link: (q, link) => invoke('danmaku:link', { q, link }),
    search: word => invoke('danmaku:search', word),
    episodes: (animeTitle, animeId) => invoke('danmaku:episodes', { animeTitle, animeId }),
    episodeAt: (animeTitle, animeId, episode) => invoke('danmaku:episodeAt', { animeTitle, animeId, episode }),
    countFor: (animeTitle, animeId, episode) => invoke('danmaku:countFor', { animeTitle, animeId, episode }),
    countOne: (id: string, api?: string) => invoke('danmaku:countOne', { id, api }),
    test: (source, keyword) => invoke('danmaku:test', { source, keyword }),
    debug: a => invoke('danmaku:debug', a),
  },
  mediaCache: {
    stats: () => invoke('mediaCache:stats'),
    clear: () => invoke('mediaCache:clear'),
  },
  cache: {
    usage: () => invoke('cache:usage'),
    clear: id => invoke('cache:clear', id),
    setRoot: root => invoke('cache:root', root),
    pick: () => invoke('cache:pick'),
    open: () => invoke('cache:open'),
    refresh: () => invoke('cache:refresh'),
    onStale: cb => on('cache:stale', cb),
  },
  ui: {
    window: action => ipcRenderer.send('ui:window', { action }),
  },
};

contextBridge.exposeInMainWorld('echoemby', api);
