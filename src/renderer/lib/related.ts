import { computed, reactive, ref, watch, type ComputedRef } from 'vue';
import type { LibraryItem } from '../../shared/types';
import { embyCached } from './embycache';
import { accountName } from './format';
import { useAppStore } from '../stores/app';

/** The band under a work: 「相似作品」, twelve cards, every one of them a page you can open.
 *
 *  TMDB's `/similar` list is the part that knows what actually resembles this title, but it answers with
 *  outside ids and this app's pages are keyed by the server's, so the list used to end there: a read-only
 *  strip of posters you could look at and not press. Resolving each row back into the library is what turns
 *  it into navigation, and the resolution is a title search with an id check, measured at 334 ms for twelve
 *  of them side by side on 模范出租车 (20/20 of the sampled titles that the library holds are found by their
 *  TMDB name, and 20/20 of the ones it does not come back as no rows rather than as a near miss).
 *
 *  A row the library has no answer for is not a dead end either: it opens the work page, which TMDB's own
 *  entry can dress completely — seasons, episodes, credits, art — and only leaves out the file. */

export type WorkKind = 'movie' | 'tv';

/** The work the band belongs to. Held apart from `LibraryItem` because the page this feeds can be a work
 *  the server does not hold at all, and that page has the same three things and nothing else. */
export interface WorkSeed {
  kind: WorkKind;
  tmdbId: string;
  /** Only used as the fill pool's fallback spelling; the cards themselves come from TMDB's list. */
  genres?: string[];
}

export interface RelatedCard {
  /** `kind:tmdbId` — the key both halves of this module agree on. A fill row with no TMDB id keeps the
   *  server's, which nothing else in the band can collide with. */
  key: string;
  kind: WorkKind;
  tmdbId: number;
  name: string;
  /** The card's own year line, and the work page's fallback until TMDB answers. `''` when neither the
   *  recommendation nor the server row carries a date. */
  year: string;
  /** A full image URL, from either side: TMDB's poster path dressed by this module, or the server's own
   *  poster for a fill row. Empty until whichever of them answers. */
  poster: string;
  /** The number the card prints, one for the whole band: TMDB's work-level figure, and the server's own
   *  rating only for a fill row TMDB has no number for. `0` prints nothing. */
  vote: number;
  /** How many ratings stand behind `vote`. TMDB's list carries it; a fill row has none to report, which
   *  only ever costs it a place in a queue it is appended to anyway. */
  votes: number;
  /** The library's own row, once the server has answered that it holds this work. */
  item: LibraryItem | null;
  /** Which server's name the card badges with, filled only for a card that has a row. A card the server has
   *  no answer for — in flight, or genuinely absent — carries nothing: the two are not tellable apart for
   *  the length of one request, and a badge is a promise about where the card leads. One account is active
   *  at a time today, so a row's server is this one; when the app holds two, this is where the row starts
   *  carrying its own. */
  server: string;
  /** Which list the card came out of. `pool` rows share this work's genres and nothing else — TMDB had
   *  nothing to say about the title, or said too little to fill the band — and a row of twelve of them is
   *  not 「相似作品」, so the strip relabels itself rather than let them read as though it were. */
  source: 'tmdb' | 'pool';
  /** The page a press opens. A row is known before the resolution lands, so this never moves. */
  to: string;
}

const CAP = 12;
const KIND_PARAM = (kind: WorkKind) => (kind === 'movie' ? 'Movie' : 'Series');
/** A 150 CSS px card on this machine's DPR 1.25 screen is 188 device px; w342 is TMDB's step above it and
 *  the one every other poster in the app is asked at. */
const TMDB_POSTER = 'https://image.tmdb.org/t/p/w342';

/** Where TMDB's number stops being one reader's opinion and becomes the title's standing. Measured over
 *  twelve sampled bands: every band's genuinely-watched rows carry hundreds of ratings (模范出租车 leads
 *  with 3,139) and the noise under them is single digits (1, 2, 5), so the cut sits between the two
 *  rather than on a number of its own. A row under it is not disqualified - it keeps the place TMDB's
 *  similarity order gave it. */
