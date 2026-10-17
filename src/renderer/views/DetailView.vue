<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { LibraryItem, MediaStreamInfo, PlaybackSource, TmdbCreditRow, TmdbCredits, TmdbEpisodeRow, TmdbSeasonRow, TmdbSimilar, TmdbStills } from '../../shared/types';
import HScroller from '../components/detail/HScroller.vue';
import BlockPh from '../components/detail/BlockPh.vue';
import ScoreStrip from '../components/ScoreStrip.vue';
import HeroPlay from '../components/HeroPlay.vue';
import TitleArt from '../components/TitleArt.vue';
import HeroSkeleton from '../components/HeroSkeleton.vue';
import { tmdbKind as kindOf, trustSeason, useScores } from '../lib/scores';
import { usePlayerStore } from '../stores/player';
import { useAppStore } from '../stores/app';
import { episodePosition, fmtDate, fmtDateTime, fmtRuntime, isPositionOnlyName, seenLabel, seasonTitle } from '../lib/format';
import { resumeTarget } from '../lib/resume';
import { genreLabels } from '../lib/genres';
import { embyCached } from '../lib/embycache';
import { seedFor, seedItemFor, seedTypeFor } from '../lib/handoff';
import { vReveal } from '../lib/reveal';

const props = defineProps<{ id: string }>();
const router = useRouter();
const player = usePlayerStore();
const app = useAppStore();

const item = ref<LibraryItem | null>(null);
const seasons = ref<LibraryItem[]>([]);
const episodes = ref<LibraryItem[]>([]);
const seasonId = ref('');
/** Which season the rows now in `episodes` were read for. The list keeps its height across a switch, so
 *  without this the hero would print the season being left's length under the new one's date. */
const episodeSeason = ref('');
/** The series above a Season item. The server files the favourite, the external ids and every
 *  work-level question there, so a page opened on one season still needs its parent. */
const seriesItem = ref<LibraryItem | null>(null);
/** The picked season's own art from the server, the one season field that costs a round trip. */
const seasonArt = ref('');
const error = ref('');
const playErr = ref('');
const favBusy = ref(false);
/** A sibling switch (详情 -> 详情) reuses this instance, so the old title dims out and the new one dims
 *  in rather than the page collapsing to a loading line and rebuilding: measured 2079px -> 816px ->
 *  2242px of height with scrollTop clamped 700 -> 0 on every switch. */
const swap = ref(false);

const similar = ref<TmdbSimilar[]>([]);
const stills = ref<TmdbStills>({});
const backdrops = ref<string[]>([]);

/** The hero parallaxes and its copy fades against the page's own scroll, the way the lobby does. */
const scroller = ref<HTMLElement | null>(null);
const scroll = ref(0);
function onScroll(): void {
  scroll.value = scroller.value?.scrollTop || 0;
}

const isSeries = computed(() => item.value?.type === 'Series');
const isSeason = computed(() => item.value?.type === 'Season');

/** The work this page belongs to. A Season row carries neither the external ids the sources key on nor
 *  the favourite the server filed, so every question that has no season-level answer goes to its series. */
const work = computed(() => (isSeason.value ? seriesItem.value || item.value : item.value));

/** The six score sources, asked once per title; TMDB's answer also carries the season table the hero
 *  reads its date, art and synopsis off. */
const scores = useScores(() => work.value);

// The server files its people on the series and never on a season row (measured: 0 on every Season
// page sampled), so a page opened on one season reads the show it belongs to rather than nobody.
const people = computed(() => work.value?.people || []);
const ROLE_LABEL: Record<string, string> = { Director: '导演', Writer: '编剧', Producer: '制片' };
interface CrewRow {
  id: string;
  name: string;
  imageTag?: string;
  sub: string;
  /** Already a full URL, for the heads TMDB rather than the server dresses. */
  face?: string;
}
/** The season on screen as TMDB bills it; null until both sides are believed about which season
 *  this is. */
const seasonCast = ref<TmdbCredits | null>(null);

/* Whichever TMDB list actually bills the thing on screen, once it is at least as full as the server's.
 *  For a season that means its own credits — measured, 鬼灭之刃 S1 answers 1 cast row where the server
 *  holds 6 and 物语系列 5 against 12, so those keep the show's list — while 模范出租车 S1's 19 rows against
 *  5, every name in Chinese where the server's are romanised, is both fuller and the one describing the
 *  season. A movie needs no such ask: the title request already carries its whole cast, and the same
 *  test says whether to believe it (八佰 34 Chinese names against the server's 24 romanised, 霸王别姬
 *  24 against 0, 爱情公寓 13 against 0, while 007 answers 62 rows of which 19 are Chinese). */
const tmdbCast = computed<TmdbCredits | null>(() => {
  const enough = (c: TmdbCredits | null | undefined) =>
    c && c.act.length + c.dir.length + c.write.length >= Math.max(3, people.value.length) ? c : null;
  const season = enough(seasonCast.value);
  if (season) return season;
  return item.value?.type === 'Movie' ? enough(scores.value.tmdb?.cast) : null;
});

/** Directors, writers and producers share one avatar band with the cast — the reference shows a single
 *  row of circular heads, the role label underneath telling them apart, not a text credit list on top. */
const crew = computed<CrewRow[]>(() => {
  const sc = tmdbCast.value;
  if (sc) {
    const rows: CrewRow[] = [];
    const add = (list: TmdbCreditRow[], kind: string) => {
      for (const p of list) rows.push({ id: `tm:${kind}:${p.name}`, name: p.name, sub: p.sub || kind, face: p.img ? faceUrl(p.img) : undefined });
    };
    add(sc.dir, '导演');
    add(sc.write, '编剧');
    add(sc.act, '演员');
    return rows.slice(0, 30);
  }
  const order: Record<string, number> = { Director: 0, Writer: 1, Producer: 2, Actor: 3 };
  const seen = new Set<string>();
  const out: CrewRow[] = [];
  for (const p of [...people.value].sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9))) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ id: p.id, name: p.name, imageTag: p.imageTag, sub: p.type === 'Actor' ? p.role || '' : ROLE_LABEL[p.type] || p.role || '' });
  }
  // Server carries no writers for this library, so TMDB's fill the gap rather than losing the credit.
  if (!people.value.some(p => p.type === 'Writer')) {
    for (const w of scores.value.tmdb?.writers || []) out.push({ id: `tw:${w}`, name: w, sub: '编剧' });
  }
  return out.slice(0, 30);
});
/** The work's own synopsis, in the order the page falls back once a season has nothing to say: TMDB in
 *  Chinese, then whatever the server carries, then TMDB in whatever language it happens to have. The
 *  middle step exists because TMDB records no synopsis at all for much of this library's non-Asian
 *  titles, while the server usually has one. */
const workOverview = computed(
  () => scores.value.tmdb?.overviewZh || item.value?.overview || scores.value.tmdb?.overviewOther || '',
);

const source = computed<PlaybackSource | undefined>(() => item.value?.sources?.[0]);
const vstream = computed(() => source.value?.video);
const astream = computed<MediaStreamInfo | undefined>(() => {
  const a = source.value?.audio || [];
  return a.find(x => x.isDefault) || a[0];
});

/** What this page will be, from the server's item when there is one and from the clicked card when there
 *  is not yet — an Episode card opens its Season, and that is enough to know a rail is coming. */
const pageType = computed(() => item.value?.type || seedTypeFor(props.id));
/** The two arrivals tall enough to be felt: the season rail (370px, and the last thing to land) and the
 *  file's technical block (487px). Both sit above other blocks, so each one pushed the rest of the page
 *  down while the reader was already looking at it. Their heights are claimed here and filled in place. */
const wantRail = computed(() => (pageType.value === 'Series' || pageType.value === 'Season') && !episodes.value.length);
const wantTech = computed(() => pageType.value === 'Movie' && !source.value);

/** image.tmdb.org answers directly on this machine (the API host needs the system proxy). */
const stillRow = (ep: number | undefined): TmdbEpisodeRow | undefined => (ep == null ? undefined : stills.value[ep]);
const stillUrl = (ep: number | undefined): string => {
  const p = stillRow(ep)?.p;
  return p ? `https://image.tmdb.org/t/p/w500${p}` : '';
};
/** The episode's own paragraph, in the order the work-level one above it uses: TMDB in Chinese, then the
 *  server's line, then TMDB in whatever else it filed. The server carries no overview for 475 of the
 *  library's 600 sampled episodes, and TMDB's line for each of them arrives inside the season reply the
 *  pictures were already being asked for. */
