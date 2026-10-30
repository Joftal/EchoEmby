import type { Account, AppConfig, BangumiScore, CalendarResult, CsmGuide, DanmakuAnime, DanmakuDebugReply, DanmakuEpisode, DanmakuLink, DanmakuLookup, DanmakuQuery, DanmakuSource, DanmakuTestResult, DanmakuTrack, FacetOption, ImdbRating, IpcResult, LibraryItem, LibraryRow, MediaCacheStats, MetaKeys, NetProbe, PlayerCommand, PlayerMedia, PlayerSession, PlayerState, PlayerThumb, RtScores, Settings, SettingsPatch, TmdbCredits, TmdbMeta, TmdbRelated, TmdbStills, TraktScores, WatchedRecord } from './types';

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
    /** The block after any write, from whichever window made it. */
    onSettings(cb: (s: Settings) => void): () => void;
  };
  net: {
    /** One round trip to the gateway and one to an address echo, through the route that is live now. */
    probe(): Promise<IpcResult<NetProbe>>;
  };
  emby: {
    views(): Promise<IpcResult<LibraryItem[]>>;
    homeRows(): Promise<IpcResult<LibraryRow[]>>;
    /** Just the 在看 row, for the one moment the lobby has to be re-read: the film that stopped is the
     *  only thing on the page whose row, order or membership can have changed. `limit` is how many cards
     *  to build — the lobby's rail wants 18, the 在看 page wants the whole shelf. */
    resumeRow(limit?: number): Promise<IpcResult<LibraryRow | null>>;
    items(params: Record<string, string | number | boolean>): Promise<IpcResult<LibraryItem[]>>;
    /** The library's own genre labels, used to fill the 分类 dropdown. `scope` is a library id: the
     *  gateway narrows the list to that library's own genres when given one. */
    genres(scope?: string): Promise<IpcResult<FacetOption[]>>;
    /** The library's whole company list, with ids: the only answer that makes 公司 mean the same thing on
     *  a search page as on a library window. `scope` narrows it to one library. */
    studios(scope?: string): Promise<IpcResult<FacetOption[]>>;
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
    tmdbStills(input: { tmdbId: string; season: number }): Promise<IpcResult<TmdbStills | null>>;
    tmdbSeasonCast(input: { tmdbId: string; season: number }): Promise<IpcResult<TmdbCredits | null>>;
    tmdbRelated(input: { kind: 'movie' | 'tv'; tmdbId: string }): Promise<IpcResult<TmdbRelated[]>>;
    tmdbImages(input: { kind: 'movie' | 'tv'; tmdbId: string }): Promise<IpcResult<string[]>>;
    /** The title treatments on TMDB's page, ranked 简体中文 → 繁体中文 → 英文 → 影视语言 → 其他. */
    tmdbLogos(input: { kind: 'movie' | 'tv'; tmdbId: string }): Promise<IpcResult<string[]>>;
    /** The `tmdb.<id>` handles a typed name resolves to, best first — the bridge that lets a Japanese,
     *  Korean or Romanized name reach a work the library filed under its Chinese one. Empty is a normal
     *  answer: the term then searches exactly as it did before. */
    tmdbTitles(query: string): Promise<IpcResult<string[]>>;
    csm(input: { kind: 'movie' | 'tv'; title: string }): Promise<IpcResult<CsmGuide | null>>;
    setKeys(patch: Partial<MetaKeys>): Promise<IpcResult<MetaKeys | undefined>>;
  };
  calendar: {
    /** The days this account's followed shows update, for the window the page is showing. `force` steps
     *  past the cache's TTL — the 刷新 button's whole reason to exist. */
    schedule(input: { from: string; to: string; force?: boolean }): Promise<IpcResult<CalendarResult>>;
  };
  player: {
    /** `fromStart` is the button's promise, not a preference: a hero that says 「播放」 rather than
     *  「继续播放」 must land at 0 even if the server still holds an offset for this item. Which version
     *  plays is not a parameter here — the controller holds the one answer, set by `chooseSource`. */
    play(itemId: string, fromStart?: boolean): Promise<IpcResult<boolean>>;
    /** The version the next 播放 of this item takes, or '' when nobody has chosen. */
    lastSource(itemId: string): Promise<string>;
    /** A pick made on the page's 播放资源 card. It writes the controller's memory so a switch made later
     *  inside the player is not lost to this older click. */
    chooseSource(itemId: string, sourceId: string): Promise<IpcResult<boolean>>;
    command(cmd: PlayerCommand): Promise<IpcResult<boolean>>;
    close(): Promise<IpcResult<boolean>>;
    state(): Promise<PlayerState>;
    session(): Promise<IpcResult<PlayerSession | null>>;
    media(): Promise<IpcResult<PlayerMedia>>;
    /** A preview frame of the file playing, as a JPEG data URL, for one position of the bar. `precise`
     *  asks for the frame *of that second* - the grid's cells are 5 to 35 s apart, so a cell alone answers
     *  with a picture of somewhere near the pointer; a pointer that has stopped asks precisely, a pointer
     *  passing over the bar takes the grid. `exact: false` means the picture is a neighbour's while the
     *  asked-for one is being decoded, and the renderer keeps polling until it is exact or final. */
    thumb(timeMs: number, precise?: boolean): Promise<IpcResult<PlayerThumb>>;
    onState(cb: (s: PlayerState) => void): () => void;
    /** null is the player being closed: the session identity only exists while something is loaded. */
    onSession(cb: (s: PlayerSession | null) => void): () => void;
    onMedia(cb: (m: PlayerMedia) => void): () => void;
    /** Where the file stopped, sent once when playback ends. The lobby needs this and nothing else from
     *  the player, so it is its own channel rather than another reader on the 4 Hz state stream. */
    onWatched(cb: (w: WatchedRecord) => void): () => void;
  };
  danmaku: {
    /** Every candidate for one item, plus the link this show already has and the row that should start
     *  playing. Nothing leaves the machine unless 弹幕 is switched on. Null is the service not answering at
     *  all, which is a different sentence to show than 「这条没有弹幕」. */
    lookup(q: DanmakuQuery): Promise<IpcResult<DanmakuLookup | null>>;
    /** One candidate's comments, filtered, shifted and sorted; null when the service has nothing for it. */
    track(q: DanmakuQuery, trackId: string, shift: number): Promise<IpcResult<DanmakuTrack | null>>;
    /** 手动链接: point this show at one work, or pass null to forget it and fall back to the guesses. */
    link(q: DanmakuQuery, link: DanmakuLink | null): Promise<IpcResult<DanmakuLink | null>>;
    /** The works a keyword finds, for the 手动链接 search box. */
    search(word: string): Promise<IpcResult<DanmakuAnime[] | null>>;
    /** The episodes of one work, so a link can name the exact row. */
    episodes(animeTitle: string, animeId: string): Promise<IpcResult<DanmakuEpisode[] | null>>;
    /** One episode row by number, for works whose list comes back cut short. */
    episodeAt(animeTitle: string, animeId: string, episode: number): Promise<IpcResult<DanmakuEpisode | null>>;
  /** How many comments one search hit holds for the episode being played; resolved by number, because a work's
   *  own episode list is cut short. `count: null` means the mirror did not answer with a number. */
  countFor(animeTitle: string, animeId: string, episode: number): Promise<IpcResult<{ episodeId: string; count: number | null } | null>>;
  countOne(id: string, api?: string): Promise<IpcResult<number | null>>;
    /** 设置 → 弹幕 → 测试: probe one endpoint without touching the cache or the order it sits in. */
    test(source: DanmakuSource, keyword: string): Promise<IpcResult<DanmakuTestResult>>;
    /** 弹幕调试 › 接口调试: one verbatim request, answered from the network and never from the cache. */
    debug(a: { base: string; path: string; method?: 'GET' | 'POST'; body?: unknown }): Promise<IpcResult<DanmakuDebugReply>>;
  };
  /** 媒体缓存: the numbers are what is on disk right now, cleared down to nothing by `clear`. */
  mediaCache: {
    stats(): Promise<IpcResult<MediaCacheStats>>;
    clear(): Promise<IpcResult<MediaCacheStats>>;
  };
  ui: {
    window(action: 'minimize' | 'maximize' | 'close'): void;
  };
}