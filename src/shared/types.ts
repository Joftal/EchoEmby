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

/** What the window's own close button does. 退出程序 ends the whole process, player included; 最小化到任务栏
 *  leaves the app running with nothing on screen but its taskbar button, which is how a machine that is
 *  also the media box keeps a film one click away. Read when the button is pressed, not at launch. */
export interface WindowPrefs {
  /** 退出程序 or 隐藏至菜单栏 — what the × does. `tray` keeps the app and the player alive behind the tray icon. */
  closeAction: 'quit' | 'tray';
}

export interface Settings {
  player: PlayerPrefs;
  window: WindowPrefs;
  /** Which route the whole app takes to reach the server. Every request this client makes - API,
   *  images, the playback bridge, the outside metadata services - goes through Chromium's net.fetch,
   *  so one session proxy setting covers all of them. */
  proxyMode: 'system' | 'manual' | 'none';
  /** The 手动代理 address: `127.0.0.1:7897`, `http://host:port`, `socks5://host:port`, optionally with
   *  `user:pass@` in front of the host. */
  proxyUrl: string;
  danmaku: DanmakuSettings;
}

/** A settings write may name only the rows the user touched, so every nested block is partial too; the
 *  main process rebuilds each block from its own defaults before it lands in the file. */
export type SettingsPatch = Omit<Partial<Settings>, 'player' | 'danmaku' | 'window'> & {
  player?: Partial<PlayerPrefs>;
  window?: Partial<WindowPrefs>;
  danmaku?: Omit<Partial<DanmakuSettings>, 'source'> & { source?: Partial<DanmakuSourceConfig> };
};

/** Knobs that belong to the player itself. `hwdec` is read when mpv is launched and again at runtime, so
 *  it needs no restart. There is no bitrate cap here on purpose: the app plays the version it is pointed
 *  at and never asks the server to re-encode it, so quality is decided by which file is picked, not by a
 *  number offered to the gateway. */
export interface PlayerPrefs {
  hwdec: 'd3d11va' | 'cuda' | 'auto' | 'no';
  /** ← / →, and the two skip buttons either side of the play button. */
  seekStepMs: number;
  /** Hand the HDR signal to the display instead of letting mpv tone-map it to SDR. Off by default: a
   *  screen that cannot show it renders the picture washed out. */
  hdrHint: boolean;
  /** Move to the next episode when the file reaches its end. */
  autoNext: boolean;
}

export interface DanmakuSourceConfig {
  /** 'bilibili' needs no key but only knows titles that aired there; 'dandan' is any
   *  dandanplay-compatible service, self-hosted or not, and carries its own address and token. */
  type: 'bilibili' | 'dandan';
  url: string;
  token: string;
}

export interface DanmakuSettings {
  /** Off by default: with this off the app never asks a danmaku service about what you watch. */
  enabled: boolean;
  source: DanmakuSourceConfig;
  /** 0 asks the source with whatever the library calls the show, 1 only accepts an exact title. */
  matchMode: 0 | 1;
  /** Fraction of the picture height the scrolling lanes may use. */
  displayArea: number;
  opacity: number;
  fontScale: number;
  /** How long one comment takes to cross. */
  durationMs: number;
  /** The wall: a dense timeline past this count drops comments rather than frames. */
  maxOnScreen: number;
  /** Commas or newlines. Filtered on the way in, so the cached track is already clean. */
  blockedWords: string;
}

/** What the 连接测试 row answers with: one round trip to the gateway and one to an address echo, both
 *  through whatever route is set right now. */