const epOverview = (e: LibraryItem): string => {
  const r = stillRow(e.indexNumber);
  return r?.ovZh || e.overview || r?.ovOther || '';
};
const posterUrl = (p?: string): string => (p ? `https://image.tmdb.org/t/p/w342${p}` : '');
const backdropUrl = (p: string): string => `https://image.tmdb.org/t/p/w780${p}`;
/** The band draws each head at 110px, which is 137.5 device px at this window; w185 is the smallest
 *  tier above that, and the largest one TMDB documents for a profile crop. */
const faceUrl = (p: string): string => `https://image.tmdb.org/t/p/w185${p}`;

/** One index into backdrops drives the whole viewer. Which way the last move went decides how the two
 *  frames slide; 0 means the viewer just opened, so the first frame only fades up. */
const viewer = ref<number | null>(null);
const vdir = ref(0);
const strip = ref<HTMLElement | null>(null);

/** w1920 is the largest TMDB still serves and it is exactly what the window holds at DPR 1.25; the
 *  row's own w780 stays underneath as the soft stand-in while the big frame arrives. */
const bigUrl = (p: string): string => `https://image.tmdb.org/t/p/w1920${p}`;
const current = computed(() => (viewer.value == null ? '' : backdrops.value[viewer.value] || ''));

function openViewer(i: number): void {
  vdir.value = 0;
  viewer.value = i;
}
function stepViewer(dir: number): void {
  const i = viewer.value;
  const n = backdrops.value.length;
  if (i == null || n < 2) return;
  vdir.value = dir;
  viewer.value = (i + dir + n) % n;
}
function jumpViewer(i: number): void {
  const at = viewer.value;
  if (at == null || i === at) return;
  vdir.value = i > at ? 1 : -1;
  viewer.value = i;
}
/** The strip is a horizontal rail, so a normal wheel over it should push it sideways rather than scroll nothing. */
function onStripWheel(e: WheelEvent): void {
  if (strip.value) strip.value.scrollLeft += e.deltaY || e.deltaX;
}
function onViewerKey(e: KeyboardEvent): void {
  if (viewer.value == null) return;
  if (e.key === 'Escape' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.stopPropagation();
  if (e.key === 'Escape') viewer.value = null;
  else if (e.key === 'ArrowLeft') stepViewer(-1);
  else if (e.key === 'ArrowRight') stepViewer(1);
}

watch(viewer, i => {
  if (i == null) return;
  // The arrows ask for one of the two neighbours next, so pull them in while this frame is on screen.
  const n = backdrops.value.length;
  for (const d of [-1, 1]) {
    const p = backdrops.value[(i + d + n) % n];
    if (p) new Image().src = bigUrl(p);
  }
  void nextTick(() => (strip.value?.children[i] as HTMLElement | undefined)?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }));
});

/* Capture phase, because the titlebar owns Esc as 「go home」 on the same window and registers before this
   view mounts; listening in the bubble phase would close the still and bounce out of the page with it. */
onMounted(() => window.addEventListener('keydown', onViewerKey, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onViewerKey, true));

const faces = ref<Record<string, string>>({});
watch(
  crew,
  list => {
    for (const p of list) {
      if (!p.imageTag || faces.value[p.id]) continue;
      void app.imageUrl({ id: p.id, primaryImageTag: p.imageTag }, 110).then(url => (faces.value[p.id] = url));
    }
  },
  { immediate: true },
);

const epArt = ref<Record<string, string>>({});
watch(
  episodes,
  list => {
    // Only the server URL is cached; the TMDB still arrives later so the template reads it at render time.
    for (const e of list) {
      if (!e.primaryImageTag || epArt.value[e.id]) continue;
      void app.imageUrl({ id: e.id, primaryImageTag: e.primaryImageTag }, 520).then(url => (epArt.value[e.id] = url));
    }
  },
  { immediate: true },
);

const heroBackdrop = ref('');
const heroPoster = ref('');
/** What the plate paints, in the order the season decides it: TMDB's own poster for that season, then the
 *  server's season art, then the work's poster for a season neither side dresses in its own picture. The
 *  card art this page was opened from sits behind all three: it paints the first frame so the plate is
 *  never empty, and the season's own picture takes it over as soon as that picture is known. Measured on
 *  Ted Lasso, handing the seed the top of this ladder instead left the plate on the series poster through
 *  chips 1, 2 and 3 while its date, 集数, rating and credit band all moved with the season. */
const tmdbPlate = computed(() => posterUrl(tmdbSeason.value?.poster));
const plateSrc = computed(() => tmdbPlate.value || seasonArt.value || heroPoster.value || seedFor(props.id));
/** Ranked title treatments for this item; TitleArt walks them and falls back to the name. */
const titleUrls = ref<string[]>([]);

/** The 在看 rows the lobby pulled, still in hand on this page. `resume` reads them before it reads the
 *  season, so nothing here waits for a request to know where the viewer stopped. */
const resumeRow = computed(() => app.rows.find(r => r.key === 'resume')?.items || []);
/** The row this hero is about, as the shared button reads it: null when nothing has been started.
 *  The rows above go in first because they cost no request: a Series used to paint a bare 「播放」 while the
 *  season query was in flight and only then grow its caption, and that step measured 156 -> 290px taken off
 *  the top of the synopsis - the paragraph re-wrapped one beat after the hero had already arrived. Joining
 *  the same row as the lobby also keeps the two buttons honest: same title, same stopped episode, no matter
 *  which one was clicked. */
const resume = computed(() =>
  resumeTarget(item.value, isSeries.value || isSeason.value ? [...resumeRow.value, ...episodes.value] : []),
);
/** The one item the play button is about: the episode still in progress, else the first of the season.
 *  Everything the button says and plays comes from here, so the two cannot disagree. */
const playTarget = computed<LibraryItem | null>(
  () => resume.value?.item || ((isSeries.value || isSeason.value) ? episodes.value[0] || null : item.value),
);
const playableId = computed(() => playTarget.value?.id || '');
/** The season the row is asking about: an episode carries its own number when the gateway feels like
 *  answering, otherwise the season tab that is open - or this page itself, when it is a Season item. */
const seasonOf = (e: LibraryItem): number | null =>
  e.parentIndexNumber ?? seasons.value.find(x => x.id === seasonId.value)?.indexNumber ?? item.value?.indexNumber ?? null;
const epPos = (e: LibraryItem): string => episodePosition(seasonOf(e), e.indexNumber) || (e.name || '').trim();
/** The row's headline is the position, not the server's episode name: the name is what duplicates the
 *  「第 2 集」 the position already spells out, and it only earns its place when it says more. */
const epTitle = (e: LibraryItem): string => {
  const name = (e.name || '').trim();
  const pos = epPos(e);
  return !name || name === pos || isPositionOnlyName(name) ? pos : `${pos} · ${name}`;
};
const epSeen = (e: LibraryItem): string => seenLabel(e.userData?.playedPercentage, e.runTimeTicks);
const epPlayed = (e: LibraryItem): number => Math.min(100, e.userData?.playedPercentage || 0);

const genres = computed(() => genreLabels(work.value?.genres));
const premiered = computed(() => fmtDate(item.value?.premiereDate) || String(item.value?.productionYear || ''));

/** The season this page is answering for: the open tab on a Series, the item itself on a Season page. */
const seasonRow = computed<LibraryItem | null>(
  () => seasons.value.find(x => x.id === seasonId.value) || (isSeason.value ? item.value : null),
);
const seasonNumber = computed(() => seasonRow.value?.indexNumber ?? item.value?.indexNumber ?? null);

/* TMDB and this server do not always count the same season. The threshold and the sweep that picked it
   live in `trustSeason`, because the player's season chips have to refuse the same pairings this page does. */
const trustRow = (n?: number | null, count?: number): TmdbSeasonRow | null => trustSeason(scores.value.tmdb?.seasons, n, count);
const tmdbSeason = computed(() => trustRow(seasonNumber.value, seasonRow.value?.childCount));

