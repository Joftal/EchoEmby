import { net } from 'electron';
import { createHash } from 'node:crypto';

/**
 * 弹弹play 的开放弹幕接口.
 *
 * Every call takes the endpoint it should go to, because the list of endpoints is the viewer's now
 * (设置 → 弹幕 → 弹幕接口). The official service is only the default row: a mirror that speaks the same
 * /api/v2 protocol can be typed in and the app will use it instead. Calls to the official host are signed
 * with this app's own credentials — `base64(sha256(AppId + timestamp + path + AppSecret))`, covering the
 * path alone and never the query string — while a host the viewer typed gets no signature at all, so the
 * app's key is never handed to a stranger. The service meters the key per app, which is why answers are
 * cached for a week in `./index.ts` rather than asked again every time a drawer opens.
 *
 * Every function answers `null` for 「没有答到」 — a timeout, a 5xx, a 429 — which the caller must not
 * remember as 「没有弹幕」. An empty array is a real answer.
 */

const APP_ID = 'zewe3jdh59';
const APP_SECRET = 'TbWwgn7MRzruLVbGCghqwbcAC3XmtexX';

/** The row 设置 ships with, and the only host that gets the built-in credentials. */
export const OFFICIAL_URL = 'https://api.dandanplay.net';

/** One endpoint as the settings list stores it; `name` is a label and never reaches this module. */
export interface ApiSource {
  url: string;
  /** Per-request ceiling in ms; the walk lowers it when the list has already spent most of its budget. */
  timeoutMs?: number;
}

export const appId = APP_ID;

/** Trailing slashes would double up in every joined path, and a bare host is not an endpoint. */
export function normalizeBase(url: string): string {
  return String(url || '').trim().replace(/\/+$/, '');
}

function creds(base: string): { id: string; secret: string } | null {
  return /^https?:\/\/([a-z0-9-]+\.)*dandanplay\.(net|com)(:\d+)?(\/|$)/i.test(base) ? { id: APP_ID, secret: APP_SECRET } : null;
}

const signed = (base: string, path: string): Record<string, string> => {
  const c = creds(base);
  if (!c) return {};
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHash('sha256').update(c.id + ts + path + c.secret).digest('base64');
  return { 'X-AppId': c.id, 'X-Timestamp': String(ts), 'X-Signature': sig };
};

function urlOf(base: string, path: string, query: Record<string, string | number | undefined>): string {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `${base}${path}${qs ? `?${qs}` : ''}`;
}

interface Envelope {
  success?: boolean;
  errorCode?: number;
  errorMessage?: string;
}

interface Attempt {
  status: number;
  text: string;
  /** Set when the request never got an answer: the transport's own words, or empty for our own deadline. */
  error?: string;
  /** The service's own cool-off, when it sent one (`Retry-After`, in ms). Only 429 carries it. */
  retryMs?: number;
}

/**
 * Why the last call came back empty, so a screen can say 「配额用完了」 instead of 「没有弹幕」.
 *
 * The official service meters the built-in AppId per day and answers 429 once the meter is empty — through the
 * status line, or (measured 2026-10-30) as HTTP 200 with `errorCode: 429` in the body and a `Retry-After`
 * measured in hours. Either way nothing was asked of a title, and treating it as 「this work has no comments」
 * would cache that lie for a day.
 */
export interface ApiFailure {
  kind: 'quota' | 'auth' | 'net' | 'http';
  status?: number;
  /** How long the service asked us to wait, when it said. */
  retryMs?: number;
}

let failure: ApiFailure | null = null;

/** The last refusal. One lookup walks its rows one after another, so the last one seen is the one worth
 *  showing; `clearFailure()` runs before a fresh ask so an old refusal cannot outlive its cause. */
export const lastFailure = (): ApiFailure | null => failure;
export const clearFailure = (): void => {
  failure = null;
};

const sawQuota = (retryMs?: number): void => {
  failure = { kind: 'quota', status: 429, retryMs };
};

/**
 * One round trip with a hard ceiling, enforced by racing the whole fetch-plus-body pipeline.
 *
 * `AbortController` alone is not enough here: against a blackholed address the network stack sits in connect
 * and never looks at the signal (measured 2026-10-30 against 10.255.255.1 — still pending after 40 s), which
 * would leave 设置 → 测试 spinning and the player's lookup waiting behind it. The abandoned request keeps
 * running; its answer is simply not wanted any more, and the signal still asks the stack to give up.
 */
