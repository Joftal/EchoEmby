import { computed, reactive, ref, watch, type ComputedRef } from 'vue';
import type { BangumiScore, CsmGuide, ImdbRating, IpcResult, LibraryItem, RtScores, TmdbMeta, TmdbSeasonRow, TraktScores } from '../../shared/types';
import { embyCached } from './embycache';

/** Everything the score strip can draw, filled in per source as each one answers. */
export interface Scores {
  rt: RtScores | null;
  imdb: ImdbRating | null;
  trakt: TraktScores | null;
  bgm: BangumiScore | null;
  tmdb: TmdbMeta | null;
  csm: CsmGuide | null;
}

const blank = (): Scores => ({ rt: null, imdb: null, trakt: null, bgm: null, tmdb: null, csm: null });

/** TMDB's id space splits movies from shows, and every source that needs a kind reads it off the item.
 *  An Episode stays null: its provider ids point at the episode, not at a page any of these sources has. */
export function tmdbKind(item: LibraryItem | null | undefined): 'movie' | 'tv' | null {
  if (item?.type === 'Movie') return 'movie';
  if (item?.type === 'Series' || item?.type === 'Season') return 'tv';
  return null;
}

export const SEASON_TRUST = 0.67;

/** Whether the two sides' counts can be one season. Split out so `pairedSeason` can run the same test when
 *  no numbering ever arrives to do it better. */
const countsAgree = (t: TmdbSeasonRow, count?: number): boolean => {
  const a = count || 0;
  const b = t.epCount || 0;
  return !a || !b || Math.min(a, b) / Math.max(a, b) >= SEASON_TRUST;
};

/** TMDB's row for one season number, believed while the two counts agree about how big that season is.
 *  Kept for the surfaces that hold a count and nothing else: the player's season chips, and each page's
 *  picker rows for the seasons nobody has opened. Where the numbering itself diverges there is simply no row
 *  to match — 物语 files seasons 11-25 where TMDB stops at 5, 咒术回战 has a 季 3 TMDB never heard of — so a
 *  divergence like that costs no threshold. What a count still has to decide is the split-cour case:
 *  咒术回战's 47 against TMDB's 59 (0.80) and 【推しの子】's 24 against 35 (0.69) are one season counted two
 *  ways and keep TMDB's date and art, while 800 Meters' 1 against 3 (0.33) is a different cut. */
export function trustSeason(rows: TmdbSeasonRow[] | null | undefined, n?: number | null, count?: number): TmdbSeasonRow | null {
  if (n == null || !rows) return null;
  const t = rows.find(x => x.n === n);
  return t && countsAgree(t, count) ? t : null;
}

/** How many of a season's own files have to land inside the season TMDB bills before that season is believed.
 *  0.8 measured over the 389 season pairs this gateway and TMDB both name (第 0 季 included, a work filed as
 *  several Series rows counted once by its fullest row): the count test refused 58 of the pairs the files
 *  agree about and believed 1 the files refuse, so 0.8 moves 50 pairings onto the answer the files give.
 *  367 of the 389 hold numbered files to judge; the other 22 keep the count test and 2 of those are refused
 *  by it (樱桃小丸子 第 2 季 bills 566 files and numbers none). What the count could never tell apart is the
 *  rescue: a show still airing has 3 files against TMDB's 13 exactly the way a wrongly sliced season does,
 *  and 魔法骑士雷阿斯, PSYREN and 22 more of these 50 are the first — each of them had lost its date, its art,
 *  its rating, its paragraph, its credits and its episode pictures for want of a partial download. 43 of the
 *  50 also start within a day of TMDB's own date for that season, which the count test cannot see.
 *  What the rule cannot see is the subset. 神墓's 第 2 季 holds 16 files numbered 1-16 and its first date,
 *  2024-08-10, is TMDB's own start for 第 2 季 (学城风云, 27 episodes) to the day, so believing that pairing
 *  is right; the same run's continuation sits under its 第 1 季 numbered 17-43, lands 0 of 27 inside and keeps
 *  no TMDB name. But 16 files of a 27-episode season is also exactly the shape of a show still airing, and
 *  numbering alone cannot split the two — the rule buys the airing case and takes the subset case with it. */
export const PAIR_MIN = 0.8;

