import { computed, reactive, ref, watch, type ComputedRef } from 'vue';
import type { LibraryItem } from '../../shared/types';
import { embyCached } from './embycache';
import { accountName } from './format';
import { useAppStore } from '../stores/app';

/** The band under a work: 「相似作品」, twelve cards, every one of them a page you can open.
 *
 *  TMDB's two look-alike lists are the part that knows what resembles this title — `/similar`, what is like
 *  it, and `/recommendations`, what viewers of it went on to watch. Measured over 18 sampled bands the two
 *  share not one title in their first twelve, and on the account that holds most of this library they carry
 *  34 and 67 playable rows against a merged 101, so the band is built out of both. They answer with outside
 *  ids and this app's pages are keyed by the server's, so each row is resolved back into the library: a
 *  title search with an id check, one ask per row. The merged list hands it up to twenty-four rows and
 *  measured three runs of two bands on the account that holds most of this library, that fan-out takes
 *  1.2 to 3.6 seconds: more than the window below, which is why the window is a deadline and not a fit,
 *  and why the rows that answer after the paint are written into cards already on screen.
 *
 *  That search is the one thing between a good list and a shelf you can press, and it fails on a spelling,
 *  not on a shelf: the library files 明日ちゃんのセーラー服 as 「明日同学的水手服」 while TMDB's Chinese row
 *  reads 「明日酱的水手服」, and the search answers no rows for a title the account holds. Hence the second
 *  ask, in the work's own language, on the row's `originalTitle`.
 *
 *  A row the library has no answer for is not a dead end either: it opens the work page, which TMDB's own
 *  entry can dress completely — seasons, episodes, credits, art — and only leaves out the file.
 *
 *  Where TMDB's list leaves slots empty the library's own same-genre rows fill them, up to half the shelf —
 *  see `POOL_CAP`, which exists because uncapped the fill took four fifths of it and the band stopped being
 *  about resemblance. */

export type WorkKind = 'movie' | 'tv';

/** The work the band belongs to. Held apart from `LibraryItem` because the page this feeds can be a work
 *  the server does not hold at all, and that page has the same three things and nothing else. */