async function attempt(url: string, headers: Record<string, string>, ms: number, init?: { method: string; body?: unknown }): Promise<Attempt | null> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<null>(resolve => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve(null);
    }, ms);
  });
  const work = (async (): Promise<Attempt> => {
    const res = await net.fetch(url, {
      method: init?.method || 'GET',
      headers,
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal,
    });
    // `Retry-After` is the only header worth carrying out of here: it is the service saying how long the
    // meter stays empty, which is the difference between 「稍后再试」 and 「明天再试」.
    const after = Number(res.headers.get('retry-after'));
    const retryMs = Number.isFinite(after) && after > 0 ? after * 1000 : undefined;
    return { status: res.status, text: await res.text(), ...(retryMs ? { retryMs } : {}) };
  })().catch((e: unknown) => ({ status: 0, text: '', error: String((e as Error)?.message || e || '连接失败').slice(0, 160) }));
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const callHeaders = (base: string, path: string, json: boolean): Record<string, string> => ({
  Accept: 'application/json',
  // The service asks clients to say who they are; a bare UA is throttled less politely.
  'User-Agent': 'EchoEmby/0.2 (desktop client; dandanplay open api)',
  ...(json ? { 'Content-Type': 'application/json' } : {}),
  ...signed(base, path),
});

const timeoutOf = (src: ApiSource): number => (src.timeoutMs && src.timeoutMs > 0 ? src.timeoutMs : 20_000);

/** One signed round trip. A 200 carrying `success:false` is a refusal, not an answer, and reads as null. */
async function call<T>(src: ApiSource, path: string, query: Record<string, string | number | undefined> = {}, init?: { method: string; body?: unknown }): Promise<T | null> {
  const base = normalizeBase(src.url);
  if (!base) return null;
  const got = await attempt(urlOf(base, path, query), callHeaders(base, path, !!init?.body), timeoutOf(src), init);
  if (!got || !got.status) {
    failure = { kind: 'net' };
    return null;
  }
  if (got.status === 429) {
    sawQuota(got.retryMs);
    return null;
  }
  if (got.status === 401 || got.status === 403) {
    failure = { kind: 'auth', status: got.status };
    return null;
  }
  if (got.status >= 500) {
    failure = { kind: 'http', status: got.status };
    return null;
  }
  let parsed: (T & Envelope) | null = null;
  try {
    parsed = JSON.parse(got.text) as T & Envelope;
  } catch {
    failure = { kind: 'http', status: got.status };
    return null;
  }
  if (!parsed) {
    failure = { kind: 'http', status: got.status };
    return null;
  }
  // A refusal can arrive inside a 200: the service reports its own meter that way today.
  if (parsed.success === false) {
    if (parsed.errorCode === 429) sawQuota(got.retryMs);
    else failure = { kind: 'http', status: parsed.errorCode };
    return null;
  }
  return parsed;
}

export interface ApiEpisode {
  episodeId: number;
  episodeTitle?: string;
}

export interface ApiAnime {
  animeId: number;
  animeTitle?: string;
  type?: string;
  typeDescription?: string;
  imageUrl?: string;
  startDate?: string;
  episodeCount?: number;
  rating?: number;
  episodes?: ApiEpisode[];
}

/** 按标题/集数找作品. `episode` keeps only the rows for that episode, which is what a 「正在播第 3 集」 asks. */
export async function searchEpisodes(src: ApiSource, q: { anime?: string; tmdbId?: number; tmdbType?: 0 | 1; episode?: string }): Promise<ApiAnime[] | null> {
  const j = await call<{ animes?: ApiAnime[] }>(src, '/api/v2/search/episodes', {
    anime: q.anime,
    tmdbId: q.tmdbId,
    tmdbIdType: q.tmdbId ? (q.tmdbType ?? 0) : undefined,
    episode: q.episode,
  });
  if (!j) return null;
  return Array.isArray(j.animes) ? j.animes : [];
}

/** 搜作品列表, for the manual link's search box: year, poster and episode count all come back here. */
export async function searchAnime(src: ApiSource, keyword: string): Promise<ApiAnime[] | null> {
  const j = await call<{ animes?: ApiAnime[] }>(src, '/api/v2/search/anime', { keyword });
  if (!j) return null;
  return Array.isArray(j.animes) ? j.animes : [];
}

export interface ApiMatch {
  episodeId: number;
  animeId: number;
  animeTitle?: string;
  episodeTitle?: string;
  type?: string;
  typeDescription?: string;
  /** Seconds the source says its comments are offset by; negative means they run early. */
  shift?: number;
  imageUrl?: string;
}

/**
 * 按文件名匹配. The documented hash is the MD5 of the file's first 16MB, which would mean pulling those bytes
 * off the gateway every time a film starts; the name alone is enough to offer a list (measured: an exact
 * filename matched its show, and a made-up hash matched nothing but still returned the candidates), so the
 * hash rides along as zeros and `isMatched` is never trusted.
 */
