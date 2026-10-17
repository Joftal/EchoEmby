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

/** TMDB's row for one season number, believed only while both sides agree about how big that season is.
 *  Measured over 9 awkward shows and a 73-season sweep: where the numbering itself diverges — 物语 files
 *  seasons 11-25 where TMDB stops at 5, 咒术回战 has a 季 3 TMDB never heard of — there is simply no row to
 *  match, so that fallback costs no threshold. What a number still has to decide is the split-cour case:
 *  咒术回战's 47 against TMDB's 59 (0.80) and 【推しの子】's 24 against 35 (0.69) are one season counted two
 *  ways and keep TMDB's date and art, while 800 Meters' 1 against 3 (0.33) is a different cut. 0.67
 *  separates them: 41 pairings believed, 1 refused. Believed or not, the episode count a page prints is
 *  always the server's own, because that is the number its episode row has to match. */
export function trustSeason(rows: TmdbSeasonRow[] | null | undefined, n?: number | null, count?: number): TmdbSeasonRow | null {
  if (n == null || !rows) return null;
  const t = rows.find(x => x.n === n);
  if (!t) return null;
  const a = count || 0;
  const b = t.epCount || 0;
  if (a && b && Math.min(a, b) / Math.max(a, b) < SEASON_TRUST) return null;
  return t;
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

function put<K extends keyof Scores>(id: string, key: K, p: Promise<IpcResult<Scores[K] | null>>): void {
  if (!claim(id, key)) return;
  const s = slot(id);
  void p.then(
    x => {
      if (x.ok) s[key] = x.data || null;
      else release(id, key);
    },
    () => release(id, key),
  );
}

/** Every source the score strip can draw, each one skipped if an earlier reader already asked for it. */
function load(item: LibraryItem): void {
  const id = item.id;
  const imdb = item.providers?.imdb || '';
  const kind = tmdbKind(item);
  if (imdb) {
    put(id, 'rt', window.echoemby.meta.rt(imdb));
    put(id, 'imdb', window.echoemby.meta.imdb(imdb));
    if (kind) put(id, 'trakt', window.echoemby.meta.trakt({ kind, imdb }));
  }
  askTmdb(item);
  // CSM reverse-looks-up by title slug, so it wants the Latin original title when there is one.
  // Neither title-keyed source is asked for a Season row: its name is 「第一季」, a position rather than a
  // title, and the page that needs the answer is the series above it, which asks for itself.
  const csmTitle = item.originalTitle || item.name;
  if (kind && item.type !== 'Season' && csmTitle) put(id, 'csm', window.echoemby.meta.csm({ kind, title: csmTitle }));
  // Bangumi is the opposite half: its search only reaches CJK names, and that is where the anime and
  // domestic-drama titles this server holds are actually reviewed.
  if (kind && item.type !== 'Season' && item.name) put(id, 'bgm', window.echoemby.meta.bangumi(item.name));
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
  put(item.id, 'tmdb', window.echoemby.meta.tmdb({ kind: tmdbKind(item)!, tmdbId: item.providers!.tmdb! }));
}

/** The work a row's outside data lives on. An Episode's own provider ids point at the episode and no source
 *  here has an episode page, so the row is answered from the Series above it — one ask per show, because
 *  `embyCached` folds the twenty-four 待看 rows of 名侦探柯南 into the one series id they all name. */
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

/** Scores for whatever item the getter currently returns; a new item swaps the whole set at once. */
export function useScores(get: () => LibraryItem | null | undefined): ComputedRef<Scores> {
  const id = computed(() => get()?.id || '');
  watch(
    id,
    () => {
      const it = get();
      if (it) load(it);
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
export function useTmdb(get: () => LibraryItem | null | undefined): ComputedRef<TmdbMeta | null> {
  const id = computed(() => get()?.id || '');
  const workId = ref('');
  watch(
    id,
    async () => {
      const it = get();
      workId.value = '';
      if (!it) return;
      const w = await workOf(it);
      if (!w || get()?.id !== it.id) return;
      askTmdb(w);
      if (tmdbAskable(w)) workId.value = w.id;
    },
    { immediate: true },
  );
  return computed(() => (workId.value ? cache[workId.value]?.tmdb || null : null));
}
