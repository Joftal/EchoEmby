import { net } from 'electron';
import { hasContent } from '../../shared/types';
import type { Account, FacetOption, LibraryItem, LibraryRow, MediaStreamInfo, Person, PlayMethod, PlaybackSource, Providers, StudioRef } from '../../shared/types';
import { buildDeviceProfile } from './deviceProfile';
import { cleanTrackTitle } from '../track-title';

export interface Identity {
  deviceId: string;
  deviceName: string;
  clientName: string;
  clientVersion: string;
  language: string;
}

export class EmbyError extends Error {
  /** `path` is for the log only: two of the writes below swallow a refusal into a boolean, and a line that
   *  says 服务器出错了（HTTP 500） without naming the endpoint cannot tell a lost stop from a lost poster. */
  constructor(message: string, readonly status: number, readonly path?: string) {
    super(message);
  }
}

/** A failure in one log-safe fragment: which endpoint, which status, what the gateway said back. It lives
 *  here rather than in errors.ts's `detail()` because that module imports this one, and a swallow point
 *  should not need a cycle to say why it swallowed. */
function why(e: unknown): string {
  const err = e as EmbyError;
  return `${err?.path || ''} HTTP ${err?.status || 0} ${String(err?.message ?? e)}`.trim();
}

/** The outcome of one PlaybackInfo round. */
export interface Negotiation {
  playSessionId: string;
  sources: PlaybackSource[];
  sourceIndex: number;
  sourceId: string;
  method: PlayMethod;
  /** The absolute upstream address; the bridge turns this into the URL mpv is handed. */
  url: string;
  hdr: boolean;
}

/** Everything a session event has to name. The stream indexes are what Emby's own clients send, and
 *  without them the server records the choice you never made. */
export interface ProgressInput {
  itemId: string;
  sourceId: string;
  playSessionId: string;
  positionMs: number;
  durationMs: number;
  paused: boolean;
  rate: number;
  volume: number;
  videoIndex?: number;
  audioIndex?: number;
  subtitleIndex?: number;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const normalizeBase = (input: string): string => {
  const raw = input.trim().replace(/\/+$/, '');
  const withScheme = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/emby$/i, '');
};

// Login is tried in both request shapes, so a failure can carry a body the server never
// understood ("Value cannot be null"). Only a 401/403 proves the credentials were read,
// so that answer is the one worth showing; a request that never got an answer keeps status
// 0, because reporting it as 401 would blame the password for a dead network.
const loginVerdict = (failures: Array<{ status: number; text: string }>): { status: number; text: string } => {
  const rejected = failures.filter(f => f.status === 401 || f.status === 403);
  const chosen = rejected[rejected.length - 1] ?? failures[failures.length - 1] ?? { status: 401, text: 'login failed' };
  return { status: chosen.status, text: chosen.text.slice(0, 160) };
};

const authQuery = (id: Identity, token?: string): URLSearchParams => {  const q = new URLSearchParams({
    'X-Emby-Client': id.clientName,
    'X-Emby-Device-Name': id.deviceName,
    'X-Emby-Device-Id': id.deviceId,
    'X-Emby-Client-Version': id.clientVersion,
    'X-Emby-Language': id.language,
  });
  if (token) q.set('X-Emby-Token', token);
  return q;
};

const authHeader = (id: Identity, token?: string): string =>
  `MediaBrowser Client="${id.clientName}", Device="${id.deviceName}", DeviceId="${id.deviceId}", Version="${id.clientVersion}"${token ? `, Token="${token}"` : ''}`;

/* Only what `mapItem` actually reads. Twelve more used to be asked for and dropped on the floor —
   `BasicSyncInfo`, `CanDelete`, `CanDownload`, `Status` and `PrimaryImageAspectRatio` are server-side joins
   computed for every row of a 100-row page, and the five media fields (`MediaStreams`, `Container`,
   `Bitrate`, `VideoRange`, `Width`/`Height`) are the flat copy of properties the tech block reads from
   `MediaSources` on the detail reply instead. `Studio` was the odd one out: the list endpoints answer the
   singular with a bare name and the plural with the same names, and both mappers read `Studios`. */
const FIELDS =
  'ProductionYear,CommunityRating,OfficialRating,Overview,SeriesName,SeriesId,ParentId,ChildCount,Genres,PremiereDate,Studios,ProviderIds,OriginalTitle,DateCreated';

/** People and Taglines are detail-only: on the list endpoints People would multiply every row by the
 *  cast size. DateCreated does come back on a list row when it is asked for, and the search page's
 *  最近加入 has nothing else to order by — the server will not sort a SearchTerm query at all. */
const DETAIL_FIELDS = FIELDS + ',People,Taglines';

// Measured on this server: 40/40 items carry a Tmdb id and 35/40 an Imdb id, so outside sources can
// be keyed off ids instead of guessing from a Chinese title.
const mapProviders = (raw: any): Providers | undefined => {
  if (!raw) return undefined;
  const p: Providers = {};
  if (raw.Imdb) p.imdb = raw.Imdb;
  if (raw.Tmdb) p.tmdb = raw.Tmdb;
  if (raw.Tvdb) p.tvdb = raw.Tvdb;
  return p.imdb || p.tmdb || p.tvdb ? p : undefined;
};

