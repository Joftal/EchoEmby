import { app, net } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as config from '../config';
import type { DanmakuComment, DanmakuQuery, DanmakuSettings, DanmakuTrack, DanmakuTrackInfo } from '../../shared/types';

/**
 * 弹幕: comments fetched by title and cached on disk.
 *
 * Two sources, asked the same question in different shapes:
 *  - Bilibili, which needs no key. Its search answers with *seasons*, while danmaku files are stored per
 *    episode under an `oid`, so a season is expanded through the PGC view before anything is offered.
 *  - any dandanplay-compatible service, self-hosted or not, whose episode search gives one row per episode
 *    and whose comment endpoint answers with a JSON list. Its API key rides as a query parameter because
 *    that is what those deployments expect; it is never logged and never crosses the IPC bridge.
 *
 * A recorded `missing` marker is what makes 「这部没有弹幕」 stick, so reopening a season does not re-ask.
 * A transport failure is the case that must NOT be recorded, or a bad afternoon freezes into a permanent
 * no — the same rule the metadata sources in `meta/` follow.
 */

const DAY = 86_400_000;
const HIT_TTL = 7 * DAY;
const MISS_TTL = DAY;

interface Cached<T> {
  value: T;
  fetchedAt: number;
}
type Miss = { missing: true; fetchedAt: number };

interface Store {
  /** key = `${itemId}:${trackId}`; the parsed, filtered, sorted comment list. */
  tracks: Record<string, Cached<DanmakuTrack>>;
  /** key = `${itemId}:${ask}`; the candidate list for one item's title. */
  matches: Record<string, Cached<DanmakuTrackInfo[]> | Miss>;
}

const file = () => path.join(app.getPath('userData'), 'danmaku.json');
let store: Store | null = null;

const load = (): Store => {
  if (store) return store;
  let next: Store;
  try {
    next = { tracks: {}, matches: {}, ...JSON.parse(readFileSync(file(), 'utf8')) };
  } catch {
    next = { tracks: {}, matches: {} };
  }
  store = next;
  return next;
};

const persist = (): void => {
  try {
    mkdirSync(path.dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify(load()), 'utf8');
  } catch {
    // A cache that cannot be written only costs a refetch on the next open.
  }
};

const fresh = (hit: Cached<unknown> | Miss | undefined): boolean => !!hit && Date.now() - hit.fetchedAt < ('missing' in hit ? MISS_TTL : HIT_TTL);