export interface SeasonPairing {
  /** TMDB's own row for the season: the untouched one out of the work-level table, not a merged list that has
   *  already had this server's episode count written over it. Null when TMDB bills no such season, which is a
   *  refusal that needs no threshold at all. */
  tmdb: TmdbSeasonRow | null | undefined;
  /** The `indexNumber` of every file this server holds for that season. The three answers mean three things
   *  and the rule lives in the difference: `undefined` is "this season has no files here to pair" (a page
   *  drawn from TMDB's list alone), `null` is "the file list has not come back yet", and an array is the
   *  answer — including an empty one, which is a season with nothing numbered in it rather than a wait. */
  files?: number[] | null;
  /** This server's own ChildCount: the only input of the fallback that runs when no numbering is available. */
  count?: number;
}

/** TMDB's row for a season, believed by where that season's files actually sit rather than by two counts.
 *  `null` answers both "refused" and "not provable yet", and that is the point: a page prints a season's
 *  marks when this returns a row and prints nothing until it does, so a verdict can only ever add to what is
 *  on screen. Grading with the count first and the files second was the alternative and it takes a hat away —
 *  本季评分 and the season's own name would come back off a caption the reader watched arrive, on a page whose
 *  hydration is otherwise only ever downward.
 *  The range is TMDB's `1..epCount`, not the per-episode numbers a page can also hold: measured against the
 *  real numbers on the 62 pairs where those were in hand, TMDB restarts every season at 1, so the two ranges
 *  agreed 62 of 62 and not one verdict moved. Dates were the other candidate and they are not usable: 98 of
 *  the 402 season rows on this machine carry no PremiereDate at all, and 9 pairings both sides agree on are 2
 *  to 1006 days apart (咒术回战 第 1 季: 59 files numbered 1-59 against TMDB's 59, 2023-07-06 against
 *  2020-10-03). Believed or not, the episode count a page prints is always the server's own, because that is
 *  the number its episode row has to match. */
export function pairedSeason(p: SeasonPairing): TmdbSeasonRow | null {
  const t = p.tmdb;
  if (!t) return null;
  if (p.files === null) return null;
  const files = p.files;
  if (!files || !files.length || !t.epCount) return countsAgree(t, p.count) ? t : null;
  const inside = files.filter(x => x >= 1 && x <= t.epCount).length;
  return inside / files.length >= PAIR_MIN ? t : null;
}

/* Keyed by item, so the lobby hero and the detail page ask once for the same title, and a title that
   comes back to the slide rotation is already answered. The main process caches each source on disk, so
   this map only has to survive the session. */
const cache = reactive<Record<string, Scores>>({});

/* Claimed per (item, source), not per item: a list row reads one field out of TMDB and nothing else, and
   the detail page for that same title must then skip only the source the row already paid for. The claim
   is released again when the round trip fails — an error is not an answer, and since the season's date,
   art, synopsis, credits and rating all ride TMDB's single reply, one lost request used to cost the whole
   hero caption until the app was restarted. A source that answers `null` is a real reply (this title
   simply has no Rotten Tomatoes page) and stays written off. */
const asked = new Map<string, Set<keyof Scores>>();

function claim(id: string, key: keyof Scores): boolean {
  let k = asked.get(id);
  if (!k) asked.set(id, (k = new Set()));
  if (k.has(key)) return false;
  k.add(key);
  return true;
}

/** Only ever the key this promise claimed: a retry that fails must not un-pin a source another call already
 *  answered, and a late reply for a key that has since been re-asked must not stand for the new answer. */
function release(id: string, key: keyof Scores): void {
  asked.get(id)?.delete(key);
}

/** Created on first use and never reset, so a card's answer is still here when the page below it opens. */
function slot(id: string): Scores {
  if (!cache[id]) cache[id] = blank();
  // Read the entry back instead of keeping the object built above: assigning into `reactive` stores a
  // proxy, and writing to the raw target through a captured reference never hits the set trap, so every
  // source would land in the cache without the strip ever learning that it did.
  return cache[id];
}