// Server order is craft roles first, then cast, so the cap keeps the directors.
const mapPeople = (raw: any): Person[] | undefined => {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  return raw.slice(0, 24).map((p: any) => ({ id: p.Id, name: p.Name, type: p.Type, role: p.Role, imageTag: p.PrimaryImageTag }));
};

// The item endpoint answers Studios with objects, the list endpoint with names.
const studioName = (r: any): string | undefined => {
  const s = r.StudioItems?.[0] ?? r.Studios?.[0];
  return typeof s === 'string' ? s : s?.Name;
};

/** The 公司 filter takes StudioIds, and the only place to learn an id without a second round trip is the
 *  item that already carries it. Both shapes appear on this server: name strings on the list endpoints,
 *  {Name,Id} rows elsewhere, so the id is simply absent where the server did not give one. */
const mapStudios = (r: any): StudioRef[] | undefined => {
  const raw = r.StudioItems?.length ? r.StudioItems : r.Studios;
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const out = raw.map((s: any): StudioRef => (typeof s === 'string' ? { name: s } : { name: s.Name, id: s.Id != null ? String(s.Id) : undefined })).filter((s: StudioRef) => s.name);
  return out.length ? out : undefined;
};

const mapStreams = (raw: any): MediaStreamInfo[] =>
  (raw || []).map((v: any): MediaStreamInfo => ({
    index: v.Index,
    type: v.Type,
    codec: v.Codec,
    displayTitle: v.DisplayTitle,
    lang: v.Language,
    title: cleanTrackTitle(v.Title),
    width: v.Width,
    height: v.Height,
    bitDepth: v.BitDepth,
    range: v.VideoRange || v.VideoRangeType,
    isInterlaced: v.IsInterlaced,
    fps: v.NominalFrameRate || v.AverageFrameRate,
    bitRate: v.BitRate,
    channels: v.Channels,
    channelLayout: v.ChannelLayout,
    sampleRate: v.SampleRate,
    profile: v.Profile,
    isDefault: v.IsDefault,
    isForced: v.IsForced,
    isExternal: v.IsExternal,
    isHearingImpaired: v.IsHearingImpaired,
    isTextSubtitle: v.IsTextSubtitleStream,
  }));

/** One version the server can serve. The id is what every progress report and every stream URL has to
 *  name, so a source without one is useless and is not listed rather than listed with a blank row. */
const mapSources = (raw: any): PlaybackSource[] => {
  if (!Array.isArray(raw)) return [];
  const out: PlaybackSource[] = [];
  raw.forEach((s: any, index: number) => {
    if (!s || typeof s.Id !== 'string' || !s.Id) return;
    const streams = mapStreams(s.MediaStreams);
    out.push({
      id: s.Id,
      index,
      name: s.Name,
      container: s.Container,
      protocol: s.Protocol,
      bitRate: s.Bitrate,
      sizeBytes: s.Size,
      runTimeTicks: s.RunTimeTicks,
      video: streams.find(x => x.type === 'Video'),
      audio: streams.filter(x => x.type === 'Audio'),
      subtitle: streams.filter(x => x.type === 'Subtitle'),
    });
  });
  return out;
};

/** Where the viewer stopped. This gateway answers `PlaybackPositionTicks` and never
 *  `StartPositionTicks` (measured on 326185: PlaybackPositionTicks 8306670000, StartPositionTicks absent
 *  from the whole UserData block on both the list and the detail reply) — reading only the second name
 *  is what left every resume at zero. */
const positionTicks = (u: any): number => Number(u?.PlaybackPositionTicks ?? u?.StartPositionTicks ?? 0);

const mapItem = (r: any): LibraryItem => ({
  id: r.Id,
  type: r.Type,
  collectionType: r.CollectionType,
  name: r.Name,
  originalTitle: r.OriginalTitle,
  seriesName: r.SeriesName,
  productionYear: r.ProductionYear,
  officialRating: r.OfficialRating,
  communityRating: r.CommunityRating,
  // All of them, not the first three: a row kept behind a genre tag sitting at position 4 of the server's
  // array showed no trace of that tag on screen, so filtering 奇幻 answered with 16 of 48 cards that did not
  // say 奇幻 anywhere. Narrowing to three is a per-layout decision (ListCard, HeroBanner), not a data decision.
  genres: r.Genres?.length ? r.Genres : undefined,
  studio: studioName(r),
  studios: mapStudios(r),
  premiereDate: r.PremiereDate,
  overview: r.Overview,
  runTimeTicks: r.RunTimeTicks,
  primaryImageTag: r.ImageTags?.Primary,
  backdropImageTag: r.BackdropImageTags?.[0],
  logoImageTag: r.ImageTags?.Logo,
  // Episodes must land on the Series page: this fork answers ParentId with the
  // Season id and only exposes SeriesId when it is requested in Fields.
  parentId: r.SeriesId || r.ParentId,
  seriesId: r.SeriesId,
  seasonId: r.ParentId,
  indexNumber: r.IndexNumber,
  parentIndexNumber: r.ParentIndexNumber,
  childCount: r.ChildCount,
  userData: r.UserData
    ? {
        playedPercentage: r.UserData.PlayedPercentage,
        isFavorite: r.UserData.IsFavorite,
        positionMs: Math.round(positionTicks(r.UserData) / 1e4),
        played: !!r.UserData.Played,
      }
    : undefined,
  providers: mapProviders(r.ProviderIds),
  dateCreated: r.DateCreated,
  tagline: r.Taglines?.[0],
});