/* Asked from a watch rather than from `loadEpisodes`, because the trust test needs TMDB's meta and
   that usually lands after the first episode ask has already gone out. The answer is also held here,
   keyed the same way: a switch back to a season the page already billed must repaint its band from
   what is in hand, since the dedupe below deliberately skips asking for it twice. */
const castAsked = new Set<string>();
const castByKey = new Map<string, TmdbCredits>();
/** The key a season's credits are asked and held under; empty while there is no season both sides
 *  believe, since an unbelieved season has no TMDB list to prefer. A function rather than an inline
 *  getter because `loadEpisodes` has to look up the same key the watch is about to ask for. */
const castKey = (): string => {
  const id = String(work.value?.providers?.tmdb || '');
  return tmdbSeason.value && seasonNumber.value != null && /^\d{1,8}$/.test(id)
    ? `${seasonId.value}|${seasonNumber.value}|${id}`
    : '';
};
watch(castKey, key => {
  if (!key) return;
  const hit = castByKey.get(key);
  if (hit) {
    seasonCast.value = hit;
    return;
  }
  if (castAsked.has(key)) return;
  castAsked.add(key);
  const [, n, id] = key.split('|');
  const sid = seasonId.value;
  void window.echoemby.meta.tmdbSeasonCast({ tmdbId: id, season: Number(n) }).then(x => {
    if (!x.ok || !x.data) return;
    castByKey.set(key, x.data);
    if (seasonId.value === sid) seasonCast.value = x.data;
  });
});

/* The stills ride the same gate as the art, the date, the synopsis and the credits, and for the same
   reason: asked off the server's raw season number, a pairing `trustRow` refuses (800 Meters' 1 against
   TMDB's 3) would still dress this season's episode cards with another season's pictures. Keyed the same
   way and held the same way, because `loadEpisodes` clears the map on every switch and a switch back has
   to repaint from what is in hand rather than wait out a second ask. */
const stillsAsked = new Set<string>();
const stillsByKey = new Map<string, TmdbStills>();
const stillsKey = (): string => {
  const id = String(work.value?.providers?.tmdb || '');
  return tmdbSeason.value && seasonNumber.value != null && /^\d{1,8}$/.test(id)
    ? `${seasonId.value}|${seasonNumber.value}|${id}`
    : '';
};
watch(stillsKey, key => {
  if (!key) return;
  const hit = stillsByKey.get(key);
  if (hit) {
    stills.value = hit;
    return;
  }
  if (stillsAsked.has(key)) return;
  stillsAsked.add(key);
  const [, n, id] = key.split('|');
  const sid = seasonId.value;
  void window.echoemby.meta.tmdbStills({ tmdbId: id, season: Number(n) }).then(x => {
    if (!x.ok || !x.data) return;
    stillsByKey.set(key, x.data);
    if (seasonId.value === sid) stills.value = x.data;
  });
});

/** What the hero prints for the season on screen. Derived rather than stored: a switch that writes one
 *  ref per field is one forgotten clear away to showing last season's synopsis under this season's name. */
const pack = computed(() => {
  const row = seasonRow.value;
  const t = tmdbSeason.value;
  if (!row && !t) return null;
  const label = seasonTitle(seasonNumber.value, row?.name, t?.name);
  return {
    label,
    /** The same season without the subtitle it may carry, for the one place the sentence has to stay
     *  short: 爱的迫降's first season is filed as 「全 1 季」, so the hero reads 「第 1 季 · 全 1 季」 and a
     *  tooltip that repeated it would read as a stumble. */
    tag: seasonNumber.value != null && seasonNumber.value > 0 ? `第 ${seasonNumber.value} 季` : label,
    date: fmtDate(t?.airDate) || fmtDate(row?.premiereDate) || premiered.value,
    eps: row?.childCount ?? t?.epCount ?? 0,
    /* The season's length summed from the rows in hand, and only when those rows are this season's. The
       server's Series-level RunTimeTicks is neither this season's nor any episode's (measured: 64 分钟 for a
       season that runs 17 小时 18 分), so there is no cheaper number to put here while the fetch is out. */
    runtime: episodeSeason.value === seasonId.value ? fmtRuntime(episodes.value.reduce((a, e) => a + (e.runTimeTicks || 0), 0)) : '',
    vote: t?.voteAverage || 0,
    overview: t?.ovZh || row?.overview || t?.ovOther || '',
  };
});
const overviewText = computed(() => pack.value?.overview || workOverview.value);

/** 「2021-04-09 · 16 集 · 17小时18分」 for the season on screen. A work with no seasons keeps its own
 *  line, and a collection counts 部 rather than 季. */
const metaLine = computed(() => {
  const p = pack.value;
  const parts = p
    ? [p.date, p.eps ? `${p.eps} 集` : '', p.runtime]
    : [
        premiered.value,
        item.value?.childCount ? `${item.value.childCount} ${item.value.type === 'BoxSet' ? '部' : '季'}` : '',
        // A show's own RunTimeTicks is neither its seasons' nor its episodes' — measured 64 分钟 for a
        // season that runs 17 小时 18 分 — so the one line that number belongs to stays empty until the
        // season rows arrive and `pack` can sum a real one.
        isSeries.value || isSeason.value ? '' : fmtRuntime(item.value?.runTimeTicks),
      ];
  return parts.filter(Boolean).join(' · ');
});

/** The one work-level number a season view still owes the reader: how big the whole show is. */
const seriesTotal = computed(() => {
  const n = seasons.value.length;
  if (n < 2) return '';
  const eps = seasons.value.reduce((a, s) => a + (s.childCount || 0), 0);
  return `全 ${n} 季${eps ? ` · ${eps} 集` : ''}`;
});

const fav = computed(() => !!work.value?.userData?.isFavorite);

async function loadEpisodes(sid: string, seriesId = props.id) {
  seasonId.value = sid;
  // Whatever belonged to the season being left goes before anything new is asked for: an old season's
  // stills would otherwise hang on the new season's episode numbers for the few hundred ms TMDB takes,
  // and its art would dress the new one. The episode row keeps its height, so the page does not jump.
  // The stills and the credits are repainted from the key this season is asked under rather than blanked:
  // clicking the season already on screen re-enters here, and the watches do not fire for a key they have
  // already seen, so a blind clear would drop this season's pictures for the rest of the visit.
  stills.value = stillsByKey.get(stillsKey()) || {};
  seasonArt.value = '';
  seasonCast.value = castByKey.get(castKey()) || null;
  if (!sid) return;
  const row = seasonRow.value;
  if (row?.primaryImageTag) {
    void app.imageUrl({ id: row.id, primaryImageTag: row.primaryImageTag }, 300).then(u => {
      if (seasonId.value === sid) seasonArt.value = u;
    });
  }
  const r = await embyCached('episodes', { seriesId, seasonId: sid }, () => window.echoemby.emby.episodes({ seriesId, seasonId: sid }));
  if (r.ok && seasonId.value === sid) {
    episodes.value = r.data || [];
    episodeSeason.value = sid;
  }
  if (isSeason.value) await loadSeries(seriesId);
}

/** The series above a Season item. A season row carries no external id, so TMDB, the score sources and
 *  the favourite the server filed can only be reached through this. Read through the Emby cache, so a
 *  page that already asked for the series costs nothing here. */
async function loadSeries(seriesId: string): Promise<LibraryItem | null> {
  if (!seriesId) return null;
  if (seriesItem.value?.id === seriesId) return seriesItem.value;
  const page = props.id;
  const r = await embyCached('item', seriesId, () => window.echoemby.emby.item(seriesId));
  const it = r.ok ? r.data || null : null;
  // A switch to another title while this is out must not dress the new page in the previous work.
  if (it && props.id === page) {
    seriesItem.value = it;
    /* A season row often carries no art at all (measured: 模范出租车's seasons 1 and 2 have neither a
       Primary nor a Backdrop tag), which left the hero a flat gradient. TMDB has no season-wide shot
       either, so the work's own backdrop is the stand-in the ladder calls for. */
    if (!item.value?.backdropImageTag && !item.value?.primaryImageTag && it.backdropImageTag)
      void app.backdropUrl({ id: it.id, backdropImageTag: it.backdropImageTag }, 1600).then(u => (props.id === page ? (heroBackdrop.value = u) : u));
  }
  return it;
}

