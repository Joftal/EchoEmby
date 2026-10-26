import { app, net } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as config from '../config';
import type { EmbyClient } from '../emby/client';
import { fetchJson } from './tmdb';
import type { CalendarPool, CalendarQuiet, CalendarResult, CalendarSlot, LibraryItem } from '../../shared/types';

/**
 * 追剧日历 — which of the shows this account follows has an episode coming, and on which day.
 *
 * Three layers, each from the one source that can actually answer it (all measured 2026-10-25 over
 * both gateways, and the numbers are in the comments where they decide something):
 *   名单  the server, for free: `SeriesStatus=Continuing` narrows 2487→641 / 1660→632 rows in one ask,
 *         and the row keeps its `ProviderIds.Tmdb`, so no title has to be guessed from a Chinese name.
 *   日期  TMDB. A work's own reply carries `next_episode_to_air`, and the season reply underneath it
 *         carries every episode's `air_date` — which is the only future a surface here can print,
 *         because the server dates nothing ahead of today (measured: 爱情公寓 answers 124/124 episode
 *         rows with a `PremiereDate` and zero of them at or after today). Those same two replies hand
 *         the card its year, genres, poster and season size, so nothing the day timeline prints costs a
 *         request beyond the pair.
 *   时刻  Bilibili's week schedule, when it names the title: `pub_ts` gives minute precision.
 *
 * What is deliberately *not* here: Trakt's calendars (its whole 7-day schedule names 4-6% of this
 * library's continuing shows) and the server's `Status` field as a verdict (one show's three Series
 * rows answered 1×`Ended` and 2×`Continuing` — it is a pre-filter, and TMDB's own `status` is what the page
 * prints 「已完结」 from).
 *
 * An answer is three lists, and the third is the one that keeps an empty page honest: the dated episodes,
 * the names TMDB did not answer for, and the followed shows it has put no day on (measured: 13 of the 22
 * titles this account follows land there — 3 finished their season before the page's past cut, 10 have a
 * `last_episode_to_air` and no `next` one, and 5 of the whole 13 are shows TMDB itself calls finished). A
 * reader who stars a show and sees nothing has to be told which of those it is, because 「nothing is
 * coming」 and 「this page lost my shows」 look identical otherwise — and 「未排期」 is the wrong answer for
 * the 10 that have a date, so this list is dated off the work reply rather than off the clipped one.
 *
 * The cache is its own file, `calendar.json`, and it is written once per answer rather than once per
 * entry: `tmdb.json` is 3 MB and its `persist()` rewrites the whole thing for a single key, so a
 * calendar that shares that file would pay 30 full rewrites to build one month.
 */

const DAY = 86_400_000;
/** A schedule drifts — a date slips, a season finally starts — so three days, not the 30 the synopsis
 *  gets. The cost of expiring is one pair of requests per show, and only for the shows on this page. */
const SERIES_TTL = 3 * DAY;
/** Bilibili's schedule cannot be asked for a month (its `day=` and `month=` are ignored — three calls
 *  for this week, next week and October came back byte-identical), so it is re-read twice a day and
 *  always read as "the week it happens to be serving". */
const BILI_TTL = 12 * 3600_000;
/** Days kept on either side of today, on the page and in the cache. A season of a long-running show numbers
 *  200 episodes (凡人修仙传 S1 answers 197+) and only the band a reader can scroll to is worth their bytes. */
const WINDOW_DAYS = 90;
/** What the cache holds is the page's band widened by the longest an entry may be reused: the stored dates
 *  are clipped against the day they were fetched, so an entry a third of its TTL old would otherwise lose
 *  the last third of the tail the page promises. Reading clips to the asked days anyway. */
const STORE_PAD = SERIES_TTL;
/** TMDB is reached through the system proxy and one season reply is ~29 KB: measured 0.84-1.28 s each,
 *  so three at a time puts a 15-show month on screen in single-figure seconds rather than 20. */
const CONCURRENCY = 3;
/** The roster asks are wide but cheap: 641 rows asked with `ProviderIds` alone. */
const ROSTER_LIMIT = 4000;