async function http(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await net.fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Answers the whole app shares, held beside the class that asks them: every IPC call builds a fresh
 *  client, so an instance field would cache nothing. Keyed by account because a token for one server
 *  cannot answer for another, and an in-flight slot because the lobby asks twice in the same tick —
 *  once for its own rows and once through the renderer's rail. */
const TTL = 10 * 60_000;
const session = new Map<string, { at: number; value: unknown; pending: Promise<unknown> | null }>();

function sessionCached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = session.get(key);
  if (hit?.pending) return hit.pending as Promise<T>;
  if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.value as T);
  const slot: { at: number; value: unknown; pending: Promise<unknown> | null } = { at: 0, value: undefined, pending: null };
  session.set(key, slot);
  const pending = load().then(
    value => {
      slot.pending = null;
      slot.at = Date.now();
      slot.value = value;
      return value;
    },
    e => {
      slot.pending = null;
      session.delete(key);
      throw e;
    },
  );
  slot.pending = pending;
  return pending;
}

export class EmbyClient {
  constructor(
    private readonly account: Account,
    private readonly identity: Identity,
  ) {}

  private get base(): string {
    return `${this.account.baseUrl}/emby`;
  }

  private headers(token?: string): Record<string, string> {
    return {
      'User-Agent': UA,
      Accept: 'application/json',
      'X-Emby-Authorization': authHeader(this.identity, token ?? this.account.accessToken),
      'X-Emby-Token': token ?? this.account.accessToken,
    };
  }

  async get<T = any>(path: string, params: Record<string, string | number | boolean | undefined> = {}, timeoutMs = 15000): Promise<T> {
    const q = authQuery(this.identity);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
    const res = await http(`${this.base}${path}?${q}`, { method: 'GET', headers: this.headers() }, timeoutMs);
    const text = await res.text();
    if (!res.ok) throw new EmbyError(text.slice(0, 200) || res.statusText, res.status, path);
    return text ? JSON.parse(text) : ({} as T);
  }

  async post<T = any>(path: string, body?: unknown, params: Record<string, string | number | boolean | undefined> = {}, timeoutMs = 20000): Promise<T> {
    const q = authQuery(this.identity);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
    const res = await http(
      `${this.base}${path}?${q}`,
      {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: body === undefined ? '' : JSON.stringify(body),
      },
      timeoutMs,
    );
    const text = await res.text();
    if (!res.ok) throw new EmbyError(text.slice(0, 200) || res.statusText, res.status, path);
    return text ? JSON.parse(text) : ({} as T);
  }

  /**
   * This server's web client is a fork whose login takes form fields `Username`/`Pw`;
   * stock Emby takes JSON `{Name,Password}`. Try the fork shape, fall back to standard.
   */
  /** Answered without credentials on every Emby build, so an address can be checked before a password is typed. */
  static async publicInfo(baseUrl: string, identity: Identity): Promise<{ serverName: string; version: string }> {
    const root = normalizeBase(baseUrl);
    const res = await http(`${root}/emby/System/Info/Public?${authQuery(identity)}`, { headers: { 'User-Agent': UA } }, 9000);
    if (!res.ok) throw new EmbyError(res.statusText || 'no answer', res.status);
    const j = (await res.json()) as any;
    return { serverName: j?.ServerName || new URL(root).host, version: j?.Version || '' };
  }

  static async login(baseUrl: string, username: string, password: string, identity: Identity): Promise<Account> {
    const root = normalizeBase(baseUrl);
    const q = authQuery(identity);
    const attempts: Array<{ label: string; ct: string; body: string }> = [
      { label: 'form', ct: 'application/x-www-form-urlencoded', body: new URLSearchParams({ Username: username, Pw: password }).toString() },
      { label: 'json', ct: 'application/json', body: JSON.stringify({ Name: username, Password: password }) },
    ];
    const failures: Array<{ status: number; text: string }> = [];
    for (const a of attempts) {
      try {
        const res = await http(
          `${root}/emby/Users/authenticatebyname?${q}`,
          {
            method: 'POST',
            headers: { 'User-Agent': UA, 'Content-Type': a.ct, 'X-Emby-Authorization': authHeader(identity) },
            body: a.body,
          },
          20000,
        );
        const text = await res.text();
        if (!res.ok) {
          failures.push({ status: res.status, text: text.trim() || res.statusText });
          continue;
        }
        const j = JSON.parse(text);
        if (!j?.AccessToken || !j?.User?.Id) {
          failures.push({ status: res.status, text: '服务器回应了，但没有给出登录令牌' });
          continue;
        }
        const info = await EmbyClient.publicInfo(root, identity).catch(() => null);
        return {
          accountId: '',
          serverName: j.ServerName || info?.serverName || new URL(root).host,
          baseUrl: root,
          username: j.User.Name || username,
          userId: j.User.Id,
          accessToken: j.AccessToken,
          lastUsed: Date.now(),
        };
      } catch (e) {
        failures.push({ status: 0, text: String((e as Error).message) });
      }
    }
    const v = loginVerdict(failures);
    throw new EmbyError(v.text, v.status);
  }