/** A chip reads the season's own subtitle when it has one (「第 1 季 · 立志篇」, 「第 4 季 · 最终季」) and
 *  nothing but the number when its name only repeats the position (「季 3」, 「Season 1」). TMDB's name for
 *  the same season is the second candidate, for the rows this server left plainly numbered. */
const chipLabel = (s: LibraryItem): string => seasonTitle(s.indexNumber, s.name, trustRow(s.indexNumber, s.childCount)?.name);

/** Which title the once-per-title asks (logo band, TMDB's similar titles and its stills) have been made
 *  for. The row and the server's copy of it are the same work, so the second paint refines the item
 *  without paying for them again. */
let painted = '';
/** The same rule for the season list and its episodes: re-loading the rail when the server's copy lands
 *  would step on a season the reader may already have picked. */
let loaded = '';

/** Everything the page can draw from an item alone. A row from any list carries the name, the art tags,
 *  the genres, the rating, the runtime and where the viewer stopped; only the cast, the tagline and the
 *  file's technical block are detail-only, so this runs twice: once for the row, once for the answer. */
function paint(it: LibraryItem): void {
  const id = it.id;
  item.value = it;
  // Every art ask is fired rather than awaited. They were measured serial at 493ms for the hero, and the
  // three of them have no order to keep: each writes its own slot when it answers. 300px is the plate at
  // its widest on this window; the 1000px backdrop copy would be scaled away by it.
  if (it.primaryImageTag) void app.imageUrl({ id: it.id, primaryImageTag: it.primaryImageTag }, 300).then(u => (props.id === id ? (heroPoster.value = u) : u));
  if (it.backdropImageTag)
    void app.backdropUrl({ id: it.id, backdropImageTag: it.backdropImageTag }, 1600).then(u => (props.id === id ? (heroBackdrop.value = u) : u));
  else if (it.primaryImageTag) {
    // No wide art on the server: reuse the poster as a soft backdrop rather than a flat gradient.
    void app.imageUrl({ id: it.id, primaryImageTag: it.primaryImageTag }, 1000).then(u => (props.id === id ? (heroBackdrop.value = u) : u));
  }

  if (painted === id) return;
  painted = id;
  /* The season state goes the moment a different title takes the page over — not earlier, because the
     outgoing hero is still on screen and reading it, and not never, because `seasonRow` looks its id up
     in the previous show's season list: measured, walking 咒术回战 → 007 left 「2023-07-06 · 59 集 ·
     24小时6分」 printed under a movie that has neither episodes nor seasons. */
  seasons.value = [];
  seasonId.value = '';
  episodes.value = [];
  episodeSeason.value = '';
  stills.value = {};
  seasonArt.value = '';
  seasonCast.value = null;
  // A Season row carries no external id and no Logo, so every ask below would be made against nothing.
  // On those pages they come with the series, from loadChildren.
  if (it.type === 'Season') return;
  askWork(it);
}

/** The title's own three asks: its ranked treatments, TMDB's similar titles, its backdrop strip. None of
 *  them has a season-level answer, so a Season page runs them for the series above it. */
function askWork(series: LibraryItem): void {
  const page = props.id;
  void app.logoCandidates(series).then(u => (props.id === page ? (titleUrls.value = u) : undefined));
  const kind = kindOf(series);
  const tmdbId = String(series.providers?.tmdb || '');
  if (!kind || !/^\d{1,8}$/.test(tmdbId)) return;
  void window.echoemby.meta.tmdbSimilar({ kind, tmdbId }).then(x => (props.id === page ? (similar.value = x.ok ? x.data || [] : []) : undefined));
  void window.echoemby.meta.tmdbImages({ kind, tmdbId }).then(x => (props.id === page ? (backdrops.value = x.ok ? x.data || [] : []) : undefined));
}

/** The season rail, started from whichever half of the pair painted the page — which is what takes the
 *  seasons query out of the item query's critical path (measured: +350ms waiting for nothing). */
async function loadChildren(it: LibraryItem): Promise<void> {
  if (loaded === it.id) return;
  loaded = it.id;
  if (it.type === 'Series') {
    const s = await embyCached('seasons', it.id, () => window.echoemby.emby.seasons(it.id));
    if (props.id !== it.id) return;
    seasons.value = s.ok ? s.data || [] : [];
    const first = seasons.value.find(x => x.childCount) || seasons.value[0];
    if (first) await loadEpisodes(first.id, it.id);
  } else if (it.type === 'Season') {
    /* A page opened on one season is still a page about a series: its scores, its logo and its season
       tabs all belong one level up, and the switcher cannot be drawn from a list nobody asked for. */
    const series = await loadSeries(it.parentId || '');
    if (props.id !== it.id) return;
    if (series) {
      askWork(series);
      const s = await embyCached('seasons', series.id, () => window.echoemby.emby.seasons(series.id));
      if (props.id === it.id) seasons.value = s.ok ? s.data || [] : [];
    }
    await loadEpisodes(it.id, it.parentId || '');
  }
}

watch(
  () => props.id,
  async id => {
    error.value = '';
    similar.value = [];
    backdrops.value = [];
    viewer.value = null;
    titleUrls.value = [];
    seasonArt.value = '';
    // The series above a Season page belongs to the title being left; keeping it would let the new
    // season borrow the old work's date, art and synopsis.
    if (seriesItem.value && seriesItem.value.id !== id) seriesItem.value = null;
    // Nothing is cleared on a switch: the old title stays on screen, dimmed, until the new one is in
    // hand, so the page never collapses to a skeleton and rebuilds its height under the reader.
    swap.value = item.value !== null;
    if (!swap.value) {
      item.value = null;
      heroPoster.value = '';
      heroBackdrop.value = '';
      seasons.value = [];
      episodes.value = [];
      loaded = '';
      // The row the card was drawn from is already this title, so the hero paints from it instead of
      // waiting out a round trip measured at 493ms — and 2.0s when the gateway is having a slow minute.
      const row = seedItemFor(id);
      item.value = row;
      if (row) {
        paint(row);
        void loadChildren(row);
      }
    }
    const r = await embyCached('item', id, () => window.echoemby.emby.item(id));
    if (!r.ok || !r.data) {
      // A page the row already painted is not a failed page: the title is on screen, only the
      // detail-only blocks stay away. The error line is for when nothing could be shown at all.
      if (!item.value) error.value = r.error || '打不开这一项';
      swap.value = false;
      return;
    }
    paint(r.data);
    void loadChildren(r.data);
    swap.value = false;
  },
  { immediate: true },
);

async function play(id = playableId.value) {
  if (!id) {
    playErr.value = '这一项还不能直接播放';
    return;
  }
  playErr.value = '';
  const ok = await player.play(id);
  if (!ok) playErr.value = player.error;
}

async function toggleFav() {
  // The server files the heart on the series, so a page opened on one season reads and writes that,
  // rather than starring a season and leaving the show it belongs to unmarked.
  const it = work.value;
  if (!it || favBusy.value) return;
  favBusy.value = true;
  await app.setFavorite(it.id, !fav.value);
  favBusy.value = false;
}

const LEVEL_WORD = ['无', '极少', '轻微', '中等', '较多', '严重'];
const fmtMbps = (n?: number): string => (n ? `${(n / 1e6).toFixed(1)} Mbps` : '');
const fmtGB = (n?: number): string => (n ? `${(n / 1e9).toFixed(2)} GB` : '');
const fmtRes = (v?: MediaStreamInfo): string => (v?.width && v?.height ? `${v.width}×${v.height}` : '');
const fmtCh = (n?: number): string => (n === 6 ? '5.1' : n === 8 ? '7.1' : n ? String(n) : '');
</script>

