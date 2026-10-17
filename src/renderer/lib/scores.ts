import { computed, reactive, watch, type ComputedRef } from 'vue';
import type { BangumiScore, CsmGuide, ImdbRating, IpcResult, LibraryItem, RtScores, TmdbMeta, TmdbSeasonRow, TraktScores } from '../../shared/types';

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
const asked = new Set<string>();

function load(item: LibraryItem): void {
  cache[item.id] = blank();
  // Read the entry back instead of keeping the object built above: assigning into `reactive` stores a
  // proxy, and writing to the raw target through a captured reference never hits the set trap, so every
  // source would land in the cache without the strip ever learning that it did.
  const s = cache[item.id];
  /* An error is not an answer. Once every source has settled, any one of them that failed takes the item
     back off `asked`, so the next visit tries again instead of living without it for the rest of the run.
     Since the season's date, art, synopsis, credits and rating all ride TMDB's single answer, one lost
     round trip used to cost the whole hero caption until the app was restarted. A source that answers
     `null` is a real reply — this title simply has no Rotten Tomatoes page — and stays written off. */
  let live = 0;
  let errored = false;
  const settle = (): void => {
    live--;
    if (!live && errored) asked.delete(item.id);
  };
  const put = <K extends keyof Scores>(key: K, p: Promise<IpcResult<Scores[K] | null>>): void => {
    live++;
    void p.then(
      x => {
        if (x.ok) s[key] = x.data || null;
        else errored = true;
        settle();
      },
      () => {
        errored = true;
        settle();
      },
    );
  };
  const imdb = item.providers?.imdb || '';
  const kind = tmdbKind(item);
  if (imdb) {
    put('rt', window.echoemby.meta.rt(imdb));
    put('imdb', window.echoemby.meta.imdb(imdb));
    if (kind) put('trakt', window.echoemby.meta.trakt({ kind, imdb }));
  }
  const tmdbId = item.providers?.tmdb;
  if (kind && tmdbId) put('tmdb', window.echoemby.meta.tmdb({ kind, tmdbId }));
  // CSM reverse-looks-up by title slug, so it wants the Latin original title when there is one.
  // Neither title-keyed source is asked for a Season row: its name is 「第一季」, a position rather than a
  // title, and the page that needs the answer is the series above it, which asks for itself.
  const csmTitle = item.originalTitle || item.name;
  if (kind && item.type !== 'Season' && csmTitle) put('csm', window.echoemby.meta.csm({ kind, title: csmTitle }));
  // Bangumi is the opposite half: its search only reaches CJK names, and that is where the anime and
  // domestic-drama titles this server holds are actually reviewed.
  if (kind && item.type !== 'Season' && item.name) put('bgm', window.echoemby.meta.bangumi(item.name));
}

/** Scores for whatever item the getter currently returns; a new item swaps the whole set at once. */
export function useScores(get: () => LibraryItem | null | undefined): ComputedRef<Scores> {
  const id = computed(() => get()?.id || '');
  watch(
    id,
    () => {
      const it = get();
      if (!it || asked.has(it.id)) return;
      asked.add(it.id);
      load(it);
    },
    { immediate: true },
  );
  return computed(() => (id.value && cache[id.value]) || blank());
}