  async del<T = any>(path: string, params: Record<string, string | number | boolean | undefined> = {}, timeoutMs = 20000): Promise<T> {
    const q = authQuery(this.identity);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
    const res = await http(`${this.base}${path}?${q}`, { method: 'DELETE', headers: this.headers() }, timeoutMs);
    const text = await res.text();
    if (!res.ok) throw new EmbyError(text.slice(0, 200) || res.statusText, res.status, path);
    return text ? JSON.parse(text) : ({} as T);
  }

  async serverName(): Promise<string> {
    const j = await this.get<any>('/System/Info/Public', {}, 8000);
    return j?.ServerName || '';
  }

  /** What a cached library answer belongs to. The address and name are part of it because the account
   *  editor can move an account onto another server without changing its id, and the rail must not go on
   *  showing the old one's folders. */
  private get libraryKey(): string {
    return `${this.account.accountId}|${this.account.baseUrl}|${this.account.username}`;
  }

  /** The raw folder list. Left uncached on purpose: the account editor calls it to prove a moved folder
   *  still answers under the same token, and a cache keyed by account would hand back the old server's
   *  answer. Everything that only wants to read the libraries goes through `libraryViews`. */
  async views(): Promise<LibraryItem[]> {
    const j = await this.get<any>(`/Users/${this.account.userId}/Views`, { GroupByCollectionType: true });
    return (j.Items || []).map(mapItem);
  }

  async libraryViews(): Promise<LibraryItem[]> {
    return sessionCached(`views|${this.libraryKey}`, () => this.views());
  }

  /** The libraries worth putting on screen, and how fresh each one is. One small ask per folder answers both:
   *  Views hands back every folder the account may see and an empty one looks identical to a merely quiet one
   *  (measured: 播放列表 and 合集 answer empty on both gateways), so each is asked the same question the browse
   *  page will ask — and asking it sorted by `DateCreated` returns the folder's newest row in the very reply
   *  that proves it is not empty, so ordering the lobby by freshness costs no round trip on top of what the
   *  rail already waits for. `StartDate` cannot do that job (measured 2026-10-21: silently ignored — all 16
   *  libraries answered a 7/30/90-day window with their whole `TotalRecordCount`), which leaves the newest
   *  row's own date as the only freshness signal the server will give.
   *  `Fields` overrides `items()`'s default field list rather than adding to it, so this is not the heavy
   *  ask it looks like: measured 2026-10-21 on OkEmby, the whole rail answered 3.9 KB in 737 ms against the
   *  9.6 KB and 1022 ms the wide pre-change probe cost, and the two time bands overlap.
   *  The type list is content rows only, measured the same day on nyamedia, and it is what makes that signal
   *  honest: — `Episode` has to be in it, or the date means "when did this library last take a whole new show";
   *  动漫 - 华语 (进集到 10-18) reads 04-13 from its newest Series row instead. — 合集/播放列表 have to stay out,
   *  because a collection row can stamp newer than everything in the library: the newest row of both 电视 - 韩国
   *  and 电视 - 欧美 is a 测试合集 dated 09-28 over real content from 01-19 and 09-10, and reading it would put
   *  韩国 in a seat and take 欧美 out. Leaving them out costs nothing on the emptiness verdict — the same 16 of
   *  17 folders answered non-empty either way, 播放列表 the only one that does not. Studios and Folders carry
   *  ingest dates too (电影 - 用户上传 answered 10-18·Folder, 演唱会 12-29·Studio), so an unfiltered ask is worse.
   *  The exclusion is only as good as the server's type filter. On OkEmby a library whose rows are all 合集
   *  answers a BoxSet to `Movie,Series,Episode,Video`, to `Movie,Series,Episode`, and even to `Video` alone
   *  (合集 · 2025-11-28), while the filter does hold where the library has real content (its 国产电视剧 asked
   *  for `Movie` only answered no rows). So there a collection-only folder ranks by its own date; on both
   *  hosts the eight seats the page drew were the eight newest libraries, checked against this same ask run
   *  inside the app.
   *  A failed probe keeps its library: only a proven-empty answer hides it. Held for the session in the main
   *  process rather than per window — the lobby and the player window ask the same questions of the same
   *  account, and the answer only changes when the server's does. */
  private probedViews(): Promise<{ views: LibraryItem[]; fresh: Map<string, number> }> {
    return sessionCached(`navViews|${this.libraryKey}`, async () => {
      const all = await this.libraryViews();
      const probes = await Promise.all(
        all.map(v =>
          this.items({
            ParentId: v.id,
            IncludeItemTypes: 'Movie,Series,Episode,Video',
            Recursive: true,
            Limit: 1,
            SortBy: 'DateCreated',
            SortOrder: 'Descending',
            Fields: 'DateCreated',
          })
            .then(x => ({ at: Date.parse(x[0]?.dateCreated || '') || 0, empty: !x.length }))
            .catch(() => ({ at: 0, empty: false })),
        ),
      );
      const fresh = new Map<string, number>();
      all.forEach((v, i) => {
        if (probes[i].at) fresh.set(v.id, probes[i].at);
      });
      return { views: all.filter((_, i) => !probes[i].empty), fresh };
    });
  }

  async navViews(): Promise<LibraryItem[]> {
    return (await this.probedViews()).views;
  }