<template>
  <div ref="scroller" class="page" @scroll.passive="onScroll">
    <button class="back" @click="router.back()">←</button>
    <p v-if="playErr" class="err banner">{{ playErr }}</p>
    <Transition name="hero-swap">
      <HeroSkeleton v-if="!item && !error" :poster="plateSrc" />
      <section v-else-if="item" class="hero">
        <div class="stage" :style="{ transform: `translate3d(0, ${Math.round(scroll * 0.28)}px, 0)` }">
          <Transition name="heroart">
            <img v-reveal v-if="heroBackdrop" :key="heroBackdrop" :src="heroBackdrop" alt="" decoding="async" />
          </Transition>
        </div>
        <div class="wash"></div>
        <!-- The season the copy below describes. It answers for the hero, so it hangs on the hero's own
             top band rather than sitting in the copy column: in flow the row landed at y=47, and the back
             disc owns 21..57 at this corner, so the first chip's left edge went under it (measured at both
             the default and the minimum window). Out of flow, the copy keeps exactly the geometry it had
             before any switcher existed. It rides the same fade as the copy because it is read with it. -->
        <div v-if="seasons.length > 1" class="seasons" :style="{ opacity: Math.max(0, 1 - scroll / 260) }">
          <button
            v-for="s in seasons"
            :key="s.id"
            type="button"
            class="sbtn"
            :class="{ on: s.id === seasonId }"
            @click="loadEpisodes(s.id, work?.id)"
          >
            {{ chipLabel(s) }}
          </button>
          <span v-if="seriesTotal" class="stotal">{{ seriesTotal }}</span>
        </div>
        <div
          class="hero-in"
          :style="{ opacity: Math.max(0, 1 - scroll / 260), transform: `translate3d(0, ${Math.round(scroll * 0.4)}px, 0)` }"
        >
          <div class="copy sw" :class="{ on: swap }">
            <div v-if="plateSrc" class="art">
              <img v-if="plateSrc" :src="plateSrc" alt="" decoding="async" />
            </div>
            <div class="text">
              <TitleArt :urls="titleUrls" :name="item.name" />
              <p v-if="work?.tagline" class="tagline">{{ work?.tagline }}</p>
              <div class="line">{{ metaLine }}</div>
              <ScoreStrip v-if="work" :item="work" :season-vote="pack?.vote || 0" :season-label="pack?.tag" class="badges" />
              <p class="overview">{{ overviewText || '暂无简介。' }}</p>
            </div>
            <div class="actions">
              <HeroPlay :target="resume" :busy="player.busy" @play="play()" />
              <button class="iconb" :class="{ on: fav }" :disabled="favBusy" :title="fav ? '已收藏' : '收藏'" @click="toggleFav">
                <svg viewBox="0 0 24 24" width="20" height="20"><path :d="fav ? 'M12 21l-1.5-1.3C5.4 15 2 11.9 2 8.2 2 5.4 4.2 3.2 7 3.2c1.6 0 3.1.7 4 1.9.9-1.2 2.4-1.9 4-1.9 2.8 0 5 2.2 5 5 0 3.7-3.4 6.8-8.5 11.5L12 21z' : 'M12 21l-1.5-1.3C5.4 15 2 11.9 2 8.2 2 5.4 4.2 3.2 7 3.2c1.6 0 3.1.7 4 1.9.9-1.2 2.4-1.9 4-1.9 2.8 0 5 2.2 5 5 0 3.7-3.4 6.8-8.5 11.5L12 21zM7 5.2c-1.7 0-3 1.3-3 3 0 3 3 5.9 8 10.2 5-4.3 8-7.2 8-10.2 0-1.7-1.3-3-3-3-1.3 0-2.5.8-3 2h-4c-.5-1.2-1.7-2-3-2z'" fill="currentColor" /></svg>
              </button>
            </div>
          </div>
        </div>
      </section>
    </Transition>

    <template v-if="!item && !error">
      <div class="flow">
        <BlockPh v-if="wantRail" kind="rail" />
        <div v-for="n in 2" :key="n" class="block skb">
          <div class="skhd"></div>
          <div class="skrow"><div v-for="m in 5" :key="m" class="skcd"></div></div>
        </div>
      </div>
    </template>
    <p v-else-if="error" class="err pad">{{ error }}</p>

    <template v-else-if="item">
      <div class="flow sw" :class="{ on: swap }">
        <HScroller v-if="episodes.length" class="block epi-row">
          <template #header>
            <div class="ep-head">
              <h2>{{ pack?.label || item.name }}</h2>
              <span class="count">{{ episodes.length }} 集</span>
            </div>
          </template>
          <button v-for="e in episodes" :key="e.id" class="epi" @click="play(e.id)">
            <div class="ethumb">
              <img v-reveal v-if="epArt[e.id] || stillUrl(e.indexNumber)" :src="epArt[e.id] || stillUrl(e.indexNumber)" alt="" loading="lazy" decoding="async" />
              <span v-else class="ph">{{ (e.name || '?').slice(0, 1) }}</span>
              <span class="disc" role="presentation"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 5l12 7-12 7z" fill="currentColor" /></svg></span>
              <span v-if="epSeen(e)" class="echip">{{ epSeen(e) }}</span>
              <div v-if="epPlayed(e) > 0" class="eprog"><i :style="{ width: epPlayed(e) + '%' }"></i></div>
            </div>
            <div class="einfo">
              <p class="etitle">{{ epTitle(e) }}</p>
              <p class="emeta">
                <span v-if="e.premiereDate">{{ fmtDate(e.premiereDate) }}</span>
                <span>{{ fmtRuntime(e.runTimeTicks) }}</span>
              </p>
              <p v-if="epOverview(e)" class="eov">{{ epOverview(e) }}</p>
            </div>
          </button>
        </HScroller>
        <BlockPh v-else-if="wantRail" kind="rail" />

        <section v-if="source" class="block">
          <h2>播放资源</h2>
          <div class="src">
            <div class="srccard">
              <p class="sc-top">{{ vstream?.range || 'SDR' }}</p>
              <p class="sc-meta"><span>{{ fmtGB(source.sizeBytes) }}</span><span>{{ fmtMbps(source.bitRate) }}</span></p>
              <p class="sc-foot"><span class="dot"></span>{{ source.container }}<span class="ok">✓</span></p>
            </div>
          </div>

          <div class="tech">
            <div v-if="vstream" class="tcard">
              <h3>视频</h3>
              <dl>
                <template v-for="row in [
                  ['标题', vstream.displayTitle || vstream.title],
                  ['分辨率', fmtRes(vstream)],
                  ['色彩范围', vstream.range],
                  ['文件大小', fmtGB(source.sizeBytes)],
                  ['码率', fmtMbps(source.bitRate)],
                  ['帧率', vstream.fps ? vstream.fps.toFixed(1) : ''],
                  ['编码', vstream.codec?.toUpperCase()],
                  ['位深', vstream.bitDepth ? vstream.bitDepth + ' 位' : ''],
                  ['色度', vstream.chroma],
                ] as Array<[string, string]>" :key="row[0]">
                  <template v-if="row[1]"><dt>{{ row[0] }}</dt><dd>{{ row[1] }}</dd></template>
                </template>
              </dl>
            </div>
            <div v-if="astream" class="tcard">
              <h3>音频</h3>
              <dl>
                <template v-for="row in [
                  ['标题', astream.title || astream.displayTitle],
                  ['语言', astream.lang],
                  ['编码', astream.codec?.toUpperCase()],
                  ['声道数', fmtCh(astream.channels)],
                  ['码率', fmtMbps(astream.bitRate)],
                  ['采样率', astream.sampleRate ? String(astream.sampleRate) : ''],
                ] as Array<[string, string]>" :key="row[0]">
                  <template v-if="row[1]"><dt>{{ row[0] }}</dt><dd>{{ row[1] }}</dd></template>
                </template>
                <template v-if="(source.audio.length > 1)">
                  <dt>音轨</dt><dd>共 {{ source.audio.length }} 条</dd>
                </template>
                <template v-if="source.subtitle.length">
                  <dt>字幕</dt><dd>{{ source.subtitle.map(s => s.lang || '?').join(' / ') }}</dd>
                </template>
              </dl>
            </div>
          </div>
          <p v-if="item.dateCreated" class="added">入库时间　{{ fmtDateTime(item.dateCreated) }}</p>
        </section>
        <BlockPh v-else-if="wantTech" kind="tech" />

        <HScroller v-if="crew.length" title="演职员" :count="crew.length" class="block">
          <div v-for="p in crew" :key="p.id" class="person">
            <div class="face">
              <img v-reveal v-if="p.face || faces[p.id]" :src="p.face || faces[p.id]" alt="" loading="lazy" />
              <span v-else class="ini">{{ p.name.slice(0, 1) }}</span>
            </div>
            <p class="pn">{{ p.name }}</p>
            <p v-if="p.sub" class="pr">{{ p.sub }}</p>
          </div>
        </HScroller>

        <section v-if="scores.csm?.categories.length" class="block">
          <h2>家长指南</h2>
          <div class="pg">
            <div v-for="c in scores.csm.categories" :key="c.key" class="pgi">
              <p class="pgt">{{ c.label }}</p>
              <div class="pgdots"><i v-for="n in 5" :key="n" :class="{ on: n <= c.level }"></i></div>
              <p class="pgw">{{ LEVEL_WORD[c.level] || '' }}</p>
            </div>
          </div>
        </section>

        <section v-if="genres.length" class="block">
          <h2>分类</h2>
          <div class="chips"><span v-for="g in genres" :key="g" class="chip">{{ g }}</span></div>
        </section>

        <HScroller v-if="backdrops.length" class="block" title="剧照" :count="backdrops.length">
          <button v-for="(b, i) in backdrops" :key="i" type="button" class="still" @click="openViewer(i)">
            <img v-reveal class="stillimg" :src="backdropUrl(b)" alt="" loading="lazy" decoding="async" />
          </button>
        </HScroller>

        <HScroller v-if="similar.length" class="block" title="相似作品" :count="similar.length">
          <div v-for="s in similar" :key="s.tmdbId" class="sim">
            <div class="sposter">
              <img v-reveal v-if="s.posterPath" :src="posterUrl(s.posterPath)" alt="" loading="lazy" decoding="async" />
              <span v-else class="ph">{{ s.title.slice(0, 1) }}</span>
            </div>
            <p class="stitle">{{ s.title }}</p>
            <p class="smeta"><span v-if="s.voteAverage" class="srate">★ {{ s.voteAverage.toFixed(1) }}</span><span v-if="s.year">{{ s.year }}</span></p>
          </div>
        </HScroller>
      </div>
    </template>

    <Teleport to="body">
      <Transition name="lightbox">
        <div v-if="viewer !== null" class="lightbox" role="dialog" aria-modal="true" aria-label="剧照大图" @click.self="viewer = null" @wheel.prevent>
          <button type="button" class="lb-x" aria-label="关闭" @click="viewer = null">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" /></svg>
          </button>

          <div class="lb-stage" @click.self="viewer = null">
            <img class="lb-lores" :src="current ? backdropUrl(current) : ''" alt="" decoding="async" />
            <!-- The `key` is what makes a step animate at all. Without it Vue patches `src` on the same
                element, a Transition only fires on insert and remove, and the four `.lb-nx`/`.lb-pv` class
                sets — which carry a leave half that can never apply to an element that is never removed — sat
                unused. Measured on the old build: same node across a step, opacity 1 and transform `none`
                throughout, getAnimations() empty. Both frames are `position: absolute; inset: 0`, so they
                overlap by construction and the row keeps its size while the art slides past itself. -->
            <Transition :name="vdir > 0 ? 'lb-nx' : vdir < 0 ? 'lb-pv' : 'lb-fade'">
              <img v-if="current" :key="current" class="lb-img" :src="bigUrl(current)" alt="" decoding="async" />
            </Transition>
            <button v-if="backdrops.length > 1" type="button" class="lb-edge left" aria-label="上一张" @click.stop="stepViewer(-1)">
              <svg viewBox="0 0 24 24" width="19" height="19"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
            <button v-if="backdrops.length > 1" type="button" class="lb-edge right" aria-label="下一张" @click.stop="stepViewer(1)">
              <svg viewBox="0 0 24 24" width="19" height="19"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
          </div>

          <footer class="lb-foot">
            <div ref="strip" class="lb-strip" @wheel.prevent.stop="onStripWheel">
              <button v-for="(b, i) in backdrops" :key="i" type="button" class="lb-th" :class="{ on: i === viewer }" @click="jumpViewer(i)">
                <img v-reveal :src="backdropUrl(b)" alt="" draggable="false" loading="lazy" decoding="async" />
              </button>
            </div>
            <p class="lb-count">{{ (viewer ?? 0) + 1 }} / {{ backdrops.length }}</p>
          </footer>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.page {
  /* Same inset ladder as the lobby: the rail floats, so the content line is its right edge, and the
     bands tuck their art under it. Defining them here lets the HScroller children inherit the math. */
  --side: clamp(10px, 1.8vw, 26px);
  --gutter: var(--nav-w);
  --rail-x: 12px;
  --tuck: 214px;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  position: relative;
  padding-bottom: 56px;
}
.back {
  position: absolute;
  /* Centred on the rail's search button: rail top 16 + its 8 padding + half the 30px button = 39px,
     so a 36px disc sits at 21px. It used to hang off --titlebar-h, one row below that button. */
  top: 21px;
  left: calc(var(--nav-w) + 18px);
  /* Over the hero band, which is a later sibling and would otherwise paint its art across the disc.
     It used to be lifted over the title bar instead: the drag band sat on the top 23px of this 36px
     button and answered the mouse (real click: centre did nothing, lower edge went back). The band is
     now under the page and every control subtracts itself from it — see AppTitleBar and base.css. */
  z-index: 1;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(16, 16, 22, 0.42);
  border: 1px solid rgba(255, 255, 255, 0.24);
  backdrop-filter: blur(10px);
  color: #fff;
  transition: background var(--hov) var(--ease), transform var(--hov) var(--ease-out), left var(--rail-dur) var(--rail-ease);
}
.back:hover {
  background: rgba(16, 16, 22, 0.66);
  transform: translateX(-2px);
}
.pad { padding: calc(var(--titlebar-h) + 40px) 44px 0 calc(var(--nav-w) + 44px); }