/** Bumped when a cached field changes *meaning*, which is how the 追剧日历 card got the year and the
 *  genres it did not store for the first 22 titles. Dropping a field needs no bump: an extra key sitting
 *  in an old entry is simply never read, and a bump would cost 44 pairs of requests to save bytes.
 *  The 韩语 pool is a meaning change and does need one: `pool` is stored per entry while the language it
 *  was derived from is not, so the three Korean titles already on disk would keep answering to 其他 until
 *  each one's own three-day TTL expired. Measured cost of the drop: 22 titles × 2 requests, one open in
 *  6.98 s — the same price the 刷新 button charges.
 *  `lastAir`, `status` and `airedBefore` deliberately do *not* bump it, even though `lastDate` reads a new
 *  meaning off the first two: an entry without them answers `''` / `false` / `0`, which is exactly what the
 *  page printed before they existed, so the 3-day TTL upgrades the wording instead of a mass refetch. */
const SCHEMA = 3;

interface SlotRow {
  date: string;
  episode: number;
  name: string;
}

interface SeriesEntry {
  fetchedAt: number;
  name: string;
  poster: string;
  pool: CalendarPool;
  season: number;
  /** The year the show began, TMDB's `first_air_date` cut to four digits, 0 when it never aired. */
  year: number;
  /** TMDB's own genre names for the work, already localised to 中文 by the `language=zh-CN` ask. */
  genres: string[];
  /** How many episodes this season holds, so 「集 4/12」 can be drawn as a bar as well as read as a pair.
   *  0 when the season reply did not come, and also when nothing of this season has aired yet — see
   *  `airedBefore`, which is what keeps a one-episode-ahead schedule off the card as 「集 1/1」. */
  seasonTotal: number;
  /** How many episodes of this season TMDB had already dated at or before the day this entry was fetched.
   *  0 means the season has not started, so its episode count is 「announced so far」 and not a size. */
  airedBefore: number;
  /** TMDB's own `status` for the work, verbatim (`Ended` / `Returning Series` / …). The server's `Status`
   *  is only a pre-filter — one show's three Series rows answered 1×Ended and 2×Continuing — so this is the
   *  field that decides whether 「nothing is coming」 means 「it is finished」. */
  status: string;
  /** The latest day TMDB has dated for this show at all, from `last_episode_to_air`, `''` when it has
   *  dated none. Unlike `slots` this is not clipped to the window, so it is the one answer that tells
   *  「its days are all behind this page」 apart from 「it has never been scheduled」. */
  lastAir: string;
  /** Every spelling this title is known by — the server's row name and TMDB's original title beside its
   *  own — because the Bilibili join is by name and the three sources disagree by design. */
  alt: string[];
  slots: SlotRow[];
}

interface BiliRow {
  title: string;
  date: string;
  clock: string;
  delay: string;
}

interface Store {
  schema: number;
  /** key = the TMDB series id. */
  series: Record<string, SeriesEntry>;
  bili: { fetchedAt: number; rows: BiliRow[] } | null;
}

const file = () => path.join(app.getPath('userData'), 'calendar.json');
let store: Store | null = null;
/** One write per answer, however many entries the run produced. */
let dirty = false;

const load = (): Store => {
  if (!store) {
    try {
      const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Store>;
      // A file from the previous schema is dropped rather than migrated: every entry in it is refetchable
      // with two requests, and a half-populated entry would render a card missing its year forever. The
      // week schedule keeps its rows — its own shape did not change and it expires on its own TTL.
      const fresh = raw.schema === SCHEMA;
      store = { schema: SCHEMA, series: fresh ? raw.series || {} : {}, bili: raw.bili || null };
    } catch {
      store = { schema: SCHEMA, series: {}, bili: null };
    }
  }
  return store;
};

const flush = (): void => {
  if (!dirty) return;
  dirty = false;
  try {
    mkdirSync(path.dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify(load()), 'utf8');
  } catch {
    // A cache that cannot be written only costs a refetch on the next open.
  }
};

const pad = (n: number): string => String(n).padStart(2, '0');
const fmt = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Bilibili's `pub_ts` is a UTC second stamp for a slot stated in Beijing time, and this machine may be
 *  anywhere, so the day and the clock are read off +08:00 explicitly rather than off the local zone. */
const cstParts = (ts: number): { date: string; clock: string } => {
  const d = new Date((ts + 8 * 3600) * 1000);
  return { date: d.toISOString().slice(0, 10), clock: d.toISOString().slice(11, 16) };
};