/* Whether a source has *answered*, per (item, source), kept apart from the answer itself because a null is
   two different facts wearing one shape: 「TMDB 没有这个标题」 and 「TMDB 还没回」. Only the badge ladder needs
   the difference, and it is written by the success branch alone — a transport failure settles nothing until
   the tries below run out, which is what keeps a request that died in the proxy from being dressed up as a
   title TMDB does not have. */
const settled = reactive<Record<string, boolean>>({});

/* A failure costs one more try and then hands the claim back. Immediately is wrong — one lost request on a
   title is usually the proxy blinking, and re-asking at once asks again into the same blink — and never is
   wrong too: TMDB's single reply carries the synopsis, the certification, the season table, the credits and
   the rating, so the hero caption of a title nobody else re-mounts stayed blank until the app restarted. */
const TRIES = 2;
const RETRY_MS = 1_500;

function put<K extends keyof Scores>(id: string, key: K, ask: () => Promise<IpcResult<Scores[K] | null>>): void {
  if (!claim(id, key)) return;
  const s = slot(id);
  const attempt = (left: number): void => {
    const fail = () => {
      if (left > 1) setTimeout(() => attempt(left - 1), RETRY_MS);
      else {
        /* Out of tries. The claim goes back so the next mount of this title can ask again, and the source is
           still called answered, because a badge that waits on a source which will not reply waits forever:
           themoviedb.org is exactly the kind of host this machine reaches only through a proxy, and an empty
           不代理 mode would otherwise wipe every score off every poster while the library itself plays fine.
           The server's own number takes the place instead. */
        release(id, key);
        settled[`${id}|${key}`] = true;
      }
    };
    void ask().then(
      x => {
        if (!x.ok) {
          fail();
          return;
        }
        s[key] = x.data || null;
        settled[`${id}|${key}`] = true;
      },
      fail,
    );
  };
  attempt(TRIES);
}

/** Every source the score strip can draw, each one skipped if an earlier reader already asked for it.
 *  `pick` narrows that to what the caller actually prints: a card row wears no age badge, and asking CSM
 *  for a title it has nowhere to put is one scrape of a ratings site per row for nothing. */
const ALL_SOURCES: (keyof Scores)[] = ['rt', 'imdb', 'trakt', 'tmdb', 'csm', 'bgm'];
function load(item: LibraryItem, pick: (keyof Scores)[] = ALL_SOURCES): void {
  const id = item.id;
  const wants = (k: keyof Scores): boolean => pick.includes(k);
  const imdb = item.providers?.imdb || '';
  const kind = tmdbKind(item);
  if (imdb) {
    if (wants('rt')) put(id, 'rt', () => window.echoemby.meta.rt(imdb));
    if (wants('imdb')) put(id, 'imdb', () => window.echoemby.meta.imdb(imdb));
    if (kind && wants('trakt')) put(id, 'trakt', () => window.echoemby.meta.trakt({ kind, imdb }));
  }
  if (wants('tmdb')) askTmdb(item);
  // CSM reverse-looks-up by title slug, so it wants the Latin original title when there is one.
  // Neither title-keyed source is asked for a Season row: its name is 「第一季」, a position rather than a
  // title, and the page that needs the answer is the series above it, which asks for itself.
  const csmTitle = item.originalTitle || item.name;
  if (kind && item.type !== 'Season' && csmTitle && wants('csm')) put(id, 'csm', () => window.echoemby.meta.csm({ kind, title: csmTitle }));
  // Bangumi is the opposite half: its search only reaches CJK names, and that is where the anime and
  // domestic-drama titles this server holds are actually reviewed.
  if (kind && item.type !== 'Season' && item.name && wants('bgm')) put(id, 'bgm', () => window.echoemby.meta.bangumi(item.name));
}

/** TMDB answers for a work, never for an episode row, and only when the server actually carries its id. */
function tmdbAskable(item: LibraryItem): boolean {
  // This gateway writes the string "None" for a provider it does not have, and the main process refuses
  // anything that is not digits — so claiming the key for one of those would write a real title off as
  // answered without ever asking.
  return !!tmdbKind(item) && /^\d{1,8}$/.test(item.providers?.tmdb || '');
}

/** TMDB alone: the one source that carries a synopsis and a certification for a title the server left blank. */
function askTmdb(item: LibraryItem): void {
  if (!tmdbAskable(item)) return;
  put(item.id, 'tmdb', () => window.echoemby.meta.tmdb({ kind: tmdbKind(item)!, tmdbId: item.providers!.tmdb! }));
}

