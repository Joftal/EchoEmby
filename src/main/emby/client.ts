import { net } from 'electron';
import type { Account, FacetOption, LibraryItem, LibraryRow, MediaSourceInfo, MediaStreamInfo, Person, PlaybackResult, Providers, Settings, StudioRef } from '../../shared/types';
import { buildDeviceProfile } from './deviceProfile';

export interface Identity {
  deviceId: string;
  deviceName: string;
  clientName: string;
  clientVersion: string;
  language: string;
}

export class EmbyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
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

const FIELDS =
  'BasicSyncInfo,CanDelete,CanDownload,PrimaryImageAspectRatio,ProductionYear,Status,EndDate,CommunityRating,OfficialRating,Overview,MediaStreams,Container,Bitrate,VideoRange,Width,Height,SeriesName,SeriesId,ParentId,ChildCount,Genres,PremiereDate,Studio,Studios,ProviderIds,OriginalTitle,DateCreated';

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

const mapSources = (raw: any): MediaSourceInfo[] | undefined => {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  return raw.map((s: any): MediaSourceInfo => {
    const streams: MediaStreamInfo[] = (s.MediaStreams || []).map((v: any): MediaStreamInfo => ({
      type: v.Type,
      codec: v.Codec,
      displayTitle: v.DisplayTitle,
      lang: v.Language,
      title: v.Title,
      width: v.Width,
      height: v.Height,
      bitDepth: v.BitDepth,
      range: v.VideoRange || v.VideoRangeType,
      chroma: v.ChromaSubsampling,
      fps: v.NominalFrameRate || v.AverageFrameRate,
      bitRate: v.BitRate,
      channels: v.Channels,
      sampleRate: v.SampleRate,
      profile: v.Profile,
      isDefault: v.IsDefault,
      isForced: v.IsForced,
    }));
    const video = streams.find(x => x.type === 'Video');
    return {
      name: s.Name,
      container: s.Container,
      bitRate: s.Bitrate,
      sizeBytes: s.Size,
      isHls: !!s.IsRemote || s.Container === 'm3u8',
      video,
      audio: streams.filter(x => x.type === 'Audio'),
      subtitle: streams.filter(x => x.type === 'Subtitle'),
    };
  });
};