const RANK_MIN_VOTES = 10;
const rankKey = (c: RelatedCard): number => (c.votes >= RANK_MIN_VOTES ? c.vote : 0);

/** Every row this account files one work under, fullest first; `null` when the server did not answer.
 *
 *  The two answers are not the same and only one of them is an absence: `[]` is 「the library does not hold
 *  it」, `null` is a question still open, and a card that prints the first while the second is true is the
 *  false promise this module's whole 在途/确实没有 rule exists to stop. A failed ask is not cached, so the
 *  next visit asks again.
 *
 *  External-id filters do not work here, measured: `AnyProviderIdEquals` answers zero rows and `TmdbId=` /
 *  `Provider.tmdb=` are ignored outright, which dumps the whole library. `SearchTerm` does work, and the id
 *  check on the rows it returns is what turns a title match into the same work - a library of Chinese names
 *  has plenty of near misses to give.
 *
 *  The list, rather than its first row, because 81 of this library's shows are filed under several Series
 *  rows at once and the rows hold different seasons: a page that looked only at the fullest one would say
 *  「not on this server」 about a season the account really does have, two rows down. */
export function libraryWorks(kind: WorkKind, tmdbId: string | number, title: string): Promise<LibraryItem[] | null> {
  const id = String(tmdbId);
  return embyCached('libwork', { kind, tmdbId: id }, async () => {
    if (!title || !/^\d{1,8}$/.test(id)) return { ok: true, data: [] as LibraryItem[] };
    const r = await window.echoemby.emby.items({
      SearchTerm: title,
      IncludeItemTypes: KIND_PARAM(kind),
      Recursive: true,
      Limit: 10,
    });
    if (!r.ok) return { ok: false, error: r.error };
    const rows = (r.data || []).filter(x => String(x.providers?.tmdb || '') === id);
    rows.sort((a, b) => (b.childCount || 0) - (a.childCount || 0) || a.name.localeCompare(b.name));
    return { ok: true, data: rows };
  }).then(r => (r.ok ? r.data || [] : null));
}

/** Library rows that share this work's genres, for the only case TMDB's list leaves: fewer than twelve
 *  recommendations. One request, and the server's own rating does the ordering, so no cold TMDB ask is
 *  spent on a card that would have filled a gap anyway. */
function genrePool(kind: WorkKind, genres: string[]): Promise<LibraryItem[]> {
  const g = genres.slice(0, 3).join('|');
  if (!g) return Promise.resolve([]);
  return embyCached('libpool', { kind, genres: g }, () =>
    window.echoemby.emby.items({
      IncludeItemTypes: KIND_PARAM(kind),
      Genres: g,
      Recursive: true,
      Limit: 30,
      SortBy: 'CommunityRating',
      SortOrder: 'Descending',
    }),
  ).then(r => (r.ok ? r.data || [] : []));
}

const cardUrl = (kind: WorkKind, tmdbId: number): string => `/work/${kind}/${tmdbId}`;

/** The name the card badges a playable row with. Today the app plays one account at a time, so a row the
 *  server returned is this account's row; the day it holds two, this is where a row starts carrying its own
 *  server instead of borrowing the active one. */
const activeServer = (): string => {
  const a = useAppStore().account;
  return a ? accountName(a) : '';
};

/** How long the band waits for the server's answers before painting what it has.
 *
 *  The wait buys the order: a recommendation the account can play is worth more in the first three card
 *  widths than one it cannot, and only the server says which is which. Measured, twelve of those asks run
 *  side by side in 334 ms, so the wait is shorter than the TMDB round trip in front of it on a cold page
 *  and near zero on a warm one (`embyCached`). The cap is for the case the measurement cannot cover: a
 *  server that does not answer at all must leave a band on screen, not a hole. */
const REVEAL_MS = 1500;
/** The same courtesy for the pool's numbers: a band of rows whose figure has not arrived is painted in the
 *  server's order and re-cut by nothing, because nothing re-sorts after the paint. */
const POOL_MS = 1500;