/* Punctuation carries no meaning in a title here and every source spells it differently: 库里 【我推的孩子】,
   B 站 【我推的孩子】, TMDB 我推的孩子. Anything that survives this is compared exactly — a partial match
   would happily hang one season's clock on another show's episode. */
const NAME_MARKS = /[\s【】〈《》〉「」『』()（）·．。，,！!？?：:、;；\-–~～'"’‘·]/g;
const normName = (s: string): string => s.replace(NAME_MARKS, '').toLowerCase();

const poolOf = (lang: string, genres: string[]): CalendarPool => {
  const anime = genres.some((g) => g === '动画' || g.toLowerCase() === 'animation');
  if (lang === 'ja') return 'jp';
  if (lang === 'ko') return 'kr';
  if (lang === 'zh' || lang === 'yue' || lang === 'zht' || lang === 'zh-cn') return anime ? 'cnova' : 'cn';
  if (lang === 'en') return 'en';
  // A Chinese-library show TMDB files under some other letter still belongs where its audience is, and
  // 动画 under any language is 国创-adjacent — but inventing a pool from a genre guess is how a row lands
  // in the wrong chip, so a language this ladder does not name stays 其他. Korean used to fall through to
  // exactly that, which is how 其他 became a Korean shelf with a generic label on it.
  return 'other';
};

/** One round of a fixed-size worker pool: the roster is 15-ish titles × 2 requests, and running them all
 *  at once is how a throttled 429 arrives on the first open of the month. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

interface Roster {
  /** key = TMDB series id, value = the server row it came from. */
  wanted: Map<string, LibraryItem>;
}

/** 收藏 ∪ 在看, narrowed to what the server still calls 在更. Each ask is one request and all three run
 *  together; the whole roster costs no TMDB traffic, which is why it is re-read on every open rather than
 *  cached — starring a show has to move the page. */
async function rosterOf(client: EmbyClient): Promise<Roster> {
  const fields = 'ProviderIds,SeriesName';
  const [ongoing, favs, resume] = await Promise.all([
    client.items({ Recursive: true, IncludeItemTypes: 'Series', SeriesStatus: 'Continuing', Limit: ROSTER_LIMIT, Fields: fields }),
    client.items({ Recursive: true, IncludeItemTypes: 'Series', Filters: 'IsFavorite', Limit: 400, Fields: fields }).catch(() => [] as LibraryItem[]),
    client.resumeRow(300).then((r) => r?.items ?? []).catch(() => [] as LibraryItem[]),
  ]);

  // A starred or parked row can be a Series, an Episode or a Movie, so it is matched by either half of
  // its address plus its name: the id when the server gave one, and the folded title when it did not.
  const keys = new Set<string>();
  for (const r of [...favs, ...resume]) {
    keys.add(r.id);
    if (r.seriesId) keys.add(r.seriesId);
    if (r.parentId) keys.add(r.parentId);
    const nm = normName(r.seriesName || r.name);
    if (nm) keys.add(`n${nm}`);
  }

  const wanted = new Map<string, LibraryItem>();
  for (const row of ongoing) {
    const nm = normName(row.name);
    if (!keys.has(row.id) && !keys.has(`n${nm}`)) continue;
    const tmdb = row.providers?.tmdb;
    // The gateway writes the literal "None" when it has scraped no id (see stores/app.ts), so the digits
    // test is not decoration: `None` would otherwise be asked of TMDB as an id.
    if (!tmdb || !/^\d{1,8}$/.test(tmdb)) continue;
    if (!wanted.has(tmdb)) wanted.set(tmdb, row);
  }
  return { wanted };
}

/** The work's own reply, then the season inside it: two requests, and the pair is what dates a timeline.
 *  `force` is the page's 刷新 button stepping past the TTL, because a date that slipped is exactly the
 *  thing a reader comes back to look at. */