  /**
   * Neither server answers Views with ItemCount, so the totals come from a
   * one-item page of each type: the answer only needs TotalRecordCount. Held for
   * the session because the rail repaints them on every page of the app.
   */
  async counts(): Promise<{ movies: number; series: number }> {
    return sessionCached(`counts|${this.libraryKey}`, async () => {
      const total = async (type: string) => {
        const j = await this.get<any>(`/Users/${this.account.userId}/Items`, { IncludeItemTypes: type, Recursive: true, Limit: 1 }, 12000);
        return Number(j?.TotalRecordCount) || 0;
      };
      const [movies, series] = await Promise.all([total('Movie'), total('Series')]);
      return { movies, series };
    });
  }

  async items(params: Record<string, string | number | boolean | undefined>): Promise<LibraryItem[]> {
    const j = await this.get<any>(`/Users/${this.account.userId}/Items`, { Fields: FIELDS, ImageTypeLimit: 1, EnableImageTypes: 'Primary,Backdrop,Thumb,Logo', ...params });
    return (j.Items || []).map(mapItem);
  }

  /** The library's whole genre list, exactly as the scraper wrote it. Measured: 50 rows on the gateway and
   *  26 on nyamedia, and the gateway's are mixed — 23 中文, 25 English, 2 Japanese spellings of the same
   *  genres. Folding them onto one Chinese label is the renderer's job (lib/genres), so the dropdown can be
   *  filled once per account rather than shrinking to whatever the current page happens to hold. */
  async genres(): Promise<FacetOption[]> {
    const j = await this.get<any>(`/Genres`, { UserId: this.account.userId, Limit: 200 });
    return (j.Items || []).map((x: any) => ({ name: String(x.Name) }));
  }

  /** The library's whole company list, in one answer, instead of whichever companies the rows a page
   *  happens to hold were credited with. That difference was visible: 公司 is the only pill built from the
   *  results, so a search page that had loaded nothing yet had no 公司 at all, and a page holding 48 films
   *  offered the twelve companies behind them. Measured: 8185 rows on the gateway (1.9 MB of JSON) and
   *  1328 on nyamedia; six ids sampled from the tail of the gateway's list each answered under
   *  `StudioIds`, so every id here is one this filter can actually be given. */
  async studios(): Promise<FacetOption[]> {
    const j = await this.get<any>(`/Studios`, { UserId: this.account.userId, Limit: 20000 });
    return (j.Items || [])
      .filter((x: any) => x && x.Name)
      .map((x: any) => ({ name: String(x.Name), id: x.Id ? String(x.Id) : undefined }));
  }

  async item(id: string): Promise<LibraryItem> {
    const j = await this.get<any>(`/Users/${this.account.userId}/Items/${id}`, { Fields: DETAIL_FIELDS });
    const it = mapItem(j);
    it.people = mapPeople(j.People);
    it.sources = mapSources(j.MediaSources);
    return it;
  }

  async seasons(seriesId: string): Promise<LibraryItem[]> {
    const j = await this.get<any>(`/Shows/${seriesId}/Seasons`, { UserId: this.account.userId, Fields: FIELDS });
    return (j.Items || []).map(mapItem);
  }

  async episodes(seriesId: string, seasonId: string): Promise<LibraryItem[]> {
    const j = await this.get<any>(`/Shows/${seriesId}/Episodes`, { UserId: this.account.userId, SeasonId: seasonId, Fields: FIELDS });
    return (j.Items || []).map(mapItem);
  }

  /** Latest answers with the series itself, so the episode position has to come from a parallel pass.
   *  The pass is 1200 rows because the badges are worth it and a shorter window drops them silently: the
   *  series a row shows sat as deep as position 379 of the pull on OkEmby (measured 2026-10-12) and as deep
   *  as 981 on nyamedia's 电视 - 欧美, 1091 on its 动漫 - 华语 (measured 2026-10-21). One ask covers that
   *  much — Limit=1200 came back in a single round trip (1200 rows of a 7790-episode library, 0.85 MB), so
   *  there is no paging to join. Even so 1200 leaves 斗罗大陆 and 天官赐福 uncovered on nyamedia, and those
   *  cards fall back to 季数 · 年份, which is the designed degradation rather than a miss.
   *  What the pass does not need is a folder that cannot hold an episode at all — the libraries this server
   *  labels movies each answered with zero rows. Reading the type off the Views row costs no round trip,
   *  unlike waiting to see whether the Latest row happened to hold a series. */
  private async newestEpisodes(folder: LibraryItem): Promise<Map<string, LibraryItem>> {
    if (folder.collectionType === 'movies') return new Map();
    const eps = await this.items({
      ParentId: folder.id,
      Recursive: true,
      IncludeItemTypes: 'Episode',
      SortBy: 'DateCreated',
      SortOrder: 'Descending',
      Limit: 1200,
      Fields: 'SeriesId,IndexNumber,ParentIndexNumber',
    }).catch(() => []);
    const m = new Map<string, LibraryItem>();
    for (const e of eps) if (e.parentId && !m.has(e.parentId)) m.set(e.parentId, e);
    return m;
  }

  /** The server's own 「继续观看」 answer: one row per title that has something to continue, already in
   *  last-opened order, already one-per-series. Measured against the list below on both gateways: 8 of its
   *  12 rows carry a real offset where the list carries 2 of 18, it names the *next unwatched* episode of a
   *  show whose episodes you finished (鬼灭之刃 S01E03, not the played-over E01/E02 the list hands back),
   *  and it reaches titles the list's window never gets to (这个杀手不太冷静 parked at 80.5%).
   *  `SortBy` is ignored by it on both servers — its own order is the wanted one. `MediaTypes` is not
   *  decoration: asked without it the endpoint answers zero rows. */
  private async resumePoints(limit: number): Promise<LibraryItem[]> {
    const j = await this.get<any>(`/Users/${this.account.userId}/Items/Resume`, {
      Limit: limit,
      MediaTypes: 'Video',
      Fields: FIELDS,
      ImageTypeLimit: 1,
      EnableImageTypes: 'Primary,Backdrop,Thumb,Logo',
    });
    return (j.Items || []).map(mapItem);
  }