export interface WorkSeed {
  kind: WorkKind;
  tmdbId: string;
  /** The work's own genres, which is what the pool asks the library with. Absent on a work page whose TMDB
   *  entry has not answered yet, and then the band has no pool to fall back on. */
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
/** How many of the twelve slots the genre pool may take. Measured on the live route over eleven detail
 *  pages, twice, with the pool uncapped: the fill took 107 and 94 of the 132 seats, because TMDB's merged
 *  list resolves to only a couple of playable rows a band on this account — so a shelf titled 「相似作品」
 *  was four fifths 「这片库里同类型的高分」. Six keeps the look-alikes at least half of their own shelf,
 *  and the rows this server does not hold go in after them rather than being cut, so an unreachable title
 *  still reads as a recommendation instead of vanishing. The pool takes all twelve only when TMDB's two
 *  lists answer with nothing at all, and such a band says 「同类高分」 because that is what it is. */
const POOL_CAP = 6;
const KIND_PARAM = (kind: WorkKind) => (kind === 'movie' ? 'Movie' : 'Series');
/** A 150 CSS px card on this machine's DPR 1.25 screen is 188 device px; w342 is TMDB's step above it and
 *  the one every other poster in the app is asked at. */
const TMDB_POSTER = 'https://image.tmdb.org/t/p/w342';

/** A title as the band compares titles: run together, lower-cased. The library and TMDB split the same name
 *  with spaces in different places, and a pool row that repeats a card already on the shelf should read as
 *  one work rather than as a duplicated poster. */
const titleKey = (s: string): string => s.replace(/\s+/g, '').toLowerCase();

/** Where a TMDB number stops being one reader's opinion and becomes the title's standing.
 *
 *  A number is pulled towards the middle by how thin its sample is — ten ratings' worth of "average title"
 *  counted in beside whatever the row actually scored — because the alternative was a floor: rows under ten
 *  ratings were given zero and sent to the bottom in TMDB's own order. Measured over the merged list, 83.1%
 *  of rows clear ten ratings and the rest sit in single digits, and seven whole bands (concert recordings:
 *  明日方舟 2024/2022, ZARD ×2, 蔡依林 J1, 《我爱南京》, Makihara) had no row over the floor at all, which made
 *  the ranking a no-op. A thin sample now costs a row its confidence instead of its place in line.
 *
 *  The card still prints TMDB's own figure — the shrinking orders the shelf, it does not invent a number
 *  for it. A row with no figure at all cannot be pulled anywhere, so it keeps the bottom and TMDB's order. */
const RANK_PRIOR = 6.5;
const RANK_MIX = 10;
const rankKey = (c: RelatedCard): number => {
  if (!c.vote) return -1;
  const v = Math.max(0, c.votes || 0);
  return (v * c.vote + RANK_MIX * RANK_PRIOR) / (v + RANK_MIX);
};

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
 *  「not on this server」 about a season the account really does have, two rows down.
 *
 *  `altTitle` is asked only when `title` found nothing, and it is asked because a zero-row answer is not
 *  always an absence. Measured on the live route: the library files tv:121792 as 「明日同学的水手服」, the
 *  ask for TMDB's Chinese name 「明日酱的水手服」 answers no rows, and the ask for the work's own name
 *  明日ちゃんのセーラー服 answers that row. The id check is what makes the second spelling safe: a near miss
 *  on a different work still answers as nothing. */
export function libraryWorks(kind: WorkKind, tmdbId: string | number, title: string, altTitle?: string): Promise<LibraryItem[] | null> {
  const id = String(tmdbId);
  /* Both spellings belong in the key, because this cache is shared: the hero, the season list, the detail
     page's sibling check and the prefetch all ask the same question under a different name, and a
     `SearchTerm` answer is only an answer about the string it was asked with. Keyed on the pair alone, the
     first of those could hand another its zero-row reply as if it were this one's — which is exactly the
     false absence the second spelling exists to undo. Same key only when the same two strings are asked. */
  return embyCached('libwork', { kind, tmdbId: id, term: title, alt: altTitle || '' }, async () => {
    if (!title || !/^\d{1,8}$/.test(id)) return { ok: true, data: [] as LibraryItem[] };
    const ask = async (term: string) => {
      const r = await window.echoemby.emby.items({
        SearchTerm: term,
        IncludeItemTypes: KIND_PARAM(kind),
        Recursive: true,
        Limit: 10,
      });
      if (!r.ok) return { ok: false as const, error: r.error };
      return { ok: true as const, rows: (r.data || []).filter(x => String(x.providers?.tmdb || '') === id) };
    };
    const first = await ask(title);
    if (!first.ok) return { ok: false, error: first.error };
    let rows = first.rows;
    if (!rows.length && altTitle && altTitle !== title) {
      // A failed second ask cannot unread a first that said 「nothing」; it stays the absence it was.
      const again = await ask(altTitle);
      if (again.ok) rows = again.rows;
    }
    rows.sort((a, b) => (b.childCount || 0) - (a.childCount || 0) || a.name.localeCompare(b.name));
    return { ok: true, data: rows };
  }).then(r => (r.ok ? r.data || [] : null));
}

/** Library rows that share this work's genres, for the slots TMDB's list leaves short — up to `POOL_CAP`
 *  of them, which is what keeps the shelf a similarity band. One request, and the server's own rating does
 *  the ordering, so no cold TMDB ask is spent on a card that would have filled a gap anyway. */
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
 *  widths than one it cannot, and only the server says which is which. Measured over three runs of two
 *  bands, the twenty-four asks one cold band fires at once take 1.2 to 3.6 seconds; on a warm route the
 *  whole band answers in 0.2s, because `embyCached` holds these rows. So this number is a deadline the
 *  cold fan-out usually misses, not a fit: what it guarantees is only that a server which does not answer
 *  at all still leaves a band on screen rather than a hole, and the rows that answer after it answer into
 *  cards the page is already showing. Exported because the work page gives TMDB's own detail ask the same
 *  window: one clock decides how long any half of the page may keep the reader waiting. */
export const REVEAL_MS = 1500;
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