export async function matchFile(src: ApiSource, fileName: string): Promise<ApiMatch[] | null> {
  const j = await call<{ matches?: ApiMatch[] }>(src, '/api/v2/match', {}, {
    method: 'POST',
    body: { fileName, fileHash: '0'.repeat(32), fileSize: 1, videoDuration: 0, matchMode: 'hashAndFileName' },
  });
  if (!j) return null;
  return Array.isArray(j.matches) ? j.matches : [];
}

export interface ApiCommentRow {
  cid?: number;
  p?: string;
  m?: string;
}

export interface ApiCommentPage {
  rows: ApiCommentRow[];
  /** The service's own total for this episode.
   *
   *  There is no count-only form: the number sits in the same reply as the rows (measured 2026-10-31 on the
   *  mirror — `/api/v2/comment/10005` answers 200 with 208,196 bytes and `count` at the root), so asking for a
   *  number costs exactly one download. That is why the number is cached per episode on its own: the row is
   *  worth showing next to every candidate, and asking again for each open would re-download a whole track. */
  count: number;
}

/** One episode's comments, with the count the drawer prints. 2,300 rows is 178KB and about 800ms, which is why
 *  the parsed list is cached. */
export async function commentPage(src: ApiSource, episodeId: string): Promise<ApiCommentPage | null> {
  const j = await call<{ count?: number; comments?: ApiCommentRow[] }>(src, `/api/v2/comment/${encodeURIComponent(episodeId)}`, {
    withRelated: 'true',
    chConvert: 0,
  });
  if (!j) return null;
  const rows = Array.isArray(j.comments) ? j.comments : [];
  const count = typeof j.count === 'number' && Number.isFinite(j.count) ? j.count : rows.length;
  return { rows, count };
}

export async function comments(src: ApiSource, episodeId: string): Promise<ApiCommentRow[] | null> {
  const page = await commentPage(src, episodeId);
  return page ? page.rows : null;
}

/* ------------------------------------------------------------------ 设置里的「测试」 */

export interface ProbeStep {
  key: string;
  label: string;
  ok: boolean;
  ms: number;
  /** One short line either way: what came back, or why nothing did. */
  detail: string;
}

const nowMs = (): number => Date.now();

/**
 * 打一遍这个接口，逐项说清哪一步通、哪一步不通.
 *
 * The four steps answer the four questions a viewer actually has when a typed address does not work:
 * 能不能连上 / 它认不认这套调用 / 能不能搜到片子 / 能不能把弹幕取回来. Each step reports its own timing,
 * because 「等了三秒才失败」 and 「立刻 403」 are different problems and the reader should not have to guess.
 * Nothing is cached and nothing is written: this is a diagnostic, not a fetch.
 */