  /** Nothing left to continue: finished, and not parked anywhere with an offset. `IsResumable=true` is not
   *  the filter its name suggests on these forks — 33 of the 60 rows bangumi answers that way are already
   *  Played, so the row was filling with episodes that have nothing to resume and no 看到 time to show. */
  private stalled = (x: LibraryItem): boolean => !!x.userData?.played && !x.userData.positionMs;

  /** Whether a row still parks the viewer *inside* it. The two surfaces that name a progress on the lobby
   *  (the hero plate and the 在看 rail) print what this row says, so a row that parks them nowhere is not an
   *  answer: measured on nyamedia 2026-10-24, 8 of the shelf's 22 rows carry `positionMs: 0`, and the
   *  Resume endpoint put one of those — 火影忍者 第 222 集, seen to 0 — in front of the same show's real
   *  stop, 第 224 集 at 8:18, which the DatePlayed list carries at row 6 of the very same window. A
   *  percentage counts because this fork answers some rows that way instead of with an offset; 99 and up
   *  is finished, and under a second there is nothing to print (see the 「看到 0:00」 case in the
   *  renderer's isStoppedRow). */
  private parked = (x: LibraryItem): boolean => {
    const u = x.userData;
    if (!u) return false;
    if (u.played && !u.positionMs) return false;
    const pct = u.playedPercentage || 0;
    if (pct >= 99) return false;
    return (u.positionMs || 0) >= 1000 || pct > 0;
  };

  /** The 在看 row on its own. Closing the player changes which titles are in it and in what order, and
   *  that is the only part of the lobby a stopped film can move — a 最新更新 row is a library's ingest order
   *  and does not care what was watched. Asked alone, it is two round trips in parallel instead of the
   *  fifteen the whole lobby costs. */
  async resumeRow(limit = 18): Promise<LibraryRow | null> {
    // The endpoint first because it knows where each title actually continues; the DatePlayed list behind it
    // because a title the server has no offset for is still something the viewer was in the middle of, and
    // dropping it would take the show off the shelf they reach for. Either one alone is a row; neither is
    // allowed to be the reason the lobby has nothing on it.
    const [points, recent] = await Promise.all([
      this.resumePoints(limit).catch(() => []),
      this.items({ Recursive: true, MediaTypes: 'Video', SortBy: 'DatePlayed', SortOrder: 'Descending', Limit: limit, IsResumable: true }).catch(() => []),
    ]);
    const seat = new Map<string, number>();
    // One card is one show, so an episode folds onto its series by name — the same rule the 在看 page's
    // own fold uses. Keying on `parentId` instead split a show whose two stopped episodes sit in
    // different seasons into two cards on the rail, which has no fold of its own.
    // A show keeps the seat it first took, so the shelf order stays the endpoint's own; only the episode
    // that fills the seat can change, and only upward: a row that parks the viewer somewhere beats one
    // that parks them nowhere. Measured the same day, this moves 火影忍者 to 第 224 集 (8:18) inside the
    // existing window and leaves the other seven pos-0 rows standing, because the pool holds no stopped
    // row for them at any depth — asking the DatePlayed list at 18, 60 and 180 answers 7, 14 and 20
    // stopped rows of 18/60/180, and none of the seven shows' stops is among them. Those seven keep their
    // seat on purpose (a title the viewer was in is still something they reach for); the detail page
    // answers them by asking that one work directly.
    const items: LibraryItem[] = [];
    for (const x of [...points, ...recent]) {
      if (this.stalled(x)) continue;
      const key = x.type === 'Episode' ? x.seriesName || x.parentId || x.id : x.id;
      const at = seat.get(key);
      if (at === undefined) {
        seat.set(key, items.length);
        items.push(x);
      } else if (!this.parked(items[at]) && this.parked(x)) items[at] = x;
    }
    return items.length ? { key: 'resume', title: '继续观看', items } : null;
  }