const mapItem = (r: any): LibraryItem => ({
  id: r.Id,
  type: r.Type,
  name: r.Name,
  originalTitle: r.OriginalTitle,
  seriesName: r.SeriesName,
  productionYear: r.ProductionYear,
  officialRating: r.OfficialRating,
  communityRating: r.CommunityRating,
  genres: r.Genres?.length ? r.Genres.slice(0, 3) : undefined,
  studio: studioName(r),
  studios: mapStudios(r),
  premiereDate: r.PremiereDate,
  overview: r.Overview,
  runTimeTicks: r.RunTimeTicks,
  primaryImageTag: r.ImageTags?.Primary,
  backdropImageTag: r.BackdropImageTags?.[0],
  // Episodes must land on the Series page: this fork answers ParentId with the
  // Season id and only exposes SeriesId when it is requested in Fields.
  parentId: r.SeriesId || r.ParentId,
  indexNumber: r.IndexNumber,
  parentIndexNumber: r.ParentIndexNumber,
  childCount: r.ChildCount,
  userData: r.UserData
    ? { playedPercentage: r.UserData.PlayedPercentage, isFavorite: r.UserData.IsFavorite }
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

export class EmbyClient {
  constructor(
    private readonly account: Account,
    private readonly identity: Identity,
    private readonly settings: Settings,
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
    if (!res.ok) throw new EmbyError(text.slice(0, 200) || res.statusText, res.status);
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
    if (!res.ok) throw new EmbyError(text.slice(0, 200) || res.statusText, res.status);
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
    if (!res.ok) throw new EmbyError(text.slice(0, 200) || res.statusText, res.status);
    return text ? JSON.parse(text) : ({} as T);
  }

  async serverName(): Promise<string> {
    const j = await this.get<any>('/System/Info/Public', {}, 8000);
    return j?.ServerName || '';
  }

  async views(): Promise<LibraryItem[]> {
    const j = await this.get<any>(`/Users/${this.account.userId}/Views`, { GroupByCollectionType: true });
    return (j.Items || []).map(mapItem);
  }

  /**
   * Neither server answers Views with ItemCount, so the totals come from a
   * one-item page of each type: the answer only needs TotalRecordCount.
   */
  async counts(): Promise<{ movies: number; series: number }> {
    const total = async (type: string) => {
      const j = await this.get<any>(`/Users/${this.account.userId}/Items`, { IncludeItemTypes: type, Recursive: true, Limit: 1 }, 12000);
      return Number(j?.TotalRecordCount) || 0;
    };
    const [movies, series] = await Promise.all([total('Movie'), total('Series')]);
    return { movies, series };
  }

  async items(params: Record<string, string | number | boolean | undefined>): Promise<LibraryItem[]> {
    const j = await this.get<any>(`/Users/${this.account.userId}/Items`, { Fields: FIELDS, ImageTypeLimit: 1, EnableImageTypes: 'Primary,Backdrop,Thumb', ...params });
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

  /** Latest answers with the series itself, so the episode position has to come from a parallel pass. */
  private async newestEpisodes(parentId: string): Promise<Map<string, LibraryItem>> {
    const eps = await this.items({
      ParentId: parentId,
      Recursive: true,
      IncludeItemTypes: 'Episode',
      SortBy: 'DateCreated',
      SortOrder: 'Descending',
      Limit: 400,
      Fields: 'SeriesId,IndexNumber,ParentIndexNumber',
    }).catch(() => []);
    const m = new Map<string, LibraryItem>();
    for (const e of eps) if (e.parentId && !m.has(e.parentId)) m.set(e.parentId, e);
    return m;
  }

  async homeRows(): Promise<LibraryRow[]> {
    const views = await this.views();
    const raw = await this.items({ Recursive: true, MediaTypes: 'Video', SortBy: 'DatePlayed', SortOrder: 'Descending', Limit: 18, IsResumable: true });
    // The row is newest-played first, so the first card per series is the episode to resume.
    const seen = new Set<string>();
    const resume = raw.filter(x => {
      const key = x.seriesName ? x.parentId || x.seriesName : x.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const rows: LibraryRow[] = [];
    if (resume.length) rows.push({ key: 'resume', title: '继续观看', items: resume });
    const latest = await Promise.all(
      views.slice(0, 8).map(async v => {
        const [items, newest] = await Promise.all([
          this.get<any>(`/Users/${this.account.userId}/Items/Latest`, { ParentId: v.id, Limit: 18, Fields: FIELDS, ImageTypeLimit: 1, EnableImageTypes: 'Primary,Backdrop' })
            .then(j => (j || []).map(mapItem))
            .catch(() => []),
          this.newestEpisodes(v.id),
        ]);
        for (const it of items) {
          const e = it.type === 'Series' ? newest.get(it.id) : undefined;
          if (e?.indexNumber != null) it.latestEpisode = { season: e.parentIndexNumber, episode: e.indexNumber };
        }
        return { key: `latest-${v.id}`, title: `新加入 · ${v.name}`, items };
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

  async playbackInfo(itemId: string): Promise<PlaybackResult> {
    const profile = buildDeviceProfile(this.settings);
    const j = await this.post<any>(`/Items/${itemId}/PlaybackInfo`, { DeviceProfile: profile, ...profile, MaxStreamingBitrate: this.settings.maxStreamingBitrate }, { UserId: this.account.userId, StartTimeTicks: 0, AutoOpenTrueHD: true, EnableTranscoding: true });
    const ms = (j.MediaSources || [])[0];
    if (!ms) throw new EmbyError('这个条目没有可用的播放源', 502);
    const q = authQuery(this.identity);
    q.set('static', 'true');
    q.set('MediaSourceId', ms.Id);
    q.set('api_key', this.account.accessToken);
    const direct = ms.SupportsDirectPlay || ms.SupportsDirectStream;
    // This fork omits MediaSources[].PlayMethod, so derive it from the flags.
    const playMethod: string = ms.PlayMethod || (ms.SupportsDirectPlay ? 'DirectPlay' : direct ? 'DirectStream' : 'Transcode');
    return {
      mediaSourceId: ms.Id,
      name: ms.Name || j.Name || '',
      playSessionId: j.PlaySessionId || '',
      playMethod,
      directUrl: direct ? `${this.base}/videos/${itemId}/stream?${q}` : `${this.base}/videos/${itemId}/main.m3u8?${q}`,
    };
  }

  /** Resumable start offset plus the display name; PlaybackInfo only labels the
   *  media source ("2160p"), so the title has to come from the item itself. */
  async resumePoint(itemId: string): Promise<{ name: string; startMs: number }> {
    const j = await this.get<any>(`/Users/${this.account.userId}/Items/${itemId}`, { Fields: 'UserData' });
    return { name: j?.Name || '', startMs: Math.round((j?.UserData?.StartPositionTicks || 0) / 1e4) };
  }

  async reportProgress(itemId: string, mediaSourceId: string, playSessionId: string, positionMs: number, durationMs: number, paused: boolean): Promise<void> {
    await this.post(
      '/Sessions/Playing/Progress',
      {
        ItemId: itemId,
        MediaSourceId: mediaSourceId,
        PlaySessionId: playSessionId,
        PositionTicks: Math.round(positionMs * 1e4),
        RuntimeTicks: Math.round(durationMs * 1e4),
        IsPaused: paused,
        CanSeek: true,
        PlaybackRate: 1,
        AudioStreamIndex: 0,
        VideoStreamIndex: 0,
      },
      {},
      8000,
    ).catch(() => undefined);
  }

  async markPlayed(itemId: string): Promise<void> {
    await this.post(`/Users/${this.account.userId}/PlayedItems/${itemId}`).catch(() => undefined);
  }

  /** Returns the state after the toggle so the caller can render it without a refetch. */
  async setFavorite(itemId: string, on: boolean): Promise<boolean> {
    const path = `/Users/${this.account.userId}/FavoriteItems/${itemId}`;
    if (on) await this.post(path);
    else await this.del(path);
    return on;
  }
}