export async function probe(src: ApiSource, keyword: string): Promise<ProbeStep[]> {
  const base = normalizeBase(src.url);
  const steps: ProbeStep[] = [];
  const kw = (keyword || '').trim() || '芙莉莲';

  if (!/^https?:\/\/[^\s]+$/i.test(base)) {
    steps.push({ key: 'url', label: '地址', ok: false, ms: 0, detail: '不完整 · 形如 https://api.dandanplay.net' });
    return steps;
  }

  // 1. 连接 + 2. 鉴权: one request answers both, and the status code is the proof.
  const t0 = nowMs();
  const got = await attempt(
    urlOf(base, '/api/v2/search/anime', { keyword: kw }),
    { Accept: 'application/json', 'User-Agent': 'EchoEmby/0.2 (desktop client; dandanplay open api)', ...signed(base, '/api/v2/search/anime') },
    8_000,
  );
  const ms = nowMs() - t0;
  const status = got ? got.status : 0;
  const raw = got ? got.text : '';
  // No answer at all reads the same either way to a user deciding what to do next: nothing came back in time.
  const netError = got ? got.error || '' : '8 秒内没有回话';

  let json: (Record<string, unknown> & Envelope) | null = null;
  try {
    json = raw ? (JSON.parse(raw) as Record<string, unknown> & Envelope) : null;
  } catch {
    json = null;
  }

  // Quota is its own answer: the socket works, the key is spent. Saying 「HTTP 200」 there would send the
  // reader looking for a typo in a URL that is perfectly fine.
  const quota = status === 429 || (!!json && json.errorCode === 429);
  const wait = got?.retryMs ? Math.max(1, Math.round(got.retryMs / 3_600_000)) : 0;
  const quotaText = wait ? `配额已用尽 · 约 ${wait} 小时后恢复` : '配额已用尽 · 明天再试';

  const reachable = !!status && status < 500;
  // The words here are read on a settings screen, not in a log: a code, a time, and one fact — nothing that
  // repeats the step's own label back at the reader.
  steps.push({
    key: 'connect',
    label: '连接',
    ok: reachable,
    ms,
    detail: netError ? netError : `HTTP ${status} · ${ms} ms`,
  });

  const hasCreds = !!creds(base);

  // Nothing below can be asked over a socket that is not there, so the rest say so plainly instead of each
  // one inventing its own reason — 「返回的不是 JSON」 next to a refused connection is just noise.
  if (!reachable) {
    const why = status >= 500 ? '未进行 · 服务端错误' : '未进行 · 连不上';
    steps.push({ key: 'auth', label: '调用', ok: false, ms: 0, detail: why });
    steps.push({ key: 'search', label: '搜索', ok: false, ms: 0, detail: why });
    steps.push({ key: 'comments', label: '弹幕', ok: false, ms: 0, detail: why });
    return steps;
  }
  steps.push({
    key: 'auth',
    label: '调用',
    ok: status === 200 && !quota,
    ms: 0,
    detail: quota
      ? quotaText
      : status === 401 || status === 403
        ? `HTTP ${status} · 被拒绝${hasCreds ? '' : '（自定义地址不带签名）'}`
        : status === 200
          ? hasCreds
            ? '签名通过'
            : '公开接口'
          : status
            ? `HTTP ${status}`
            : '无响应',
  });

  // 3. 搜索: the first thing every later step needs is an animeId.
  const animes = Array.isArray(json?.animes) ? (json!.animes as ApiAnime[]) : null;
  const first = animes && animes.length ? animes[0] : null;
  steps.push({
    key: 'search',
    label: '搜索',
    ok: !!first,
    ms: 0,
    detail: !json
      ? '不是 JSON'
      : quota
        ? '未进行 · 配额已用尽'
        : json.success === false
          ? `被拒绝 · ${json.errorMessage || json.errorCode || '未知原因'}`
        : first
          ? `${animes!.length} 部 · ${first.animeTitle || first.animeId}${first.episodeCount ? `（${first.episodeCount} 集）` : ''}`
          : '无匹配',
  });

  // 4. 取弹幕: the point of the whole thing. `search/anime` answers with works and no episode rows, so the
  //    episode id comes from `search/episodes` — the same call the player makes, which is the point of asking.
  let epId = first?.episodes && first.episodes.length ? first.episodes[0].episodeId : 0;
  if (!epId && first && !quota) {
    const rows = await searchEpisodes({ url: base }, { anime: (first.animeTitle || '').trim() || kw });
    epId = rows?.[0]?.episodes?.[0]?.episodeId || 0;
  }
  if (!epId) {
    steps.push({ key: 'comments', label: '弹幕', ok: false, ms: 0, detail: quota ? '未进行 · 配额已用尽' : '作品没有分集编号，换个关键词再试' });
    return steps;
  }
  const t1 = nowMs();
  const rows = await comments(src, String(epId));
  const ms1 = nowMs() - t1;
  const one = rows && rows.length ? rows[0] : null;
  steps.push({
    key: 'comments',
    label: '弹幕',
    ok: !!rows && rows.length > 0,
    ms: ms1,
    detail: rows === null ? (quota ? '未进行 · 配额已用尽' : `请求失败 · ${ms1} ms`) : rows.length ? `${rows.length} 条 · 首条「${(one?.m || '').slice(0, 20)}」` : '这一集没有弹幕',
  });
  return steps;
}

/* ------------------------------------------------------------------ 弹幕调试 */

/** One verbatim round trip for the debug page: nothing is parsed, cached, retried or remembered. */
export interface ApiReply {
  status: number;
  ms: number;
  bytes: number;
  text: string;
  error?: string;
}

/**
 * 弹幕调试 里「接口调试」用的一次原始请求. `path` goes out exactly as typed (query included), because the
 * point is to see what this endpoint says to a path the viewer chose — with the same headers the app
 * itself sends, so a row that answers here answers in the player too.
 */
export async function raw(base: string, path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, ms = 25_000): Promise<ApiReply> {
  const b = normalizeBase(base);
  const fixed = path.startsWith('/') ? path : '/' + path;
  const started = Date.now();
  const got = await attempt(b + fixed, callHeaders(b, fixed.split('?')[0], body !== undefined), ms, {
    method,
    ...(body !== undefined ? { body } : {}),
  });
  const spent = Date.now() - started;
  if (!got) return { status: 0, ms: spent, bytes: 0, text: '', error: ms + ' 毫秒内没有回话' };
  return { status: got.status, ms: spent, bytes: Buffer.byteLength(got.text, 'utf8'), text: got.text, ...(got.error ? { error: got.error } : {}) };
}