const text = async (url: string, headers: Record<string, string>, timeoutMs = 12000): Promise<string | null> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, {
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'EchoEmby/0.2 (desktop client; danmaku lookup)', ...headers },
      signal: ctrl.signal,
    });
    // 5xx is the source's bad day, not an answer: null, so nothing is cached.
    if (res.status >= 500 || res.status === 412 || res.status === 403) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const json = <T,>(raw: string | null): T | null => {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

/** What to ask a source about. An episode's own title is often 「第 3 集」, which matches nothing, so a
 *  series with a known name is asked first and the episode's own title only as a second try. */
const names = (q: DanmakuQuery): string[] => {
  const out: string[] = [];
  const series = (q.seriesName || '').trim();
  if (series) out.push(series);
  const own = (q.title || '').trim();
  if (own && own !== series) out.push(own);
  return out;
};

const stripTags = (s: string): string => s.replace(/<[^>]*>/g, '');

/** Bilibili's search is cookie-gated: an unwarmed client gets 412. The nav endpoint is public, needs no
 *  login and hands out the `buvid3` cookie the search then expects, and net.fetch shares the default
 *  session's jar, so one call per cold start is enough. */
const warmBilibili = async (): Promise<void> => {
  await text('https://api.bilibili.com/x/web-interface/nav', { Referer: 'https://www.bilibili.com/' }, 6000);
};

interface BiliSeason {
  season_id?: number;
  media_id?: number;
  id?: number;
  title?: string;
  new_desc?: string;
}

/** One season's episodes, which is where danmaku actually lives. */
const biliEpisodes = async (seasonId: number, seasonTitle: string): Promise<DanmakuTrackInfo[]> => {
  const j = json<any>(await text(`https://api.bilibili.com/pgc/view/web/season?season_id=${seasonId}`, { Referer: 'https://www.bilibili.com/' }));
  const list: any[] = Array.isArray(j?.result?.episodes) ? j.result.episodes : [];
  return list
    .map((e, i): DanmakuTrackInfo | null => {
      // Measured: the danmaku file is keyed by the episode's `cid`. Asking with the PGC `id` answers with a
      // well-formed XML that simply has no rows in it, which reads as 「这部没有弹幕」 for a show that has 3600.
      const oid = Number(e?.cid ?? e?.id ?? e?.aid);
      if (!Number.isFinite(oid) || oid <= 0) return null;
      const part = stripTags(String(e?.long_title || e?.section?.title || e?.index || '')).trim();
      const n = e?.ep != null ? Number(e.ep) : i + 1;
      return { id: String(oid), title: `${seasonTitle} · 第 ${n} 集${part ? ` ${part}` : ''}` };
    })
    .filter(Boolean) as DanmakuTrackInfo[];
};

const searchBilibili = async (q: DanmakuQuery, mode: number): Promise<DanmakuTrackInfo[] | null> => {
  await warmBilibili();
  for (const name of names(q)) {
    const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=media_bangumi&keyword=${encodeURIComponent(name)}`;
    const j = json<any>(await text(url, { Referer: 'https://search.bilibili.com/' }));
    // null is 「没有答到」 - a 412 or a timeout - and must not be remembered as 「这部没有弹幕」。
    if (j === null) return null;
    const rows: BiliSeason[] = Array.isArray(j?.data?.result) ? j.data.result : [];
    for (const r of rows.slice(0, 3)) {
      const title = stripTags(String(r.title || '')).trim();
      if (!title) continue;
      if (mode === 1 && title !== name) continue;
      const seasonId = Number(r.season_id ?? r.media_id ?? r.id);
      if (!Number.isFinite(seasonId) || seasonId <= 0) continue;
      const eps = await biliEpisodes(seasonId, title);
      if (!eps.length) continue;
      // When the library knows which episode this is, that row goes first: the menu opens on the one the
      // user is watching rather than on 第 1 集 of the season it found.
      if (q.episode != null) {
        const i = eps.findIndex(e => e.title.includes(`第 ${q.episode} 集`));
        if (i > 0) eps.unshift(...eps.splice(i, 1));
      }
      return eps;
    }
  }
  return [];
};

interface DandanRow {
  id?: number | string;
  episodeTitle?: string;
  animeTitle?: string;
  episodeNumber?: number | string;
}

const searchDandan = async (cfg: DanmakuSettings, q: DanmakuQuery): Promise<DanmakuTrackInfo[] | null> => {
  const base = cfg.source.url.replace(/\/+$/, '');
  if (!base) return [];
  const headers: Record<string, string> = cfg.source.token ? { 'X-Session-Token': cfg.source.token } : {};
  for (const name of names(q)) {
    const url = `${base}/api/v2/search/episodes?anime=${encodeURIComponent(name)}&withRelated=true`;
    const j = json<any>(await text(url, headers));
    if (j === null) return null;
    const animes: any[] = Array.isArray(j?.animes) ? j.animes : [];
    const out: DanmakuTrackInfo[] = [];
    for (const a of animes) {
      const animeTitle = String(a?.animeTitle || name);
      const eps: DandanRow[] = Array.isArray(a?.episodes) ? a.episodes : [];
      for (const e of eps) {
        if (e?.id == null) continue;
        const own = String(e.episodeTitle || '');
        if (cfg.matchMode === 1 && own.trim() !== name.trim()) continue;
        out.push({ id: String(e.id), title: own ? `${animeTitle} · ${own}` : animeTitle });
      }
    }
    if (!out.length) continue;
    if (q.episode != null) {
      const want = Number(q.episode);
      const i = out.findIndex((_, k) => Number((epsFlat(animes)[k] as DandanRow)?.episodeNumber) === want);
      if (i > 0) out.unshift(...out.splice(i, 1));
    }
    return out;
  }
  return [];
};

/** The same flattened rows the search loop just built its list from, so an episode number can be matched
 *  back to the option it belongs to without a second pass over the answer. */
const epsFlat = (animes: any[]): DandanRow[] => animes.flatMap(a => (Array.isArray(a?.episodes) ? a.episodes : []));

/** The candidates for one item. An empty list is a normal answer and gets remembered as one; null is
 *  「源没有答」, which the caller must not present as 「这部没有弹幕」. */
export async function search(q: DanmakuQuery): Promise<DanmakuTrackInfo[] | null> {
  const cfg = config.get().settings.danmaku;
  if (!cfg.enabled) return [];
  const key = `${q.itemId}:${q.title}`;
  const hit = load().matches[key];
  if (fresh(hit)) return hit && 'value' in hit ? hit.value : [];

  const list = await (cfg.source.type === 'bilibili' ? searchBilibili(q, cfg.matchMode) : searchDandan(cfg, q));
  const s = load();
  // A source that never answered is not an answer: return nothing, cache nothing, and let the next open
  // ask again. Only a real reply with no rows in it becomes 「这部没有弹幕」.
  if (list === null) return null;
  if (!list.length) {
    if (s.matches[key] === undefined || !('value' in s.matches[key])) {
      s.matches[key] = { missing: true, fetchedAt: Date.now() };
      persist();
    }
    return [];
  }
  s.matches[key] = { value: list, fetchedAt: Date.now() };
  persist();
  return list;
}

/** One row of either file format: `p` is a comma list whose first field is the time in seconds and whose
 *  second is the lane code (5 pinned top, 4 pinned bottom, anything else scrolls). Bilibili's XML puts it
 *  in an attribute, the dandanplay API in a string field — the parsing is the same either way. */
const parseRow = (p: string, body: string): DanmakuComment | null => {
  const f = p.split(',');
  const t = Number(f[0]);
  const text = body.trim();
  if (!Number.isFinite(t) || !text) return null;
  const mode = f[1] === '5' ? 'top' : f[1] === '4' ? 'bottom' : 'scroll';
  const color = f[3] && /^\d+$/.test(f[3]) ? `#${(Number(f[3]) & 0xffffff).toString(16).padStart(6, '0')}` : '#ffffff';
  return { timeSec: t, text, color, mode };
};

const XML_ROW = /<d\s+p="([^"]+)"[^>]*>([\s\S]*?)<\/d>/g;