/** The band for one work. It is assembled first and painted once: TMDB's list ranked by how many people
 *  gave its number, then split into what this account can play and what it cannot, with the genre pool
 *  taking the slots TMDB's list left short. Nothing is re-sorted after that first paint — a card that
 *  moved because the server answered is the layout change this band is kept free of, and the wait above
 *  is what buys the right to sort without moving anything. */
export function useRelated(get: () => WorkSeed | null | undefined): ComputedRef<RelatedCard[]> {
  const key = computed(() => {
    const s = get();
    return s && /^\d{1,8}$/.test(s.tmdbId) ? `${s.kind}:${s.tmdbId}` : '';
  });
  const cards = ref<RelatedCard[]>([]);
  /** One run per work. A card that answers after the reader has moved to another title is a write into
   *  the wrong band, and the strip is reused across a page-to-page switch. */
  let run = 0;

  /** The number a card prints, through the ladder every scored surface in this app climbs: TMDB's
   *  work-level figure, the server's own rating only where TMDB has none. The page a card opens prints
   *  TMDB's too, and a card that showed the server's figure then changed it mid-read is one title wearing
   *  two numbers - which is what the ladder exists to stop. */
  async function askVote(card: RelatedCard, alive: () => boolean): Promise<void> {
    const row = card.item;
    if (!row || card.vote || !alive()) return;
    const fallback = Number(row.communityRating) || 0;
    const tmdbId = String(row.providers?.tmdb || '');
    if (!/^\d{1,8}$/.test(tmdbId)) {
      card.vote = fallback;
      return;
    }
    const r = await window.echoemby.meta.tmdb({ kind: card.kind, tmdbId });
    if (!alive()) return;
    card.vote = (r.ok ? r.data?.voteAverage || 0 : 0) || fallback;
  }

  /** Library rows that share this work's genres, turned into cards for the slots TMDB's list left short.
   *  Every one of them is playable, because it came out of the library.
   *
   *  The server's own rating is what ordered the pool, but the number the card prints is TMDB's, and a row
   *  of visible figures that do not descend reads as a row in no order at all. So the pool's numbers are
   *  asked for before the band is painted and the pool is re-cut by them; the wait is bounded, and a row
   *  whose number did not come sits behind the rows that have one, in the server's own order. */
  async function fill(seed: WorkSeed, have: Set<string>, room: number, alive: () => boolean): Promise<RelatedCard[]> {
    const rows = await genrePool(seed.kind, seed.genres || []);
    const add: RelatedCard[] = [];
    for (const row of rows) {
      if (add.length >= room) break;
      const tmdbId = Number(row.providers?.tmdb) || 0;
      const k = tmdbId ? `${seed.kind}:${tmdbId}` : `emby:${row.id}`;
      if (have.has(k)) continue;
      have.add(k);
      add.push(
        reactive({
          key: k,
          kind: seed.kind,
          tmdbId,
          name: row.name,
          year: row.productionYear ? String(row.productionYear) : '',
          poster: '',
          vote: 0,
          votes: 0,
          item: row,
          server: activeServer(),
          source: 'pool',
          to: `/detail/${row.id}`,
        }),
      );
    }
    if (!alive() || !add.length) return add;
    await Promise.race([Promise.allSettled(add.map(c => askVote(c, alive))), new Promise(res => setTimeout(res, POOL_MS))]);
    if (!alive()) return add;
    add.sort((a, b) => (b.vote ? 1 : 0) - (a.vote ? 1 : 0) || b.vote - a.vote);
    return add;
  }

  /** The poster a card arrived without: TMDB never pictured it and the server's own row is the next
   *  thing that can. It replaces a letter inside a frame of its own, so it may land after the paint
   *  without moving a box. A number is asked for here too, but only for a card the paint went out
   *  without one - the pool's numbers are settled before it is drawn. */
  function hydrate(card: RelatedCard, mine: number): void {
    const row = card.item;
    if (!row) return;
    void askVote(card, () => mine === run);
    if (card.poster) return;
    void useAppStore()
      .itemArt(row, 342)
      .then(u => {
        if (mine === run && u) card.poster = u;
      });
  }

  watch(
    key,
    async k => {
      const mine = ++run;
      cards.value = [];
      const seed = get();
      if (!k || !seed) return;
      const r = await window.echoemby.meta.tmdbSimilar({ kind: seed.kind, tmdbId: seed.tmdbId });
      if (mine !== run) return;

      const have = new Set<string>([k]);
      const list: RelatedCard[] = [];
      for (const row of r.ok ? r.data || [] : []) {
        const ck = `${seed.kind}:${row.tmdbId}`;
        if (!row.title || have.has(ck)) continue;
        have.add(ck);
        /* Reactive from the first draft: an ask that answers after the paint writes into the card the page
           is already showing, and a write to the plain object behind it is seen by nothing - the pill stays
           off and the card keeps pointing at the page for a title the server does hold. The number is gated
           here as well as in the store, because a list cached before that gate still carries its ungated
           rows. */
        list.push(
          reactive({
            key: ck,
            kind: seed.kind,
            tmdbId: row.tmdbId,
            name: row.title,
            year: row.year || '',
            poster: row.posterPath ? `${TMDB_POSTER}${row.posterPath}` : '',
            vote: row.votes > 0 ? row.voteAverage || 0 : 0,
            votes: row.votes || 0,
            item: null,
            server: '',
            source: 'tmdb',
            to: cardUrl(seed.kind, row.tmdbId),
          }),
        );
      }
      /* Ranked by rating, but only where a rating is worth ranking by: a number one reader gave is their
         opinion, not the title's standing. Measured on 模范出租车's band, 寒枝折不断's 8.0 from a single
         rating used to sit above 铳墓's 7.4 from 85 people and 噩梦老师's 7.7 from 33. A row under the
         floor scores zero for ranking and so keeps TMDB's own similarity order, which is what the rest of
         the list already is - the array sort is stable, so a row below the floor is never moved by a
         tiebreak it did not ask for. */
      list.sort((a, b) => rankKey(b) - rankKey(a));

      /* Twelve asks at once, and the band waits for them: their answers are the order.
         Then one cut through that order, for the thing the ranking cannot know: measured over 16 sampled
         bands, a Movie page's twelve recommendations are held 2 times in 84 and a Series page's 18 in 96,
         so a band left in TMDB's order is twelve posters of titles this viewer cannot watch while the six
         they could play sit at positions they will not scroll to. Playable first, then the pool, then the
         rest — and no re-sort after the paint, because a card that moves is the layout change this band is
         kept free of. */
      await Promise.race([
        Promise.allSettled(
          list.map(card =>
            libraryWorks(card.kind, card.tmdbId, card.name).then(rows => {
              // `null` is a server that did not answer, not a library that does not hold it: the card keeps
              // its silence, prints no corner and stays pointed at the work page until some visit answers.
              if (!rows) return;
              /* The fullest row is where a press goes. Two rows of one split work overlap their season
                 numbers rather than continue each other (measured: 11 of 14 sampled), so the card cannot
                 promise a joined list - the work page is where the two are told apart. */
              const item = rows[0] || null;
              card.item = item;
              card.server = item ? activeServer() : '';
              if (item) card.to = `/detail/${item.id}`;
            }),
          ),
        ),
        new Promise(res => setTimeout(res, REVEAL_MS)),
      ]);
      if (mine !== run) return;

      const can = list.filter(c => c.item);
      const rest = list.filter(c => !c.item);
      const pool = list.length < CAP && seed.genres?.length ? await fill(seed, have, CAP - list.length, () => mine === run) : [];
      if (mine !== run) return;
      cards.value = [...can, ...pool, ...rest].slice(0, CAP);

      // Through the ref, not the objects built above: only writes to the reactive proxy are seen by the page,
      // and these two pieces — a poster, a number — arrive after the paint and must not move anything.
      for (const card of cards.value) void hydrate(card, mine);
    },
    { immediate: true },
  );

  return computed(() => cards.value);
}