.hero {
  position: relative;
  /* Same clamp and the same gutter offset as the lobby hero: the backdrop starts on the content line
     and never runs under the floating rail, which is the whole left-bleed complaint. */
  height: clamp(460px, 61vh, 620px);
  margin-left: var(--gutter);
  margin-bottom: 4px;
  display: flex;
  align-items: flex-end;
  overflow: hidden;
  /* Where the wide backdrop sits when it is taller than the band. */
  --hero-pos: center 22%;
  /* The hero's own dim, in one place: the real band paints it over its photo, and the first-arrival
     skeleton paints it over nothing, so the shape the page arrives with is the shape that stays. */
  --hero-ramp:
    linear-gradient(to top, rgba(6, 8, 14, 0.86) 0, rgba(6, 8, 14, 0.82) 120px, rgba(6, 8, 14, 0.5) max(240px, 42%), rgba(6, 8, 14, 0.12) max(400px, 72%), transparent 100%),
    linear-gradient(90deg, rgba(6, 8, 14, 0.5) 0%, rgba(6, 8, 14, 0.12) 46%, transparent 72%);
  transition: margin-left var(--rail-dur) var(--rail-ease);
}
/* Only the art layer parallaxes; a transform on the clipped .hero box emits a 1px seam at its edge. */
.stage {
  position: absolute;
  inset: -3px 0;
  will-change: transform;
}
.stage img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: var(--hero-pos);
  animation: kb 18s ease-in-out infinite alternate;
}
@keyframes kb {
  from { transform: scale(1.02); }
  to { transform: scale(1.12) translate3d(0, -1.4%, 0); }
}
/* Press the art down and put white type on it, the way the lobby hero does: a bottom ramp plus a soft
   left gradient, so the copy reads over any backdrop without ever laying a white plate on the poster. */
.wash {
  position: absolute;
  inset: 0;
  background: var(--hero-ramp);
}
.hero-in {
  position: relative;
  z-index: 2;
  width: 100%;
  padding: 0 var(--side) 28px 32px;
  will-change: transform, opacity;
}
.copy {
  color: #fff;
  display: flex;
  align-items: flex-end;
  gap: 20px;
}
/* The season tabs, over the hero's own content. Same flat glass as the hero's round controls, and one row
   that never wraps: past what fits it scrolls sideways rather than growing a second line. Hung from the
   hero's right so the back disc keeps its corner, shrink-to-fit so a two-season show's tabs sit next to
   the 全 N 季 counter rather than floating away from it. Picking one changes only what the tabs say, never
   where anything sits. */