const unescape = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const parseXml = (xml: string): DanmakuComment[] => {
  const out: DanmakuComment[] = [];
  let m: RegExpExecArray | null;
  while ((m = XML_ROW.exec(xml))) {
    const c = parseRow(m[1], unescape(m[2]));
    if (c) out.push(c);
  }
  return out;
};

const parseJson = (raw: unknown): DanmakuComment[] => {
  const list: any[] = Array.isArray((raw as any)?.comments) ? (raw as any).comments : Array.isArray((raw as any)?.danmaku) ? (raw as any).danmaku : [];
  const out: DanmakuComment[] = [];
  for (const c of list) {
    // `p` is the timing string and `m` the text. Reading either as the other is how a comment list turns
    // into a list of numbers.
    const row = parseRow(String(c?.p ?? ''), typeof c?.m === 'string' ? c.m : typeof c?.text === 'string' ? c.text : '');
    if (row) out.push(row);
  }
  return out;
};

const applyFilters = (comments: DanmakuComment[], cfg: DanmakuSettings): DanmakuComment[] => {
  const blocked = cfg.blockedWords.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
  let out = comments.filter(c => c.text && Number.isFinite(c.timeSec) && c.timeSec >= 0);
  if (blocked.length) out = out.filter(c => !blocked.some(w => c.text.includes(w)));
  return out.sort((a, b) => a.timeSec - b.timeSec);
};

/** One source's comments for one candidate track, parsed, filtered and sorted. Null means the source had
 *  nothing to say, which the caller shows as 「这条没有弹幕」 rather than as a failure. */
export async function fetchTrack(q: DanmakuQuery, trackId: string): Promise<DanmakuTrack | null> {
  const cfg = config.get().settings.danmaku;
  if (!cfg.enabled) return null;
  const key = `${q.itemId}:${trackId}`;
  const hit = load().tracks[key];
  if (hit && fresh(hit)) return hit.value;

  let comments: DanmakuComment[] = [];
  if (cfg.source.type === 'bilibili') {
    const xml = await text(`https://comment.bilibili.com/${encodeURIComponent(trackId)}.xml`, { Referer: 'https://www.bilibili.com/' });
    if (xml === null) return null;
    comments = parseXml(xml);
  } else {
    const base = cfg.source.url.replace(/\/+$/, '');
    if (!base) return null;
    const headers: Record<string, string> = cfg.source.token ? { 'X-Session-Token': cfg.source.token } : {};
    const j = json<any>(await text(`${base}/api/v2/comment/${encodeURIComponent(trackId)}?withRelated=true`, headers));
    if (j === null) return null;
    // Some deployments answer with the list nested under a JSON *string* in `danmaku`, so a second parse
    // is tried before the row list is called empty.
    comments = parseJson(j?.danmaku && typeof j.danmaku === 'string' ? json(j.danmaku) : j);
  }

  comments = applyFilters(comments, cfg);
  if (!comments.length) return null;
  const match = load().matches[`${q.itemId}:${q.title}`];
  const title = match && 'value' in match ? match.value.find(t => t.id === trackId)?.title || trackId : trackId;
  const out: DanmakuTrack = { id: trackId, title, comments, fetchedAt: Date.now() };
  load().tracks[key] = { value: out, fetchedAt: Date.now() };
  persist();
  return out;
}

/** The cached track only: the overlay asks this on open so a replay does not wait on the network, and a
 *  miss is not an error — it just means the menu has not been used yet. */
export function cachedTrack(q: DanmakuQuery, trackId: string): DanmakuTrack | null {
  const hit = load().tracks[`${q.itemId}:${trackId}`];
  return hit && fresh(hit) ? hit.value : null;
}