  async homeRows(): Promise<LibraryRow[]> {
    // The rows read the probed library list, not the raw one, because a slot spent on an empty folder is a
    // stocked library that never appears: measured 2026-10-21 on nyamedia, Views puts 播放列表 in seat 1 and
    // both probe shapes answer it with nothing, so the lobby drew 7 of its 8 slots off the raw list; the
    // probed list fills all 8. The probes are not extra time on this page — the rail asks the same cached
    // answer in the same tick, so the folder list is paid for once either way. It also stops an empty folder
    // from burning a whole episode pass.
    //
    // The seats then go to the libraries that actually took something, newest first, rather than to whatever
    // Views happened to list first: measured the same day, the server's own order kept 电影 - 韩国 (282 天没进
    // 过东西), 电视 - 日本 (210 天) and 电影 - 欧美 (199 天) on screen while 新番计划 (当天) and 动漫 - 华语
    // (2 天) sat outside the cut, and the eight seats became 新番计划、动漫 - 华语、电视 - 华语、电视 - 用户上传、
    // 电视 - 欧美、电影 - 用户上传、电影 - 华语、番剧. Ties keep the server's order (the sort is stable). The
    // rail is deliberately left in Views order — a library list should not move under the cursor because a
    // film arrived.
    //
    // Nothing here is allowed to take the whole lobby down: the rail row and each row's own two asks catch
    // for themselves, so one dead endpoint costs one row instead of the page.
    const [probed, resume] = await Promise.all([this.probedViews(), this.resumeRow().catch(() => null)]);
    const views = probed.views
      .slice()
      .sort((a, b) => (probed.fresh.get(b.id) ?? 0) - (probed.fresh.get(a.id) ?? 0));
    const rows: LibraryRow[] = [];
    if (resume) rows.push(resume);
    const latest = await Promise.all(
      views.slice(0, 8).map(async v => {
        const [items, newest] = await Promise.all([
          this.get<any>(`/Users/${this.account.userId}/Items/Latest`, { ParentId: v.id, Limit: 18, Fields: FIELDS, ImageTypeLimit: 1, EnableImageTypes: 'Primary,Backdrop,Logo' })
            .then(j => (j || []).map(mapItem))
            .catch(() => []),
          this.newestEpisodes(v),
        ]);
        for (const it of items) {
          const e = it.type === 'Series' ? newest.get(it.id) : undefined;
          if (e?.indexNumber != null) it.latestEpisode = { season: e.parentIndexNumber, episode: e.indexNumber };
        }
        return { key: `latest-${v.id}`, title: `最新更新 · ${v.name}`, items };
      }),
    );
    rows.push(...latest.filter(r => r.items.length));
    return rows;
  }

  imageUrl(item: Pick<LibraryItem, 'id' | 'primaryImageTag'>, width: number): string {
    const q = authQuery(this.identity);
    if (item.primaryImageTag) q.set('tag', item.primaryImageTag);
    q.set('maxWidth', String(width));
    q.set('format', 'jpg');
    q.set('quality', '90');
    return `${this.base}/Items/${item.id}/Images/Primary?${q}`;
  }

  backdropUrl(item: Pick<LibraryItem, 'id' | 'backdropImageTag'>, width: number): string {
    const q = authQuery(this.identity);
    if (item.backdropImageTag) q.set('tag', item.backdropImageTag);
    q.set('maxWidth', String(width));
    q.set('format', 'jpg');
    return `${this.base}/Items/${item.id}/Images/Backdrop?${q}`;
  }

  /** The title treatment has to stay a PNG: the art is a transparent cut-out, and a JPEG of it arrives on a
   *  black ground, which is the one background the hero does not have. */
  logoUrl(item: Pick<LibraryItem, 'id' | 'logoImageTag'>, width: number): string {
    const q = authQuery(this.identity);
    if (item.logoImageTag) q.set('tag', item.logoImageTag);
    q.set('maxWidth', String(width));
    q.set('format', 'png');
    return `${this.base}/Items/${item.id}/Images/Logo?${q}`;
  }