/** The work a row's outside data lives on. An Episode's own provider ids point at the episode and no source
 *  here has an episode page, so the row is answered from the Series above it — one ask per show, because
 *  `embyCached` folds the twenty-four episode rows of 名侦探柯南 into the one series id they all name. */
async function workOf(item: LibraryItem): Promise<LibraryItem | null> {
  if (tmdbKind(item)) return item;
  if (item.type !== 'Episode') return null;
  const sid = item.seriesId || item.parentId;
  if (!sid) return null;
  try {
    const r = await embyCached('item', sid, () => window.echoemby.emby.item(sid));
    return r.ok ? r.data || null : null;
  } catch {
    return null;
  }
}

/** Scores for whatever item the getter currently returns; a new item swaps the whole set at once.
 *  `pick` narrows the ask to the sources the caller actually draws — see `load`. */
export function useScores(
  get: () => LibraryItem | null | undefined,
  pick?: (keyof Scores)[]
): ComputedRef<Scores> {
  const id = computed(() => get()?.id || '');
  watch(
    id,
    () => {
      const it = get();
      if (it) load(it, pick);
    },
    { immediate: true },
  );
  return computed(() => (id.value && cache[id.value]) || blank());
}

/** TMDB for whatever item the getter currently returns, and nothing else.
 *  The list rows take synopsis and certification from here, so the getter hands back the row only once it
 *  scrolls near: a page of cards that pulled all six sources would pay for IMDb, Trakt and Bangumi round
 *  trips it has nowhere to print, and the gateway 500s on a burst of them. A row that is not a work is
 *  resolved upward first, and the answer is read off the work's own key, so twenty-four episodes of one
 *  show cost one TMDB trip and share its answer with that show's detail page. */
export interface TmdbSlot {
  /** The work this row's outside data lives on: the row itself for a Movie or Series, the Series above it
   *  for an Episode, and null while that lookup is still owed — or forever, for a row with no work above it
   *  (a BoxSet, a Playlist). Anything asking for more than TMDB needs this, because a row's own provider
   *  ids point at the episode rather than at a page any other source has. */
  work: LibraryItem | null;
  meta: TmdbMeta | null;
  /** The number to print when the work has no TMDB rating: the work's own, and only if it has none, the
   *  row's. An episode row's server rating is a per-episode figure (measured over 48 rows: 3 of the 8 a
   *  badge can stand on disagree with the series above them, e.g. 9.5 against the series' 7.0), and the
   *  badge beside a poster is read as the title's score, so it may fall back to that one alone. */
  fallback: number;
  /** Whether TMDB is still owed an answer. False covers the three waits a card cannot see the difference
   *  between — the row has not come near yet, its series has not come back from the server, TMDB has not
   *  replied — and a badge that prints the server's number through any of them is the second number.
   *  A row that can never reach TMDB is ready at once: a work the server left without a digit id, and an
   *  episode whose series lookup came back empty, would otherwise wait on an ask that is never coming. */
  ready: boolean;
}

export function useTmdb(get: () => LibraryItem | null | undefined): ComputedRef<TmdbSlot> {
  const id = computed(() => get()?.id || '');
  const workId = ref('');
  const work = ref<LibraryItem | null>(null);
  const deadEnd = ref(false);
  const fallback = ref(0);
  watch(
    id,
    async () => {
      const it = get();
      workId.value = '';
      work.value = null;
      deadEnd.value = false;
      fallback.value = 0;
      if (!it) return;
      const w = await workOf(it);
      if (get()?.id !== it.id) return;
      work.value = w;
      fallback.value = Number(w?.communityRating) || Number(it.communityRating) || 0;
      if (!w || !tmdbAskable(w)) {
        deadEnd.value = true;
        return;
      }
      askTmdb(w);
      workId.value = w.id;
    },
    { immediate: true },
  );
  return computed(() =>
    workId.value
      ? { work: work.value, meta: cache[workId.value]?.tmdb || null, ready: !!settled[`${workId.value}|tmdb`], fallback: fallback.value }
      : { work: work.value, meta: null, ready: deadEnd.value, fallback: fallback.value },
  );
}