export interface NetProbe {
  serverMs: number | null;
  egressIp: string;
  egressRegion: string;
  /** Already in Chinese, and only about the leg that failed; empty when both answered. */
  error: string;
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

/** One choice in a filter dropdown. Genres filter by name and Studios by id, so a facet row carries both. */
export interface FacetOption {
  name: string;
  id?: string;
}

/** A production company as the server names it. Both servers answer `{Name,Id}` rows on the list
 *  endpoints; the id is optional because the filter needs it and a bare-string answer would not have one. */
export interface StudioRef {
  name: string;
  id?: string;
}

export interface LibraryItem {
  id: string;
  type: string;
  /** Only a library folder carries one: `movies`, `tvshows`, `boxsets`. The lobby reads it to skip the
   *  newest-episode pass over a folder that cannot hold an episode. */
  collectionType?: string;
  name: string;
  /** The server's non-localised title; outside sources slug off this because `name` is often Chinese. */
  originalTitle?: string;
  seriesName?: string;
  productionYear?: number;
  officialRating?: string;
  communityRating?: number;
  genres?: string[];
  studio?: string;
  /** Every company the server credits, ids included: the 公司 filter is built from these and sent back as StudioIds. */
  studios?: StudioRef[];
  /** ISO string as the server returns it; the UI decides how much of it to show. */
  premiereDate?: string;
  overview?: string;
  runTimeTicks?: number;
  primaryImageTag?: string;
  backdropImageTag?: string;
  /** The film's title treatment (艺术字), stored by the server as its own image type. */
  logoImageTag?: string;
  parentId?: string;
  /** Both halves of an episode's address, kept apart because the fork answers ParentId with the *Season*
   *  id and only gives SeriesId when it is requested in Fields — collapsing them into parentId loses one
   *  of them, and the player needs both to list the rest of the season. */
  seriesId?: string;
  seasonId?: string;
  indexNumber?: number;
  parentIndexNumber?: number;
  childCount?: number;
  /** Newest added episode behind a Series card; the Latest endpoint has no episode position of its own. */
  latestEpisode?: { season?: number; episode: number };
  /** `positionMs` is where this item stopped: the gateway's own 「播到这里」 number, and the only one that
   *  covers every resumable row (measured: 326185 answers PlaybackPositionTicks 8306670000 = 13分50秒).
   *  `playedPercentage` is sparser — 2 of the 8 rows the resume query returns.
   *  `played` is the server's 「this one is done」 flag, and a 在看 row needs it: asked for the same 60
   *  rows both gateways answer, 33 of bangumi's and 8 of okemby's are already finished. */
  userData?: { playedPercentage?: number; isFavorite?: boolean; positionMs?: number; played?: boolean };
  /** External ids the server already scraped. Every outside source is keyed off these instead of the
   *  title, which matters because our item names are Chinese and the outside databases are not. */
  providers?: Providers;
  /** Detail endpoint only: the list payload does not carry People. */
  people?: Person[];
  /** Detail endpoint only: the technical description of the file the server can actually serve.
   *  A source is one container with its video/audio/subtitle streams, and an item can hold several —
   *  measured 6 of 444 files here carry a 2160p and a 1080p version of the same title. The 播放资源
   *  sheet expands the first and lists the rest. */
  sources?: PlaybackSource[];
  /** Detail endpoint only: when the item entered the library. */
  dateCreated?: string;
  /** Detail endpoint only: the movie's marketing line. */
  tagline?: string;
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
  /** The title's own RT page, from the slug the Wikidata bridge resolved. Absent only for a cache
   *  written before slugs were kept, where the badge still shows but has nowhere to link. */
  url?: string;
  fetchedAt: number;
}

/** IMDb's own 10-point average, cached by IMDb id. */
export interface ImdbRating {
  rating: number;
  fetchedAt: number;
}

/** Trakt's audience average for a title we address by its IMDb id, cached by `kind:imdbId`. */
export interface TraktScores {
  rating?: number;
  fetchedAt: number;
}

/** Bangumi's 10-point average for a CJK title, cached by the searched name. `name` is the subject that
 *  was matched, which is not always the title we searched for (a series resolves to its first season). */
export interface BangumiScore {
  score: number;
  subjectId: number;
  name: string;
  /** Set when the record Bangumi answered with is one season rather than the work — the C-drama and
   *  western-drama half of the site is filed per season (庆余年 → 《庆余年 第一季》), so a number taken from
   *  such a record describes 第一季 and not the show. Absent means the work's own subject. */
  season?: number;
  fetchedAt: number;
}

/** One row of the per-season table TMDB returns inside the work-level detail — measured over the 73
 *  seasons of 43 titles on this library, `air_date` and `poster_path` were present for every season of
 *  every one of them, so a season's date and art cost no request of their own. `overview` is where it
 *  splits: present with Chinese for the Asian titles, empty for 9号秘事 / 19号消防局 / 56天 / 800 Meters,
 *  which is why the server's own season synopsis stays in the ladder. */
export interface TmdbSeasonRow {
  /** TMDB's `season_number`, the number we have to line the server's `IndexNumber` up against. */
  n: number;
  epCount: number;
  /** `YYYY-MM-DD`, empty when TMDB has not dated the season. */
  airDate: string;
  /** image.tmdb.org path, empty when there is no season poster. */
  poster: string;
  /** TMDB's number for this season alone, written only when somebody has rated it (measured: 爱的迫降 S1
   *  8.8 and 背着善宰跑 8.3, while both shows' 特别篇 answer 0). It rides the work-level request the page
   *  already makes, so a season's rating costs nothing to know. */
  voteAverage?: number;
  name?: string;
  ovZh?: string;
  ovOther?: string;
}

/** TMDB fields we merge in for one title, cached by `kind:tmdbId`. Every field here fills a hole the
 *  Emby server left empty; none of them replaces data the server already returns. */
export interface TmdbMeta {
  /** Which build of this shape wrote the entry, checked against `META_SCHEMA` in the main process on every
   *  read. Always written; an entry without it predates the marker and is refetched once. */
  schema: number;
  /** The work's own title as TMDB bills it in the locale asked for. Held because a title this server does
   *  not have has no row to read a name off, and the page it can still be shown on is built out of this
   *  entry alone. */
  name: string;
  /** The year it premiered, 0 when TMDB has not dated the work. */
  year: number;
  /** image.tmdb.org poster path; '' when TMDB holds no poster for the work. */
  poster: string;
  /** TMDB's genre names, already localised by the same ask, so a work outside the library still has 分类. */
  genres: string[];
  /** A movie's length in minutes. 0 for a show, whose length belongs to its seasons rather than to it. */
  runtime: number;
  /** TMDB's synopsis when it came back in Chinese (either script). Asked first, above the server's. */
  overviewZh?: string;
  /** The same field when it came back in anything else — on a `language=zh-CN` ask that means English
   *  or the work's own language, which is what TMDB serves when it has no Chinese record. Kept because
   *  the server has no synopsis at all for some titles, and one line in a foreign language still beats
   *  「暂无简介」。 */
  overviewOther?: string;
  voteAverage?: number;
  /** Names from the Writing department, up to three, only used when the server has no Writer people. */
  writers?: string[];
  /** The age board TMDB filed for this work, already shaped for a badge: `TV-MA` and the MPAA letters as
   *  they came, any other country's age as 「16+」, and `''` for the codes that carry no number at all —
   *  those leave the surface to the server's own `OfficialRating`. The raw string stays on disk so the
   *  shaping can be retuned without a refetch. */
  cert?: string;
  /** TMDB's whole season table, in season order. Empty for a movie. */
  seasons: TmdbSeasonRow[];
  /** A movie's own credits, read off the same request. A series keeps its band season by season, so its
   *  three lists come back empty and the writers it may still need ride `writers` above. */
  cast: TmdbCredits;
  /** The language TMDB records the work as having been made in (`ja`, `ko`, `zh`). The Emby server does
   *  not carry this field, so this is the only copy we have; `''` when TMDB has no record. It is the
   *  fourth tier of the logo ranking. */
  originalLanguage: string;
  fetchedAt: number;
}

/** One episode as TMDB billed it: its still, its own title and the paragraph written for that
 *  episode alone. All three arrive inside the season reply the pictures were asked for, so keeping
 *  the text costs bytes and no round trip — measured in UTF-8 over the 210 rows this library has
 *  refetched: 479 bytes a synopsis, 24 a title, 33 the picture path it was always paying. */
export interface TmdbEpisodeRow {
  /** image.tmdb.org path, empty when TMDB has no still for this episode. */
  p: string;
  /** The episode's synopsis when TMDB has it in Chinese, either script. Asked first, above the server's. */
  ovZh?: string;
  /** The same line when it came back in anything else, kept for the last rung of the ladder. */
  ovOther?: string;
  /** The episode's own title when TMDB answered it in Chinese, either script. Asked above the server's, on
   *  the same ladder as the synopsis below. */
  nZh?: string;
  /** The same title in whatever language TMDB actually files it in — the work's own for most of this
   *  library's non-Asian titles — kept for the last rung of the ladder. */
  nOther?: string;
  /** The date TMDB bills this episode for, `YYYY-MM-DD`, empty when it bills none. Held because it is the
   *  one field that can tell this episode from the episode another season also numbers 2: the season-level
   *  pairing refuses a show whose counts disagree (a still-airing 新番 with 3 files against TMDB's 13), and
   *  two dates for the same episode number is the stronger claim either way. */
  air?: string;
  /** Minutes TMDB bills for this episode, absent when it bills none. Kept because the server's own row is
   *  frequently the emptier of the two: measured over 204 episode rows from 12 seasons, TMDB answers a
   *  runtime for 76% of them (median 25), which is what lets a card whose file the server has not got
   *  still say how long it runs. */
  rt?: number;
}

/** The season's episodes, keyed by TMDB's episode numbers (1-based). An episode with neither art nor text
 *  gets no row at all. */
export type TmdbStills = Record<number, TmdbEpisodeRow>;

/** Which pool chip a 追剧日历 row answers to. Decided from TMDB's own `original_language` plus whether it
 *  files the work under 动画, because the server's library names are per-account and its `Genres` are a
 *  mixed-language soup (measured: the gateway lists 23 中文 / 25 English / 2 Japanese spellings).
 *  `kr` joined the list because 其他 was holding nothing but Korean shows (measured 2026-10-26: 3 of the 22
 *  followed titles — 鱿鱼游戏 / 模范出租车 / 首尔破笑组 — and no other language at all), which left the last
 *  chip naming a bucket by what it is not.
 *  `jplive` joined the same way one round later: 番 means animation here, and the `ja` seat was taking in
 *  相棒 (a 21-season live-action procedural) and 月曜夜未央 (TMDB's own `type` is Talk Show) under it —
 *  measured 2026-10-26 over the 26 followed titles, 2 of the 14 `ja` shows carry no 动画 genre.
 *  The `en` seat still speaks language, not country: all 5 of those titles answer `origin_country: ["US"]`
 *  today, so an 英剧 would land here wrongly and nothing on this account does it yet. */
export type CalendarPool = 'cn' | 'cnova' | 'jp' | 'jplive' | 'kr' | 'en' | 'other';

/** One episode the calendar has a date for. The date is TMDB's, the clock is Bilibili's when it names one,
 *  and the absence of a clock is the honest answer for a show no source times — see `CalendarResult`. */
export interface CalendarSlot {
  /** `YYYY-MM-DD`, the day TMDB bills this episode for. */
  date: string;
  /** `HH:MM`, the local air time, only when Bilibili's week schedule names this title on this day. */
  clock?: string;
  /** Bilibili's own 「延期」 sentence for that slot, verbatim, when it has one. */
  delay?: string;
  tmdbId: string;
  /** This server's Series row, so the card can open 详情页. Absent only if the row vanished mid-read. */
  seriesId?: string;
  name: string;
  /** image.tmdb.org poster path — the work's own, the same file 收藏 and 首页 ask for — `''` when TMDB
   *  has none. */
  poster: string;
  pool: CalendarPool;
  season: number;
  episode: number;
  episodeName?: string;
  /** Year the show first aired, TMDB's `first_air_date` cut to four digits; 0 when it never aired. */
  year: number;
  /** TMDB's genre names for the work, already in 中文. Empty when TMDB filed none. */
  genres: string[];
  /** How many episodes this season holds, so 「集 4/12」 can be drawn as a bar. 0 when neither the work
   *  reply nor the season reply counted it, which the card reads as 「no denominator」 rather than 「/0」. */
  seasonTotal: number;
}

/** A title the roster counts as 在追 that has no episode dated inside the window the page asked for. Three
 *  shapes land here and the page tells them apart: TMDB itself says the show is finished (`ended`), it dated
 *  episodes and every one of those days is behind the page (`lastDate`), or it has never dated one at all
 *  (neither). The first two used to read as the third, because `lastDate` was taken off a slot list the
 *  cache had already clipped to its own band. */
export interface CalendarQuiet {
  tmdbId: string;
  /** This server's Series row, so the row opens 详情页 like a card does. */
  seriesId?: string;
  name: string;
  pool: CalendarPool;
  season: number;
  /** The latest day TMDB has dated for this show, clipped by nothing; `''` when it has dated none at all. */
  lastDate: string;
  /** TMDB's own `status` is `Ended` — the wait is over, not pending. */
  ended: boolean;
}

export interface CalendarResult {
  /** Every slot inside the asked window, in date order. */
  slots: CalendarSlot[];
  /** Names whose TMDB request did not answer — silence, not 「no such title」, so they retry next open. */
  failed: string[];
  /** The followed shows none of the above carries a day for. Without them a reader cannot tell 「nothing is
   *  coming」 from 「this page lost my shows」, which is the difference between a quiet week and a bug. */
  quiet: CalendarQuiet[];
  /** No TMDB key is saved, so no date could be asked for at all. The one case where an empty calendar is
   *  not a data answer but a missing credential, and the page says so instead of listing nobody. */
  noKey?: boolean;
}

/** One head in a season's credit list: the name as TMDB localises it, the character it played or
 *  the role label the band prints, and its `profile_path`. */
export interface TmdbCreditRow {
  name: string;
  sub: string;
  /** image.tmdb.org path, empty when the person has no avatar. */
  img: string;
}

/** The three lists the 演职员 band draws, for one season or for one movie. Kept as lists rather than off TMDB's raw department array, because the
 *  `crew` is not a cast list: measured over 8 seasons, 鬼灭之刃's S1 carries 51 crew rows of which 25
 *  are Visual Effects while its `cast` holds one person. Only the departments the band has a label
 *  for survive the trip. */
export interface TmdbCredits {
  dir: TmdbCreditRow[];
  write: TmdbCreditRow[];
  act: TmdbCreditRow[];
}

/** One video/audio/subtitle track as the server describes it. Field presence depends on Type, so all
 *  are optional; the table renders whichever the stream carries. */
export interface MediaStreamInfo {
  /** The server's own number for this stream inside the file. It counts every stream of every kind with
   *  one running number — measured 2026-10-26, `DefaultAudioStreamIndex` on 22,002 of 22,002 sources is
   *  one of these, never a position within the audio rows — so it is the only address a session event may
   *  send back. Absent on the handful of servers that omit `Index`. */
  index?: number;
  type: string; // Video | Audio | Subtitle
  codec?: string;
  displayTitle?: string;
  lang?: string;
  title?: string;
  width?: number;
  height?: number;
  bitDepth?: number;
  range?: string; // HDR / HDR10 / SDR / DoVi
  /** Fields of interlaced frames, which the height alone cannot say: 1080i and 1080p are the same number of
   *  lines. Measured 2026-10-27 on 58 of 23,027 sources, and it agrees with the 「1080i」 the server spells
   *  into `DisplayTitle` on all 58 — the one fact in that string no other field carries. */
  isInterlaced?: boolean;
  fps?: number;
  bitRate?: number;
  channels?: number;
  channelLayout?: string; // stereo / 5.1 / 5.1(side) — the count alone cannot say which
  sampleRate?: number;
  profile?: string;
  isDefault?: boolean;
  isForced?: boolean;
  /** True when the track is a sidecar the server found next to the file rather than a stream inside it. */
  isExternal?: boolean;
  /** Whether the subtitle is written text rather than a picture. Measured 2026-10-27 on the 784 external
   *  subtitle rows in both gateways' corpora: 781 are true (srt 397, ass 376, ssa 8) and 3 are false (sup).
   *  Only the text ones can be handed to mpv as a file — a bare .sup is a bitmap stream mpv decodes inside a
   *  container and nothing else — so this is the line between a selectable row and one that would fail. */
  isTextSubtitle?: boolean;
  /** The server's own word for a subtitle written for viewers who cannot hear the track. Measured
   *  2026-10-27 over 212,468 streams on both gateways: the key is on every one of them, 1,817 subtitle
   *  rows are true, and 440 of those 1,817 carry no SDH/CC/听障 word in their own `Title` — the word sits
   *  only in `DisplayTitle`, which no card reads. So this is the one route to 听障 for 440 rows, and it
   *  never contradicts the words: 0 flagged rows say nothing about it anywhere. */
  isHearingImpaired?: boolean;
}

/** One playable version the server holds for an item. Measured 2026-10-26 this is not always a list of one:
 *  6 of 444 sampled files carry two (挽救计划 2160p/29.72 GB beside 1080p/5.09 GB), so anything reading
 *  `sources[0]` owes the reader a hint that a second version exists. */
export interface PlaybackSource {
  /** MediaSources[].Id — the id every progress report has to name. */
  id: string;
  index: number;
  name?: string;
  container?: string;
  /** `File` when the bytes sit on the server's own disk, `Http` for a referral. Measured on 474 of 474
   *  sampled sources, so the version strip can say where a file is instead of painting a ✓ on it. */
  protocol?: string;
  bitRate?: number;
  sizeBytes?: number;
  /** How long this version runs, in the server's ticks. Absent on the one source of 480 that has no video
   *  stream at all, so a strip that prints a length has to be able to print none. Two versions of one item
   *  can disagree here — 七武士's cuts are 3小时27分 and 3小时21分 — which is the fact that decides the pick. */
  runTimeTicks?: number;
  video?: MediaStreamInfo;
  audio: MediaStreamInfo[];
  subtitle: MediaStreamInfo[];
}

/** Whether a version holds anything at all. Measured 2026-10-27 over both gateways' 23,027 sources: 133 of
 *  them carry no `MediaStreams` row whatsoever — no video, no audio, no subtitle, and 132 report `Size` 0 —
 *  because the gateway lists a `.strm`/`.iso` row it cannot probe (119 strm, 8 iso, 6 mkv). Those are not
 *  versions of a file; they are a path the server can see and nothing behind it. So one rule says who they
 *  are everywhere: the 播放资源 card sinks them and refuses the press, the player's 播放源 card does not
 *  list them, and a negotiation never aims a stream at one. */
export const hasContent = (s: Pick<PlaybackSource, 'video' | 'audio' | 'subtitle'>): boolean =>
  !!s.video || s.audio.length > 0 || s.subtitle.length > 0;

/** Common Sense Media content advisories, one entry per category. `level` is CSM's 0–5 dot scale. */
export interface CsmCategory {
  key: string;
  label: string;
  level: number;
}
export interface CsmGuide {
  categories: CsmCategory[];
  /** Recommended minimum age from the page's JSON-LD `typicalAgeRange` (e.g. 13 in "13-18"). */
  minAge?: number;
  fetchedAt: number;
}

/** One row of TMDB's "more like this" lists — `/similar` and `/recommendations`, merged into the single
 *  list `meta/tmdb.tmdbRelated` returns. These are not dead ends: `lib/related` asks the server for the
 *  row's title and keeps only the answers whose `providers.tmdb` equals this id, so a recommendation the
 *  library holds opens its playable page, and one it does not opens the work page that `TmdbMeta` can
 *  build alone. Measured over 18 sampled bands the two lists share no first-row title, and on the sample
 *  every title the library does hold was found by its TMDB name — where that misses, as it does on a
 *  Chinese spelling this server files a work under, the `originalTitle` below is the second ask. */
export interface TmdbRelated {
  tmdbId: number;
  title: string;
  /** The work's name in its own language — TMDB's `original_title` / `original_name`. Carried because
   *  the library search that turns a row into a page is a title search, and the Chinese spelling this
   *  library files a work under is not always TMDB's: measured, 「明日酱的水手服」 answers zero rows on the
   *  account that holds it as 「明日同学的水手服」. `undefined` when it is the same string as `title`.
   */
  originalTitle?: string;
  posterPath?: string;
  year?: string;
  voteAverage?: number;
  /** How many ratings TMDB counted for that number, 0 when it has counted none. Held because the number
   *  alone cannot be sorted by: on 模范出租车's band 寒枝折不断's 8.0 rests on one rating while 鬼怪's 8.6
   *  rests on 3,139, and a card cannot tell those two apart without this count. */
  votes: number;
}

export interface LibraryRow {
  key: string;
  title: string;
  items: LibraryItem[];
}

export type PlayMethod = 'DirectPlay' | 'DirectStream' | 'Transcode';

/** What the current file contains, as mpv reports it after the demuxer has opened it. Everything here
 *  can differ from what the server advertised (a subtitle the muxer dropped, a second audio track). */
export interface PlayerTrack {
  /** mpv's track id, which is what sid/aid/vid take. mpv numbers each kind from 1, so this is also the
   *  number a row shows; it is not what the server calls the same stream — see `MediaStreamInfo.index`. */
  id: number;
  kind: 'video' | 'audio' | 'subtitle';
  /** The stream's own number inside the container, read off mpv. It is the same number the server puts in
   *  `MediaStreamInfo.index`, and the only one a session event may send back. Missing when the demuxer is
   *  not libavformat — mpv's own image/external tracks. */
  ffIndex?: number;
  title?: string;
  lang?: string;
  codec?: string;
  /** How many channels the container says the track has - mpv's own reading, not the server's row the
   *  card prints. Measured on the bundled 0.41 build: demux-channel-count is there (6 on a 5.1 track,
   *  2 on the commentary), while demux-channels answers 「unknown6」 for the same track and cannot be
   *  shown, and demux-bitrate does not exist at all. */
  channels?: number;
  selected: boolean;
  default: boolean;
  forced?: boolean;
  external?: boolean;
}

export interface PlayerChapter {
  index: number;
  title: string;
  timeMs: number;
}

export type TrackSelection = number | 'auto' | 'no';

export interface PlayerMedia {
  width: number;
  height: number;
  /** The container's frame rate; 0 until the file is loaded (measured: `video-params/fps` does not exist
   *  in this build, so the value comes from the `video-params` object). */
  fps: number;
  /** The decoder mpv settled on, read back rather than assumed: `auto` and a silent fallback both land here. */
  hwdec: string;
  hdr: boolean;
  /** mpv's `video-params/primaries` — `bt.709`, `bt.2020` — falling back to `colormatrix` when a file says
   *  nothing about its primaries. Absent until a file says one. */
  colorSpace?: string;
  trackCount: number;
  tracks: PlayerTrack[];
  chapters: PlayerChapter[];
  subtitle: TrackSelection;
  audio: TrackSelection;
  video: TrackSelection;
  subtitleDelayMs: number;
  audioDelayMs: number;
  subtitleScale: number;
  subtitlePos: number;
  /** 'no' means fit to the window; a number is a forced display aspect. */
  aspect: TrackSelection;
  panscan: number;
  /** The sidecar subtitle this viewing has handed to mpv, if one is loaded: mpv's track id for it and the
   *  server's stream index it came from. The menu needs both — the id to mark the row 正在用, the index
   *  because that is how a row in the 外挂字幕 list is addressed. */
  sidecar?: { trackId: number; index: number } | null;
}

export interface PlayerNav {
  itemId: string;
  /** 已有集号时是「第 3 集」，没有时是那一集自己的名字。 */
  label: string;
}

/** Where a film stopped, sent once on the way out of the player — after the server has taken the write,
 *  so the number here is the number any other client would read back. The state line has already been
 *  blanked by then, so this is the only place the number still exists after the window is gone. */
export interface WatchedRecord {
  itemId: string;
  positionMs: number;
  durationMs: number;
  /** Set only when the item was run to the end and the server agreed it is 已看. It travels with the
   *  position because finishing changes two things a page shows: the stop, and how many are left. */
  played?: boolean;
}

/** The identity of what is playing, plus everything the panels list. Changes only when the file or the
 *  negotiation changes, so it travels on its own channel rather than inside the 4 Hz state. */
export interface PlayerSession {
  itemId: string;
  name: string;
  sourceId: string;
  sources: PlaybackSource[];
  sourceIndex: number;
  /** How the server agreed to hand over the version that is playing. It can only say 转码 for a file the
   *  gateway refuses to give as it is, which the negotiation reports as a refusal rather than a stream. */
  method: PlayMethod | '';
  /** The server's own label for the file's dynamic range, shown whether or not the hint is on. */
  hdr: boolean;
  next: PlayerNav | null;
  prev: PlayerNav | null;
  /** Both ids the 选集 panel needs to list the rest of the show without asking the player first. */
  seriesId?: string;
  seasonId?: string;
  /** Which episode of its season is on screen, for the 选集 panel to mark: the id alone cannot always say,
   *  because a season can hold two rows for one episode and list only one of them. See `episodeSlot`. */
  indexNumber?: number;
  /** Which season that position is in, as a number rather than an id: the shelf and the series' own season
   *  list can hand out two ids for one season, and only the number survives the trip. */
  seasonNumber?: number;
  /** What the danmaku search asks about. An episode called 「第 3 集」 matches nothing, so the series name
   *  travels with it and the layer keys the track to this item. */
  danmaku: DanmakuQuery | null;
}

export interface DanmakuQuery {
  itemId: string;
  title: string;
  seriesName?: string;
  episode?: number;
}

export interface DanmakuComment {
  timeSec: number;
  text: string;
  color: string;
  mode: 'scroll' | 'top' | 'bottom';
}

/** One candidate track the source offered for an item. */
export interface DanmakuTrackInfo {
  id: string;
  title: string;
  /** Only a source that counts comments can fill this; 0 is rendered as 未知. */
  count?: number;
}

export interface DanmakuTrack {
  id: string;
  title: string;
  comments: DanmakuComment[];
  fetchedAt: number;
}

export type PlayerStatus = 'idle' | 'opening' | 'playing' | 'paused' | 'ended' | 'error';

/** 100% is the file's own level - what the operating system would play - so the slider and the system
 *  volume mixer mean the same number. mpv's software boost above unity is switched off rather than
 *  exposed: the slider runs to this ceiling and the kernel clamps to it, so neither end can disagree
 *  about what 100% means. */
export const VOLUME_MAX = 100;

/** The transport half of the player: what the clock says. */
export interface PlayerState {
  status: PlayerStatus;
  positionMs: number;
  durationMs: number;
  /** Where the demuxer has read to, so the bar can show what a seek would be free. */
  bufferedMs: number;
  /** What the demuxer is pulling off the wire right now, measured over a few seconds of its byte counter.
   *  0 while paused or before the first samples land. Measured on the bundled 0.41 build: the cumulative
   *  counter inside `demuxer-cache-state` is `total-bytes`; `raw-bytes` does not exist there. */
  netBytesPerSec: number;
  paused: boolean;
  volume: number;
  muted: boolean;
  speed: number;
  fullscreen: boolean;
  error?: string;
}

/** One control the overlay can ask for. A closed union so a typo is a type error rather than an
 *  `unknown action` at runtime. */
export type PlayerCommand =
  | { action: 'toggle' }
  | { action: 'seekMs'; value: number }
  | { action: 'skip'; value: number }
  | { action: 'speed'; value: number }
  | { action: 'volume'; value: number }
  | { action: 'mute'; value: boolean }
  | { action: 'track'; value: { kind: 'video' | 'audio' | 'subtitle'; id: TrackSelection } }
  /** Pick a subtitle the server keeps next to the file, by the stream number it calls that sidecar. mpv's
   *  `sid` cannot reach one — it only knows the stream it opened — so this goes and fetches the file. */
  | { action: 'sidecarSubtitle'; value: number }
  | { action: 'subtitleDelay'; value: number }
  | { action: 'audioDelay'; value: number }
  | { action: 'subtitleStyle'; value: { scale?: number; pos?: number } }
  | { action: 'aspect'; value: TrackSelection }
  | { action: 'panscan'; value: number }
  | { action: 'chapter'; value: number }
  | { action: 'frameStep'; value: number }
  | { action: 'restart' }
  /** Another version of the same item, by its seat in the session's list. This is the switch that chooses
   *  which file plays, so it re-negotiates; there is no rung command beside it because the file is never
   *  re-encoded on the way. */
  | { action: 'source'; value: number }
  | { action: 'next' }
  | { action: 'prev' }
  | { action: 'fullscreen'; value: boolean };

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
  netBytesPerSec: 0,
  paused: true,
  volume: 100,
  muted: false,
  speed: 1,
  fullscreen: false,
});

export const emptyPlayerMedia = (): PlayerMedia => ({
  width: 0,
  height: 0,
  fps: 0,
  hwdec: '',
  hdr: false,
  trackCount: 0,
  tracks: [],
  chapters: [],
  subtitle: 'auto',
  audio: 'auto',
  video: 'auto',
  subtitleDelayMs: 0,
  audioDelayMs: 0,
  subtitleScale: 100,
  subtitlePos: 100,
  aspect: 'no',
  panscan: 0,
});