  /** The bytes of a subtitle the server keeps next to the file. Measured 2026-10-27 against the four
   *  address shapes this fork might answer: only the one ending in the codec extension exists —
   *  `/Subtitles/{index}/Stream.srt` returned 200 `text/plain` with real cues on 4 of 4 probed sidecars
   *  (112,809 bytes for 挽救计划's index 8), while `/Stream`, `/Download` and the source-less form all
   *  answered 找不到文件. It is fetched here rather than handed to the player as a URL because the route to
   *  this host sometimes needs the proxy and the player process knows nothing about it — one of those four
   *  only arrived through the proxy. */
  async subtitleBytes(itemId: string, sourceId: string, index: number, codec: string): Promise<Buffer> {
    const q = authQuery(this.identity);
    const res = await http(
      `${this.base}/Videos/${itemId}/${sourceId}/Subtitles/${index}/Stream.${codec}?${q}`,
      { method: 'GET', headers: this.headers() },
      20000,
    );
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok) throw new EmbyError(buf.subarray(0, 160).toString('utf8') || res.statusText, res.status);
    if (!buf.length) throw new EmbyError('这台服务器把那条字幕返回成空文件', 502);
    return buf;
  }

  /** What one negotiation round decided: which version, by which method, from which address. */
  async negotiate(itemId: string, opts: { sourceId?: string }): Promise<Negotiation> {
    const profile = buildDeviceProfile();
    // 原片 is not a bitrate so much as a refusal: offer a cap no file needs and forbid transcoding, which
    // is what Emby's own clients send when they mean the file itself. The answer that comes back is then
    // the server's word on how it will hand this file over, and nothing here decides it.
    const j = await this.post<any>(
      `/Items/${itemId}/PlaybackInfo`,
      { DeviceProfile: profile, ...profile },
      { UserId: this.account.userId, StartTimeTicks: 0, EnableTranscoding: false },
    );
    const sources = mapSources(j.MediaSources);
    // A row the gateway cannot probe — no stream at all, 133 of the 23,027 sources measured 2026-10-27, 132
    // of them reporting `Size` 0 — is a path with nothing behind it rather than a version of the file, and
    // asking the server for its stream answers HTTP 500 (挽救计划's `- mobile.mp4` does exactly that). So the
    // pick is made among the rows that hold a stream, and an item whose every row is empty has no source to
    // offer, which is said here rather than by a stream that dies a second later.
    const usable = sources.filter(s => hasContent(s));
    if (!usable.length) throw new EmbyError('这个条目没有可用的播放源', 502);
    const raw = (opts.sourceId ? usable.find(s => s.id === opts.sourceId) : undefined) || usable[0];
    const ms = (j.MediaSources || []).find((x: any) => x?.Id === raw.id) || {};
    // This fork omits MediaSources[].PlayMethod, so the method is derived from the flags the server does answer.
    const method: PlayMethod =
      ms.PlayMethod === 'Transcode' || ms.PlayMethod === 'DirectPlay' || ms.PlayMethod === 'DirectStream'
        ? ms.PlayMethod
        : ms.SupportsDirectPlay
          ? 'DirectPlay'
          : ms.SupportsDirectStream
            ? 'DirectStream'
            : 'Transcode';
    const q = authQuery(this.identity);
    q.set('MediaSourceId', raw.id);
    if (j.PlaySessionId) q.set('PlaySessionId', String(j.PlaySessionId));
    q.set('api_key', this.account.accessToken);
    // A gateway that insists on re-making a file on the way out has been told no already, and there is
    // nothing here to receive the result: no segment list is followed, no re-encoded picture is shown.
    // Saying so at the pick is the honest answer — 转码 as a playlist never played on any proxy route
    // this machine has, so the alternative was a stream that stalls.
    if (method === 'Transcode') throw new EmbyError('这台服务器要把这一版转码才肯给，播放器不做转码', 502);
    q.set('static', 'true');
    q.set('seek', '0');
    const url = `${this.base}/videos/${itemId}/stream?${q}`;
    const range = String(raw.video?.range || '');
    return {
      playSessionId: String(j.PlaySessionId || ''),
      sources,
      sourceIndex: raw.index,
      sourceId: raw.id,
      method,
      url,
      hdr: /hdr|dovi|dolbyvision|hlg/i.test(range) || /dolbyvision/i.test(String(raw.video?.codec || '')),
    };
  }

  /** Resumable start offset plus the display name; PlaybackInfo only labels the
   *  media source ("2160p"), so the title has to come from the item itself. */
  async resumePoint(itemId: string): Promise<{ name: string; startMs: number; played: boolean }> {
    const j = await this.get<any>(`/Users/${this.account.userId}/Items/${itemId}`, { Fields: 'UserData' });
    return {
      name: j?.Name || '',
      startMs: Math.round(positionTicks(j?.UserData) / 1e4),
      played: !!j?.UserData?.Played,
    };
  }

  private progressBody(input: ProgressInput): Record<string, unknown> {
    const body: Record<string, unknown> = {
      ItemId: input.itemId,
      MediaSourceId: input.sourceId,
      PlaySessionId: input.playSessionId,
      PositionTicks: Math.round(input.positionMs * 1e4),
      RuntimeTicks: Math.round(input.durationMs * 1e4),
      IsPaused: input.paused,
      CanSeek: true,
      // The server stores the rate you watched at, so a 2× session that reports 1 would leave the next
      // client resuming at the wrong place.
      PlaybackRate: input.rate || 1,
      VolumeLevel: input.volume,
    };
    if (input.videoIndex !== undefined && input.videoIndex >= 0) body.VideoStreamIndex = input.videoIndex;
    if (input.audioIndex !== undefined && input.audioIndex >= 0) body.AudioStreamIndex = input.audioIndex;
    if (input.subtitleIndex !== undefined && input.subtitleIndex >= 0) body.SubtitleStreamIndex = input.subtitleIndex;
    return body;
  }

  /** The two session events the player sends: 开场 once, 结束时最后一次. Nothing is written while the film
   *  runs, so the stopped call is the only answer to "where did it stop" and it reports whether the server
   *  took it — a card patched from a refused write would be corrected by the next re-read and look broken. */
  async session(input: ProgressInput, event: 'start' | 'stopped'): Promise<boolean> {
    const path = event === 'start' ? '/Sessions/Playing' : '/Sessions/Playing/Stopped';
    const body = { ...this.progressBody(input), EventName: event === 'start' ? 'FirstPlay' : undefined };
    return this.post(path, body, {}, 8000)
      .then(() => true)
      .catch(e => {
        // A refusal used to end here as a bare `false`, so the one write that decides 看到 could fail with
        // no record of the item, the number or the answer. The caller still gets the boolean it patches cards
        // from; this line is only for whoever has to tell 服务器没收 from 没什么可写 afterwards.
        console.warn('[emby] session 没写出去', event, `item=${input.itemId}`, `pos=${Math.round(input.positionMs)}`, `len=${Math.round(input.durationMs)}`, why(e));
        return false;
      });
  }

  async markPlayed(itemId: string): Promise<boolean> {
    const path = `/Users/${this.account.userId}/PlayedItems/${itemId}`;
    return this.post(path)
      .then(() => true)
      .catch(e => {
        console.warn('[emby] 已播放没写出去', why(e));
        return false;
      });
  }

  /** Returns the state after the toggle so the caller can render it without a refetch. */
  async setFavorite(itemId: string, on: boolean): Promise<boolean> {
    const path = `/Users/${this.account.userId}/FavoriteItems/${itemId}`;
    if (on) await this.post(path);
    else await this.del(path);
    return on;
  }
}