  /** Library rows that share this work's genres, turned into cards for the slots the band is short of.
   *  Every one of them is playable, because it came out of the library.
   *
   *  `names` is the shelf's own list of titles and a row already standing on it is skipped, because the
   *  pool asks by genre and the library files one work under several rows: measured, 低俗小说 arrived twice
   *  in one band at the server's 8.5 and 8.482, which reads as a duplicated poster rather than two films.
   *
   *  The server's own rating is what ordered the pool, but the number the card prints is TMDB's, and a row
   *  of visible figures that do not descend reads as a row in no order at all. So the pool's numbers are
   *  asked for before the band is painted and the pool is re-cut by them; the wait is bounded, and a row
   *  whose number did not come sits behind the rows that have one, in the server's own order. */
  async function fill(seed: WorkSeed, pool: Promise<LibraryItem[]>, have: Set<string>, names: Set<string>, room: number, alive: () => boolean): Promise<RelatedCard[]> {
    const rows = await pool;
    const add: RelatedCard[] = [];
    for (const row of rows) {
      if (add.length >= room) break;
      const tmdbId = Number(row.providers?.tmdb) || 0;
      const k = tmdbId ? `${seed.kind}:${tmdbId}` : `emby:${row.id}`;
      if (have.has(k)) continue;
      const tk = titleKey(row.name);
      if (tk && names.has(tk)) continue;
      have.add(k);
      names.add(tk);
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
      .then(rungs => {
        if (mine === run && rungs.length) card.poster = rungs[0];
      });
  }

  watch(
    key,
    async k => {
      const mine = ++run;
      cards.value = [];
      const seed = get();
      if (!k || !seed) return;
      const r = await window.echoemby.meta.tmdbRelated({ kind: seed.kind, tmdbId: seed.tmdbId });
      if (mine !== run) return;

      const have = new Set<string>([k]);
      const names = new Set<string>();
      /** The card key → the work's name in its own language, for the second ask `libraryWorks` may make.
       *  Kept out here rather than on the card: the strip shows a name, and a card carrying TMDB's two
       *  spellings of one title would be a field nothing draws. */
      const alt = new Map<string, string>();
      const list: RelatedCard[] = [];
      for (const row of r.ok ? r.data || [] : []) {
        const ck = `${seed.kind}:${row.tmdbId}`;
        if (!row.title || have.has(ck)) continue;
        have.add(ck);
        names.add(titleKey(row.title));
        if (row.originalTitle) alt.set(ck, row.originalTitle);
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
      /* Ranked by how much weight stands behind TMDB's number — see `rankKey`, which retired the ten-rating
         floor that used to score a thin row as zero. The array sort is stable, so a row that comes out level
         with its neighbours keeps the place the two lists gave it. */
      list.sort((a, b) => rankKey(b) - rankKey(a));

      /* One ask per row, all of them at once, and the band waits for the answers because they are the order.
         Then one cut through that order, for the thing the ranking cannot know: measured over 18 sampled
         bands on the account that holds the most of this library, a merged list of twenty-four rows carries
         5.6 the viewer can actually play, and on the other account 2.3 — while 7 of its 18 bands could play
         not one. A band left in TMDB's order is therefore a shelf of posters this viewer cannot watch.
         Playable first, then the pool, then the rest — and no re-sort after the paint, because a card that
         moves is the layout change this band is kept free of. */
      /* The pool request goes out before the playability asks, not after them: asked only once the shelf
         turned out short, it put a whole round trip on the critical path behind the paint. Measured over
         eleven detail pages — first card 1485ms before any of this, 2799ms and 2103ms in two runs of the
         build that asked for the pool afterwards, 1516ms now. It costs a request on the band that turns out
         to need nothing, and `embyCached` folds that for the ten minutes a genre combination is reused. */
      const pool = seed.genres?.length ? genrePool(seed.kind, seed.genres) : Promise.resolve([] as LibraryItem[]);
      await Promise.race([
        Promise.allSettled(
          list.map(card =>
            libraryWorks(card.kind, card.tmdbId, card.name, alt.get(card.key)).then(rows => {
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
      /* Short of twelve is counted in what this account can play, not in posters on screen. The old trigger
         was `list.length < CAP`, which measured as unreachable: over 97 cached merged bands TMDB's pair came
         back full 94 times, empty once and short twice (both at twelve rows) — so the shelf that held twelve
         posters and no files at all was a shelf nothing could reach.

         What the pool may then take is `POOL_CAP`, and the whole shelf only when TMDB answered with nothing
         at all. Keying the full shelf on 「not one row playable」 instead measured as a lie on a cold first
         visit: the asks above cut off at `REVEAL_MS`, so a slow answer looks exactly like an absent title,
         and six of thirteen OkEmby bands painted 「同类高分」 with twelve fill rows while the look-alikes
         were still in flight — 搏击俱乐部 among them, which on the same page a minute later carried twelve
         look-alikes out of its own library. A row still in flight keeps its slot and badges in place when it
         lands, which moves nothing. */
      const room = list.length ? Math.min(CAP - can.length, POOL_CAP) : CAP;
      const taken = await fill(seed, pool, have, names, room, () => mine === run);
      if (mine !== run) return;
      cards.value = [...can, ...taken, ...rest].slice(0, CAP);

      // Through the ref, not the objects built above: only writes to the reactive proxy are seen by the page,
      // and these two pieces — a poster, a number — arrive after the paint and must not move anything.
      for (const card of cards.value) void hydrate(card, mine);
    },
    { immediate: true },
  );

  return computed(() => cards.value);
}