async function scheduleOf(tmdbId: string, row: LibraryItem, token: string, force: boolean): Promise<SeriesEntry> {
  const s = load();
  const cached = s.series[tmdbId];
  if (cached && !force && Date.now() - cached.fetchedAt < SERIES_TTL) return cached;

  const base = `https://api.themoviedb.org/3/tv/${tmdbId}`;
  const detail = await fetchJson<any>(`${base}?language=zh-CN`, token);
  // Thrown, not swallowed: `fetchJson` says whether the host answered, and silence must not be stored as
  // 「this show has no schedule」 — that would freeze a title out of the month for the whole TTL.
  if (!detail.answered || !detail.json || detail.json.status_code === 7) {
    throw new Error(detail.why || `TMDB 没有 tv/${tmdbId}`);
  }
  const j = detail.json;
  const genres: string[] = (Array.isArray(j.genres) ? j.genres : []).map((g: any) => String(g?.name || '')).filter(Boolean);
  const pool = poolOf(String(j.original_language || '').toLowerCase(), genres);
  const poster = typeof j.poster_path === 'string' ? j.poster_path : '';
  const name = String(j.name || row.name).trim();
  const first = String(j.first_air_date || '');
  const year = /^\d{4}/.test(first) ? Number(first.slice(0, 4)) : 0;

  const next = j.next_episode_to_air;
  const last = j.last_episode_to_air;
  const seasonNumbers: number[] = (Array.isArray(j.seasons) ? j.seasons : [])
    .map((x: any) => Number(x?.season_number))
    .filter((n: number) => Number.isFinite(n) && n > 0);
  const season = Number(next?.season_number ?? last?.season_number ?? 0) || Math.max(0, ...seasonNumbers);

  /* The denominator comes off the work reply's own season table, which is the only place this pair counts a
     season for free: measured 2026-10-26 over 13 titles, `next_episode_to_air` and `last_episode_to_air`
     answer `episode_count` / `total_episode_count` as undefined on every one of them (including the three
     that do have a next episode), while `seasons[]` carries the number for exactly the season named above —
     鱿鱼游戏 6, 模范出租车 16, 菜鸟老警 1, each equal to what the season reply then repeats. So a 404 on the
     season ask now costs the dated episodes and not the denominator. */
  const seasonRow = (Array.isArray(j.seasons) ? j.seasons : []).find((x: any) => Number(x?.season_number) === season);
  const out: SeriesEntry = {
    fetchedAt: Date.now(),
    name,
    poster,
    pool,
    season,
    year,
    genres,
    seasonTotal: Number(seasonRow?.episode_count) || 0,
    airedBefore: 0,
    status: String(j.status || ''),
    lastAir: /^\d{4}-\d{2}-\d{2}$/.test(String(last?.air_date || '')) ? String(last.air_date) : '',
    alt: [name, row.name, String(j.original_name || ''), String(row.originalTitle || '')].map(normName).filter(Boolean),
    slots: [],
  };
  const today = fmt(new Date());
  if (season > 0) {
    const ep = await fetchJson<any>(`${base}/season/${season}?language=zh-CN`, token);
    /* A season TMDB has not numbered yet answers 404, which is an answer and not a failure: the work-level
       reply already dated this show's next episode when it has one, and an empty slot list simply puts the
       title nowhere on the timeline. */
    if (ep.answered && ep.json && Array.isArray(ep.json.episodes)) {
      const from = fmt(new Date(Date.now() - WINDOW_DAYS * DAY - STORE_PAD));
      const to = fmt(new Date(Date.now() + WINDOW_DAYS * DAY + STORE_PAD));
      // The count is the whole season's, not the window's: 「集 4/12」 says where this episode sits in the
      // season a reader is watching, and a band that clipped the denominator would print 4/3.
      if (ep.json.episodes.length) out.seasonTotal = ep.json.episodes.length;
      for (const e of ep.json.episodes) {
        const air = String(e?.air_date || '');
        if (air.length !== 10) continue;
        // Counted over the whole season, not the band: this is the answer to 「has it started yet」.
        if (air <= today) out.airedBefore++;
        // Dates are `YYYY-MM-DD`, so the window test is a string compare.
        if (air < from || air > to) continue;
        const n = Number(e?.episode_number);
        if (!Number.isFinite(n)) continue;
        out.slots.push({
          date: air,
          episode: n,
          name: String(e?.name || '').trim(),
        });
      }
      out.slots.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.episode - b.episode));
    } else if (out.lastAir && out.lastAir <= today && Number(last?.season_number) === season) {
      // The season ask did not answer, so this is all the proof of a start the entry can have: TMDB's own
      // last episode sits inside this same season and its day has passed.
      out.airedBefore = 1;
    }
  }
  /* A season that has not aired one episode yet has no size to be 1/N of — TMDB's count for it is how many
     it has announced, which is how 菜鸟老警's 第9季 reached the card as 「集 1/1」 with the bar full and the
     episode ten weeks away. Dropping the denominator sends the card to its 「集 N」 branch: the half of the
     statement that is true. */
  if (!out.airedBefore) out.seasonTotal = 0;
  s.series[tmdbId] = out;
  dirty = true;
  return out;
}