.seasons {
  position: absolute;
  z-index: 2;
  top: 23px;
  right: var(--side);
  max-width: calc(100% - 62px - var(--side));
  display: flex;
  align-items: center;
  gap: 8px;
  overflow-x: auto;
  scrollbar-width: none;
}
.seasons::-webkit-scrollbar {
  display: none;
}
.sbtn {
  flex: none;
  padding: 6px 14px;
  border-radius: 999px;
  color: rgba(255, 255, 255, 0.82);
  background: rgba(255, 255, 255, 0.14);
  border: 1px solid rgba(255, 255, 255, 0.28);
  backdrop-filter: blur(10px);
  font-size: 13px;
  font-weight: 550;
  line-height: 1.35;
  white-space: nowrap;
  transition: color var(--hov) var(--ease), background var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.sbtn:hover {
  background: rgba(255, 255, 255, 0.24);
  color: #fff;
  transform: translateY(-1px);
}
/* Selected is a fill swap only: a bolder or roomier active chip would reflow every tab beside it. */
.sbtn.on {
  background: #fff;
  color: var(--ink);
  border-color: #fff;
}
.stotal {
  flex: none;
  padding-left: 14px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.35;
  color: rgba(255, 255, 255, 0.8);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* The plate is sized by height rather than width, so it keeps the same box whatever the art is and does not
   move when the text beside it changes height — the property that used to have to hold still while a clone
   was aimed at it. */
.art {
  height: clamp(348px, 46vh, 430px);
  flex: none;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: var(--shadow);
}
.art img { display: block; width: 100%; height: 100%; object-fit: cover; }

.text {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 640px;
}
.tagline { margin: 0 0 8px; font-size: 14px; font-style: italic; color: rgba(255, 255, 255, 0.82); }
/* Two lines claimed before the season's facts land. Switching 第一季 for 第二季 turns a short
   「2021」 into 「2021-04-09 · 16 集 · 17小时18分」, and a row that grows mid-swap reflows the whole
   bottom-pinned copy column underneath it. */
.line {
  font-size: 13.5px;
  line-height: 1.35;
  min-height: calc(13.5px * 1.35 * 2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.86);
  margin-bottom: 12px;
  font-variant-numeric: tabular-nums;
}
/* Only the gap around the strip is this page's business; the marks themselves are ScoreStrip's. */
.badges { margin-bottom: 14px; }
.overview {
  font-size: 14px;
  line-height: 1.65;
  color: rgba(255, 255, 255, 0.9);
  max-width: 660px;
  margin: 0 0 18px;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
  /* The four lines this paragraph is allowed to reach, claimed before the text arrives. The copy column is
     pinned at its bottom and this is its last row, so a one-line synopsis pulled the meta line and the score
     row up by 69px and left the placeholder's bars floating where a full paragraph lands. Reserving the
     clamp fixes the hero's shape, and the swap becomes a dissolve instead of a slide. */
  min-height: 92.4px;
}
/* Same split as the lobby hero: the actions answer for the right edge, flush against it even when
   the copy column shrinks at the minimum window. */
.actions { flex: none; margin-left: auto; display: flex; align-items: center; gap: 12px; }
.iconb {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: #fff;
  background: rgba(255, 255, 255, 0.16);
  border: 1px solid rgba(255, 255, 255, 0.36);
  backdrop-filter: blur(10px);
  transition: color var(--hov) var(--ease), background var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.iconb:hover { transform: translateY(-1px); background: rgba(255, 255, 255, 0.26); }
.iconb.on { color: #ff5a6a; }

/* Mirrors the lobby's .flow: the bands clip their art here (under the rail) while the plain blocks
   inset to the content line. Children that need the line add their own --gutter padding. */
.flow {
  position: relative;
  z-index: 1;
  margin-left: var(--rail-x);
  overflow-x: clip;
  max-width: 1320px;
}
.flow > .block { margin-top: 26px; }
.block:not(.hrow) {
  padding-left: calc(var(--gutter) - var(--rail-x));
  padding-right: var(--side);
  transition: padding-left var(--rail-dur) var(--rail-ease);
}
/* The room BlockPh's `.ph-rail` claims (16 + 34 + 11 + 6 + the 279 card + 20 + 4 = 370) is also the floor
   of the band it stands in for. A rail of one-line titles measured 358.3, so every block under it slid up
   11.8px the moment the episodes landed - the census's `0,-12` on about 199 boxes. Floor the real band at
   the same number and the swap is exact; two-line titles still stand above it, which no floor can predict. */
.epi-row { min-height: 370px; }
h2 { font-size: 18px; font-weight: 700; letter-spacing: -0.2px; margin: 0 0 14px; color: var(--text); }

.ep-head { display: flex; align-items: baseline; gap: 12px; flex: 1; min-width: 0; }

.epi {
  flex: none;
  width: 280px;
  display: flex;
  flex-direction: column;
  text-align: left;
  padding: 0;
  background: none;
  cursor: pointer;
}
.ethumb {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg-elev-2);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
}
.ethumb img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.ethumb .ph { position: absolute; inset: 0; display: grid; place-items: center; font-size: 30px; font-weight: 700; color: var(--text-faint); background: linear-gradient(150deg, var(--bg), var(--bg-elev-2)); }
.ethumb .disc {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 38px;
  height: 38px;
  margin: -19px 0 0 -19px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: #fff;
  background: rgba(16, 16, 22, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.3);
  backdrop-filter: blur(8px);
  opacity: 0;
  transform: scale(0.72);
  transition: opacity var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.epi:hover .disc { opacity: 1; transform: none; }
/* Same plate as the 在看 cards: the progress read-out lives on the frame it belongs to, not in the text
   under it - the two used to sit so far apart they read as two different episodes. */
.ethumb .echip {
  position: absolute;
  left: 9px;
  bottom: 10px;
  padding: 2px 7px;
  border-radius: var(--r-badge);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.2px;
  font-variant-numeric: tabular-nums;
  color: #fff;
  background: rgba(16, 16, 22, 0.74);
  backdrop-filter: blur(8px);
}
.ethumb .eprog { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255, 255, 255, 0.32); overflow: hidden; }
.ethumb .eprog i { display: block; height: 100%; background: #fff; box-shadow: 0 0 0 1px rgba(18, 18, 26, 0.08); }
.einfo { min-width: 0; margin-top: 11px; }
.emeta { margin: 6px 0 0; display: flex; gap: 8px; flex-wrap: wrap; font-size: 13px; font-weight: 500; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.etitle { margin: 0; font-size: 14px; font-weight: 650; color: var(--text); }
.eov {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-dim);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.src { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 18px; }
.srccard {
  width: 210px;
  padding: 14px 16px;
  border-radius: var(--radius);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
}
.sc-top { margin: 0 0 8px; font-size: 15px; font-weight: 700; color: var(--text); }
.sc-meta { margin: 0 0 10px; display: flex; gap: 14px; font-size: 13px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.sc-foot { margin: 0; display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; color: var(--text); }
.sc-foot .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fbf7f; }
.sc-foot .ok { margin-left: auto; color: #3fbf7f; }

.tech { display: flex; gap: 16px; flex-wrap: wrap; }
.tcard {
  flex: 1 1 260px;
  max-width: 380px;
  padding: 16px 18px;
  border-radius: var(--radius);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
}
.tcard h3 { margin: 0 0 12px; font-size: 14px; font-weight: 650; color: var(--text); }
.tcard dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 7px 16px; }
.tcard dt { font-size: 13px; color: var(--text-dim); }
.tcard dd { margin: 0; font-size: 13px; font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
.added { margin: 18px 0 0; font-size: 13px; color: var(--text-dim); }

.person { width: 84px; flex: none; }
.face {
  width: 84px;
  aspect-ratio: 1;
  border-radius: 50%;
  overflow: hidden;
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
}
.face img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ini { display: grid; place-items: center; width: 100%; height: 100%; font-size: 28px; font-weight: 700; color: var(--text-faint); background: linear-gradient(150deg, var(--bg), var(--bg-elev-2)); }
.pn, .pr { margin: 8px 0 0; font-size: 13px; line-height: 1.3; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pr { margin: 2px 0 0; font-weight: 500; color: var(--text-dim); }
.pn { font-weight: 600; color: var(--text); }

.pg { display: flex; gap: 14px; flex-wrap: wrap; }
.pgi {
  flex: 1 1 150px;
  max-width: 210px;
  padding: 14px 16px;
  border-radius: var(--radius);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
}
.pgt { margin: 0 0 10px; font-size: 14px; font-weight: 650; color: var(--text); }
.pgdots { display: flex; gap: 5px; margin-bottom: 8px; }
.pgdots i { width: 22px; height: 5px; border-radius: 3px; background: var(--line-strong); }
.pgdots i.on { background: #f0913a; }
.pgw { margin: 0; font-size: 13px; color: var(--text-dim); }

.chips { display: flex; gap: 7px; flex-wrap: wrap; }
/* Same recipe as the picker chips, so a genre tag and a filter option read as one vocabulary. */
.chip { display: inline-flex; align-items: center; height: 30px; padding: 0 12px; border-radius: 999px; background: var(--chip); font-size: 13px; font-weight: 600; color: var(--text-dim); }

.still { flex: none; padding: 0; border: 0; background: none; cursor: zoom-in; transition: transform var(--hov) var(--ease-out); }
.still:hover { transform: translateY(-3px); }
.still:active { transform: scale(0.982); }
.stillimg { display: block; width: 320px; aspect-ratio: 16 / 9; object-fit: cover; border-radius: var(--radius); border: 1px solid var(--line); box-shadow: var(--shadow-sm); }

.sim { flex: none; width: 150px; }
.sposter { position: relative; aspect-ratio: 2 / 3; border-radius: var(--radius); overflow: hidden; background: var(--bg-elev-2); border: 1px solid var(--line); box-shadow: var(--shadow-sm); }
.sposter img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.sposter .ph { position: absolute; inset: 0; display: grid; place-items: center; font-size: 34px; font-weight: 700; color: var(--text-faint); background: linear-gradient(150deg, var(--bg), var(--bg-elev-2)); }
.stitle { margin: 8px 0 0; font-size: 13px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.smeta { margin: 2px 0 0; display: flex; gap: 8px; font-size: 12.5px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.smeta .srate { color: #b8860b; font-weight: 650; }

.err { color: var(--danger); }
.banner { margin: 0 0 12px; padding: 0 44px; }

/* 剧照大图: a photo manager rather than a dialog — the art is the whole surface, so the backdrop goes
   dark enough to letterbox it and every control is a quiet light-on-dark affordance laid over it. */
.lightbox {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: grid;
  /* Without a min-0 column the filmstrip's max-content width (145 thumbs here) becomes the page width. */
  grid-template: minmax(0, 1fr) auto / minmax(0, 1fr);
  padding: 20px 22px 16px;
  background: rgba(8, 8, 12, 0.965);
  backdrop-filter: blur(26px) saturate(150%);
  cursor: zoom-out;
}
.lb-x {
  position: absolute;
  top: 18px;
  right: 20px;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  cursor: pointer;
  transition: background var(--hov) var(--ease);
}
.lb-x:hover { background: rgba(255, 255, 255, 0.24); }
.lb-stage { position: relative; overflow: hidden; }
.lb-lores,
.lb-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
}
.lb-edge {
  position: absolute;
  top: 50%;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  cursor: pointer;
  opacity: 0.55;
  transform: translate3d(0, -50%, 0);
  transition: opacity var(--hov) var(--ease), background var(--hov) var(--ease);
}
.lb-edge.left { left: 14px; }
.lb-edge.right { right: 14px; }
.lb-edge:hover { opacity: 1; background: rgba(255, 255, 255, 0.22); }
.lb-edge:active { opacity: 1; background: rgba(255, 255, 255, 0.3); }
.lb-foot { display: flex; flex-direction: column; align-items: center; gap: 10px; cursor: default; }
.lb-strip {
  display: flex;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  padding: 4px 2px;
  scrollbar-width: none;
  /* Same edge fade as the rail's list: a thumb clipped straight in half reads as broken, not as scrollable. */
  mask-image: linear-gradient(90deg, transparent, #000 22px, #000 calc(100% - 22px), transparent);
}
.lb-strip::-webkit-scrollbar { height: 0; }
.lb-th {
  flex: none;
  width: 92px;
  aspect-ratio: 16 / 9;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 8px;
  overflow: hidden;
  background: none;
  cursor: pointer;
  opacity: 0.45;
  transition: opacity var(--hov) var(--ease), transform var(--hov) var(--ease-out), border-color var(--hov) var(--ease);
}
.lb-th:hover { opacity: 0.8; transform: translateY(-2px); }
.lb-th.on { opacity: 1; border-color: rgba(255, 255, 255, 0.9); transform: none; }
.lb-th img { display: block; width: 100%; height: 100%; object-fit: cover; }
.lb-count { margin: 0; font-size: 13px; font-weight: 600; color: rgba(255, 255, 255, 0.72); font-variant-numeric: tabular-nums; letter-spacing: 0.03em; }

.lightbox-enter-active,
.lightbox-leave-active { transition: opacity 0.22s var(--ease); }
.lightbox-enter-from,
.lightbox-leave-to { opacity: 0; }
/* Both frames of a step are on screen at once, so the row keeps its size and the art slides past itself. */
.lb-fade-enter-active,
.lb-nx-enter-active,
.lb-pv-enter-active,
.lb-fade-leave-active,
.lb-nx-leave-active,
.lb-pv-leave-active { transition: opacity var(--hov) var(--ease), transform 0.36s var(--ease-out); }
.lb-fade-enter-from,
.lb-fade-leave-to { opacity: 0; transform: scale(0.985); }
.lb-nx-enter-from { opacity: 0; transform: translate3d(52px, 0, 0); }
.lb-nx-leave-to { opacity: 0; transform: translate3d(-52px, 0, 0); }
.lb-pv-enter-from { opacity: 0; transform: translate3d(-52px, 0, 0); }
.lb-pv-leave-to { opacity: 0; transform: translate3d(52px, 0, 0); }
/* The dim a sibling switch puts on the text while the new title loads. The hero art is not part of
   it: the art cross-fades old frame to new frame instead, which is the continuity the switch needs. */
.sw {
  transition: opacity 0.18s var(--ease), transform 0.18s var(--ease);
}
.sw.on {
  opacity: 0;
  transform: translate3d(0, 6px, 0);
}
/* Two frames of one band, crossing: the old photo lifts past the lens and fades while the new one comes up
   to meet it. Both are `position: absolute; inset: 0` in `.stage`, so they overlap by construction — and
   this is the one place a crossfade is the right answer rather than doubled text, because the two frames
   are the same shape in the same place. It is what a sibling switch shows you: the page stays, only the
   title changes. */
.heroart-enter-active,
.heroart-leave-active {
  transition: opacity var(--arrive-dur) var(--ease), transform var(--arrive-dur) var(--ease);
}
.heroart-enter-from {
  opacity: 0;
  transform: scale(0.97);
}
.heroart-leave-to {
  opacity: 0;
  transform: scale(1.03);
}
/* Blocks are placed as the page settles, one after another. They mount once per title, so a sibling
   switch that only swaps their data replays nothing. */
.flow > .block {
  animation: block-in var(--arrive-dur) var(--ease-out) backwards;
}
.flow > .block:nth-child(2) {
  animation-delay: 0.06s;
}
.flow > .block:nth-child(3) {
  animation-delay: 0.12s;
}
.flow > .block:nth-child(4) {
  animation-delay: 0.18s;
}
/* The two rows that follow the first one are generic — a cast band, a stills rail, a poster rail, in no
   order the placeholder can know about — so they take the shape all three share: the HScroller's own
   chrome (16 above the header, its 28px line box, 11 to the track, 6 above the cards, 20 and 4 below)
   around a 150px poster with the 49.5px its two label lines will need. That adds up to 359.5px, which is
   what the real 相似作品 row measures, so the row below this one does not move when it lands. */
.skb {
  padding-top: 16px;
  padding-bottom: 4px;
}
.skb .skhd {
  width: 190px;
  height: 28px;
  margin-bottom: 11px;
  border-radius: 6px;
  background: var(--shimmer);
  background-size: var(--sk-tile) 100%;
  animation: sh 1.3s linear infinite;
}
.skb .skrow {
  display: flex;
  gap: 14px;
  padding: 6px var(--side) 20px 0;
  overflow: hidden;
}
.skb .skcd {
  width: 150px;
  aspect-ratio: 2 / 3;
  margin-bottom: 49.5px;
  border-radius: var(--radius);
  background: var(--shimmer);
  background-size: var(--sk-tile) 100%;
  animation: sh 1.3s linear infinite;
}
</style>