const biliGet = async (url: string): Promise<any | null> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    // No `Referer`, on purpose. Measured 2026-10-25 against the live app: the same request with
    // `Referer: https://www.bilibili.com/anime/timeline/` dies inside Chromium as
    // `net::ERR_BLOCKED_BY_CLIENT` (a client-side verdict, not a reply — the variant that asked for
    // `Accept: text/plain` reached the server and came back 406), while the bare call and the one that
    // names only the site root both answer 200. The node probe that first measured this schedule never
    // sent that header at all, which is why the shape was known and the block was not.
    const res = await net.fetch(url, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'EchoEmby/0.2 (desktop client; schedule lookup)',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.code === 0 ? j.result : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/** One week of Bilibili's own schedule, as name → dated clock rows. It is a supplement and not a source of
 *  record: measured 2026-10-26 it answers 43 rows / 26 distinct titles for the whole week (`season_type=1`
 *  番剧 12 titles plus `=4`, whose rows are the 国创 ones — 凡人修仙传 and 牧神记, the only two this account
 *  follows, both come out of `=4`; the label B 站 gives the number is not what its table holds), and
 *  `=2`/`=3`/`=5`/`=6`/`=7` are refused with `code=-400`. The legacy v1 endpoint answers every type but
 *  ignores the parameter, so it is not a second route to more titles. Which is why nothing here waits on it
 *  beyond its own two requests.
 *  Re-read on every open when it comes back with nothing. A 0-row week read as an answer is how this ran
 *  for twelve hours with no clock on screen: the field inside a day group is `episodes` (measured 2026-10-25,
 *  `group keys: date,date_ts,day_of_week,episodes,is_today`), and the same shape read as `items` is an empty
 *  schedule that the TTL would then refuse to retry. */
async function biliRows(force: boolean): Promise<BiliRow[]> {
  const s = load();
  if (!force && s.bili && s.bili.rows.length && Date.now() - s.bili.fetchedAt < BILI_TTL) return s.bili.rows;
  const rows: BiliRow[] = [];
  const seen = new Set<string>();
  for (const type of [1, 4]) {
    const r = await biliGet(`https://api.bilibili.com/pgc/web/timeline/v2?season_type=${type}&day=${fmt(new Date())}`);
    const groups: any[] = Array.isArray(r?.timeline) ? r.timeline : [];
    // `latest` rides beside the seven day groups and holds the same kind of row; it is the one list the
    // week grid can leave a title out of, so it is folded in and dated off the row's own `pub_ts`.
    const lists = groups.flatMap((g) => [Array.isArray(g?.episodes) ? g.episodes : [], Array.isArray(g?.items) ? g.items : []]);
    lists.push(Array.isArray(r?.latest) ? r.latest : []);
    for (const items of lists) {
      for (const it of items) {
        const title = String(it?.title || '').trim();
        const ts = Number(it?.pub_ts);
        if (!title || !Number.isFinite(ts) || ts <= 0) continue;
        const id = `${it?.season_id ?? ''}|${ts}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const { date, clock } = cstParts(ts);
        const stated = /^\d{1,2}:\d{2}$/.test(String(it?.pub_time || '')) ? String(it.pub_time) : '';
        rows.push({ title, date, clock: stated || clock, delay: String(it?.delay_reason || '').trim() });
      }
    }
  }
  if (rows.length) {
    s.bili = { fetchedAt: Date.now(), rows };
    dirty = true;
  }
  return rows;
}

/** `from` / `to` are the days the page is showing, `YYYY-MM-DD`, and are answered out of what the cache
 *  already holds: a day a reader scrolls to costs no new request for a title already dated. The page asks
 *  exactly the band it draws, so a title with no slot in it is a title the page cannot show — which is what
 *  makes `quiet` the same question the reader is asking. */
export async function calendarSchedule(client: EmbyClient, from: string, to: string, force = false): Promise<CalendarResult> {
  const token = config.get().meta?.tmdbV4Token;
  // Without a key every one of the asks below fails, and the page would spend 22 timeouts to say what one
  // line can say up front.
  if (!token) return { slots: [], failed: [], quiet: [], noKey: true };
  const { wanted } = await rosterOf(client);
  const entries = await mapLimit([...wanted.entries()], CONCURRENCY, async ([tmdbId, row]) => {
    try {
      return { tmdbId, row, entry: await scheduleOf(tmdbId, row, token, force) };
    } catch {
      return { tmdbId, row, entry: null };
    }
  });

  const clocks = await biliRows(force).catch(() => [] as BiliRow[]);
  const byName = new Map<string, BiliRow[]>();
  for (const r of clocks) {
    const k = normName(r.title);
    const list = byName.get(k);
    if (list) list.push(r);
    else byName.set(k, [r]);
  }

  const slots: CalendarSlot[] = [];
  const failed: string[] = [];
  for (const { tmdbId, row, entry } of entries) {
    if (!entry) {
      failed.push(row.name);
      continue;
    }
    // The Bilibili row has to agree on the day as well as the name: a show whose season the two sources
    // slice differently (弹珠汽水: TMDB still dating S1, B 站 已完结 全13话) would otherwise borrow a clock
    // for an episode the other source does not place on this day.
    const marks = entry.alt.map((n) => byName.get(n)).find((x) => x?.length);
    for (const srow of entry.slots) {
      if (srow.date < from || srow.date > to) continue;
      const hit = marks?.find((b) => b.date === srow.date);
      const slot: CalendarSlot = {
        date: srow.date,
        tmdbId,
        seriesId: row.id,
        name: entry.name,
        poster: entry.poster,
        pool: entry.pool,
        season: entry.season,
        episode: srow.episode,
        year: entry.year,
        genres: entry.genres,
        seasonTotal: entry.seasonTotal,
      };
      if (srow.name) slot.episodeName = srow.name;
      if (hit?.clock) slot.clock = hit.clock;
      if (hit?.delay) slot.delay = hit.delay;
      slots.push(slot);
    }
  }
  // Inside one day, a Bilibili clock is the only order a reader can check, so the shows that have one come
  // first by time and the rest follow by name. The season number used to decide this, which parked
  // 樱桃小丸子's 第2季 between two 第1季 anime and put 相棒's 第25季 last every day it appeared.
  const withinDay = (a: CalendarSlot, b: CalendarSlot): number =>
    (a.clock ? 0 : 1) - (b.clock ? 0 : 1) ||
    (a.clock || '').localeCompare(b.clock || '') ||
    a.name.localeCompare(b.name, 'zh');
  slots.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : withinDay(a, b)));

  const onScreen = new Set(slots.map((s) => s.tmdbId));
  const quiet: CalendarQuiet[] = [];
  for (const { tmdbId, row, entry } of entries) {
    if (!entry || onScreen.has(tmdbId)) continue;
    quiet.push({
      tmdbId,
      seriesId: row.id,
      name: entry.name,
      pool: entry.pool,
      season: entry.season,
      /* Not the tail of `slots`: that array is clipped to the band the entry was fetched for, so its last day
         answers 「nothing inside this page」 and not 「nothing TMDB knows」 — which is how 10 of the 13 rows
         here printed 「未排期」 for shows TMDB has a dated last episode for (物语系列 2024-10-19, 瑞克和莫蒂
         2026-07-26, 鬼灭之刃 2024-06-30). `lastAir` rides on the work reply and is never clipped; an entry
         cached before it existed answers `''`, which is the old wording. */
      lastDate: entry.lastAir || (entry.slots.length ? entry.slots[entry.slots.length - 1].date : ''),
      ended: entry.status === 'Ended',
    });
  }
  // The ones that aired most recently are the ones a reader is most likely still waiting on.
  quiet.sort((a, b) => (a.lastDate === b.lastDate ? a.name.localeCompare(b.name, 'zh') : a.lastDate < b.lastDate ? 1 : -1));
  flush();
  return { slots, failed, quiet };
}
