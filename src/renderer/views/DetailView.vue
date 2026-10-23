<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { LibraryItem, TmdbCreditRow, TmdbCredits, TmdbEpisodeRow, TmdbSeasonRow, TmdbStills } from '../../shared/types';
import HScroller from '../components/detail/HScroller.vue';
import FilterSelect from '../components/browse/FilterSelect.vue';
import BlockPh from '../components/detail/BlockPh.vue';
import TechCard from '../components/detail/TechCard.vue';
import RelatedStrip from '../components/detail/RelatedStrip.vue';
import ScoreStrip from '../components/ScoreStrip.vue';
import HeroPlay from '../components/HeroPlay.vue';
import LoopTitle from '../components/LoopTitle.vue';
import TitleArt from '../components/TitleArt.vue';
import HeroSkeleton from '../components/HeroSkeleton.vue';
import { tmdbKind as kindOf, trustSeason, useScores } from '../lib/scores';
import { usePlayerStore } from '../stores/player';
import { useAppStore } from '../stores/app';
import { accountName, episodeHead, fmtDate, fmtMinutes, fmtRuntime, seenLabel, seasonTitle } from '../lib/format';
import { PLAYABLE, PLAYABLE_PAGE, resumeTarget, seasonTarget } from '../lib/resume';
import { mergeGenres } from '../lib/genres';
import { resetPageScroll } from '../lib/scroll';
import { createLoopRail, type LoopRail } from '../lib/looprail';
import { embyCached } from '../lib/embycache';
import { libraryWorks, useRelated, type WorkSeed } from '../lib/related';
import { seedFor, seedItemFor, seedTypeFor, takeAutoplay } from '../lib/handoff';
import { vReveal } from '../lib/reveal';

const props = defineProps<{ id: string }>();
const router = useRouter();
const player = usePlayerStore();
const app = useAppStore();
/** Whose file the play button opens. The lobby only offers titles; this page is about to open one. */
const serverName = computed(() => (app.account ? accountName(app.account) : ''));

const item = ref<LibraryItem | null>(null);
/** What the server's own rows answer as this work's seasons, each tagged with the Series row that holds
 *  it. A work this account files as several rows (measured: 12 of this library's 386) has its seasons
 *  spread over them, and a list built from the row being looked at alone would answer 「当前服务器无资源」
 *  two rows down from where its files really sit (measured: 6 of the 72 shortfall rows). */
const serverSeasons = ref<{ seriesId: string; season: LibraryItem }[]>([]);
/** Whether every row this account holds for the work has answered about its seasons. Until then a season
 *  TMDB lists and this page cannot find is unasked-for rather than absent, and only one of those two is a
 *  sentence worth printing. */
const seasonsAsked = ref(false);
const episodes = ref<LibraryItem[]>([]);
/** The season this page is answering for, held as its number. Keyed by number rather than by the server's
 *  row id because the list now offers seasons this server has no row for: a show filed as 第 1 季 and
 *  第 3 季 has a 第 2 季 the reader can open, and nothing on this machine names it. -1 until it lands —
 *  0 is a real answer here, since 第 0 季 Specials is a season the server files like any other (measured:
 *  10 of the 196 season rows across 120 sampled shows). */
const seasonN = ref(-1);
/** Which season the rows now in `episodes` were read for. The list keeps its height across a switch, so
 *  without this the hero would print the season being left's length under the new one's date. */
const episodeN = ref(-1);
/** Whether TMDB has answered the episode list for the season on screen. Consulted only for a season this
 *  server holds no row for, where it is the whole difference between 「还没有分集」 and an ask still out. */
const stillsSettled = ref(false);
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

/** The work the 「相似作品」 band belongs to, in the three fields it needs and nothing else: what TMDB
 *  calls it, which of its two shapes it is, and which genres fill the band's last slots when TMDB's list
 *  comes back short. A Season page has none of these on its own row, so it inherits them from the series
 *  above it along with everything else one level up. */
const relatedSeed = computed<WorkSeed | null>(() => {
  const w = work.value;
  const kind = w ? kindOf(w) : undefined;
  const tmdbId = String(w?.providers?.tmdb || '');
  return kind && /^\d{1,8}$/.test(tmdbId) ? { kind, tmdbId, genres: w!.genres } : null;
});
const related = useRelated(() => relatedSeed.value);

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
/** The work's own synopsis, in the one order every text surface here uses: TMDB in Chinese, then TMDB in
 *  whatever language it happens to have, then whatever the server carries. The last step is where a title
 *  TMDB records no synopsis at all still gets a line — measured over the 181 works cached now, every
 *  TMDB synopsis this server gets back is already Chinese, so the middle rung has never had to speak. */
const workOverview = computed(
  () => scores.value.tmdb?.overviewZh || scores.value.tmdb?.overviewOther || item.value?.overview || '',
);

/** What this page will be, from the server's item when there is one and from the clicked card when there
 *  is not yet — an Episode card opens its Season, and that is enough to know a rail is coming. */
const pageType = computed(() => item.value?.type || seedTypeFor(props.id));
/** The arrival tall enough to be felt: the season rail lands at 370px on a page the reader is already
 *  looking at, and everything under it jumped down when it came in. The room is claimed here and filled
 *  in place. The file's technical block used to need the same treatment; it no longer stands in for a
 *  real block at all, so BlockPh knows only the rail (see that component). */
const wantRail = computed(
  () => (pageType.value === 'Series' || pageType.value === 'Season') && !episodes.value.length && !!seasonRow.value,
);

/** image.tmdb.org answers directly on this machine (the API host needs the system proxy). */
/* Whether TMDB's row for episode number N is *this* card's episode. The season-level count pairing answers
   coarse: it refuses a show still airing, whose 3 files against TMDB's 13 is a partial download rather than
   a mispairing (measured on PSYREN 第 1 季 — 3/13 = 0.23 against the 0.67 line, which cost all three cards
   their outside picture even though TMDB bills a still for each of them). So a refusal is not final: two
   sides that agree on when this one episode aired have said something stronger than two counts. */
const countsPaired = computed(() => !!trustRow(seasonNumber.value, seasonRow.value?.childCount));
/** The server's own date is a timestamp with a zone, TMDB's a plain `YYYY-MM-DD`, and this gateway writes
 *  its season dates a day early — so the claim being tested is the calendar day, with one day of slack. */
const DAY_MS = 86400000;
const sameEpisodeDate = (server?: string, tmdb?: string): boolean => {
  if (!server || !tmdb) return false;
  const a = Date.parse(server);
  const b = Date.parse(tmdb);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= DAY_MS;
};
const stillRow = (ep: number | undefined, airDate?: string): TmdbEpisodeRow | undefined => {
  if (ep == null) return undefined;
  const r = stills.value[ep];
  if (!r || countsPaired.value) return r;
  return sameEpisodeDate(airDate, r.air) ? r : undefined;
};
/** A card built from TMDB's own row needs no pairing test — the picture and the card are the same episode
    by construction — so it takes the path straight from the row. */
const tmdbStillUrl = (p?: string): string => (p ? `https://image.tmdb.org/t/p/w500${p}` : '');
const stillUrl = (ep: number | undefined, airDate?: string): string => tmdbStillUrl(stillRow(ep, airDate)?.p);
/** The episode's own paragraph, in the order every text surface here uses: TMDB in Chinese, then TMDB in
 *  whatever else it filed, then the server's line. The server carries no overview for 475 of the
 *  library's 600 sampled episodes, and TMDB's line for each of them arrives inside the season reply the
 *  pictures were already being asked for. */
const epOverview = (e: LibraryItem): string => {
  const r = stillRow(e.indexNumber, e.premiereDate);
  return r?.ovZh || r?.ovOther || e.overview || '';
};
const posterUrl = (p?: string): string => (p ? `https://image.tmdb.org/t/p/w342${p}` : '');
/** The server's own stamp first, then the date TMDB bills this episode for — the field is already in hand,
 *  and a card that said nothing for want of a `PremiereDate` has a real one to say. Only a paired row may
 *  speak, so a season whose numbering the count test refused cannot borrow another season's calendar. */
const epDate = (e: LibraryItem): string => fmtDate(e.premiereDate) || fmtDate(stillRow(e.indexNumber, e.premiereDate)?.air);
/** The same shape for the length: the file's own running time, else what TMDB bills the episode (76% of
 *  rows carry one, measured over 204). */
const epLen = (e: LibraryItem): string => fmtRuntime(e.runTimeTicks) || fmtMinutes(stillRow(e.indexNumber, e.premiereDate)?.rt);
const backdropUrl = (p: string): string => `https://image.tmdb.org/t/p/w780${p}`;
/** The band draws each head at 110px, which is 137.5 device px at this window; w185 is the smallest
 *  tier above that, and the largest one TMDB documents for a profile crop. */
const faceUrl = (p: string): string => `https://image.tmdb.org/t/p/w185${p}`;

/** One index into backdrops drives the whole viewer, and the rail keeps the five frames around it mounted, so
 *  a step moves one custom property: nothing is inserted, no decode starts on the click frame, and the
 *  compositor never has to bring a fresh layer in. That insert stall — plus the instant low-res swap that sat
 *  underneath it, blending the old frame into the new one — was the flicker. */
const viewer = ref<number | null>(null);
const strip = ref<HTMLElement | null>(null);
const stage = ref<HTMLElement | null>(null);
const rail = ref<HTMLElement | null>(null);
/** The thumb rail loops like every other band in the app. Its own `rail` ref is the photo strip inside the
 *  stage, which is a different thing entirely and slides one frame at a time, so this one carries the name. */
let stripRail: LoopRail | null = null;
/** A jump further than the mounted window has no frames to slide through, so it has to cut. */
const cut = ref(false);

/** w1920 is the largest TMDB still serves and it is exactly what the window holds at DPR 1.25. The row's own
 *  w780 rides along as each frame's background — the same URL the strip already fetched, so it is on screen for
 *  free and keeps a cold frame from going blank while the big one lands. */
const bigUrl = (p: string): string => `https://image.tmdb.org/t/p/w1920${p}`;

/** `k` is the index into backdrops, and placing a frame by (k - cur) is what lets it keep its element across a
 *  step. Clamped at both ends rather than wrapped: a wrap would drag the whole strip past the window instead of
 *  moving one frame. */
const frames = computed(() => {
  const i = viewer.value;
  const out: { k: number; p: string }[] = [];
  if (i == null) return out;
  for (let k = i - 2; k <= i + 2; k++) {
    const p = backdrops.value[k];
    if (p) out.push({ k, p });
  }
  return out;
});

/* Dragging the photo itself: the rail tracks the pointer one-for-one with transitions off, up to one frame's
   pitch, and the release either finishes the travel or springs back. The gap between two mounted neighbours is
   exactly one pitch at any moment — they share the slide, the drag and the easing — so it is measured here
   rather than by writing the CSS geometry out twice. */
const drag = ref(false);
const dragPx = ref(0);
let dragId = -1;
let dragFrom = 0;
let dragLastX = 0;
let dragLastT = 0;
let dragVel = 0;
let dragPitch = 1;
let dragTap: HTMLElement | null = null;

const railStyle = computed(() => ({
  '--cur': String(viewer.value ?? 0),
  '--drag': `${dragPx.value}px`,
  ...(drag.value ? { '--slide': '0s' } : null),
}));

function openViewer(i: number): void {
  stopStrip();
  viewer.value = i;
}
function closeViewer(): void {
  viewer.value = null;
  drag.value = false;
  dragPx.value = 0;
  dragId = -1;
  stopStrip();
}
/** A false `slide` only comes from a thumb click, and even then a step or two is worth sliding, because those
 *  frames are mounted and decoded already; past them the window has a hole where the slide would run. */
function place(i: number, slide: boolean): void {
  const at = viewer.value;
  if (at == null || i < 0 || i >= backdrops.value.length || i === at) return;
  stopStrip();
  if (slide || Math.abs(i - at) <= 2) {
    viewer.value = i;
    return;
  }
  cut.value = true;
  viewer.value = i;
  void nextTick(() => {
    void rail.value?.offsetWidth; // resolve the new offsets while the transitions are still off
    cut.value = false;
  });
}
function stepViewer(dir: number): void {
  const i = viewer.value;
  if (i != null) place(i + dir, true);
}
function tapViewer(): void {
  const fr = dragTap?.closest<HTMLElement>('.lb-fr');
  const k = fr ? Number(fr.dataset.k) : NaN;
  // The art is still the close surface it was; a neighbour is the one thing a tap sends you to.
  if (!Number.isInteger(k) || k === viewer.value) closeViewer();
  else place(k, true);
}
function onStageDown(e: PointerEvent): void {
  const el = rail.value;
  if (e.button !== 0 || !el || backdrops.value.length < 2 || (e.target as HTMLElement).closest('button')) return;
  const kids = el.children;
  const a = kids[0] as HTMLElement | undefined;
  const b = kids[1] as HTMLElement | undefined;
  dragPitch = (a && b ? Math.abs(b.getBoundingClientRect().left - a.getBoundingClientRect().left) : a?.getBoundingClientRect().width) || 1;
  dragId = e.pointerId;
  dragFrom = e.clientX;
  dragLastX = e.clientX;
  dragLastT = e.timeStamp;
  dragVel = 0;
  dragTap = e.target as HTMLElement;
  drag.value = true;
  stage.value?.setPointerCapture(e.pointerId);
}
function onStageMove(e: PointerEvent): void {
  if (!drag.value || e.pointerId !== dragId) return;
  const dt = e.timeStamp - dragLastT;
  if (dt > 0) {
    dragVel = (e.clientX - dragLastX) / dt;
    dragLastX = e.clientX;
    dragLastT = e.timeStamp;
  }
  const raw = e.clientX - dragFrom;
  dragPx.value = Math.max(-dragPitch, Math.min(dragPitch, raw));
}
function onStageUp(e: PointerEvent): void {
  if (!drag.value || e.pointerId !== dragId) return;
  const dx = dragPx.value;
  drag.value = false;
  dragPx.value = 0;
  dragId = -1;
  if (stage.value?.hasPointerCapture(e.pointerId)) stage.value.releasePointerCapture(e.pointerId);
  if (Math.abs(dx) < 6) {
    tapViewer();
    return;
  }
  // Past a third of a frame, or a real flick in the direction already travelled, the drag owns the step.
  if (Math.abs(dx) > dragPitch * 0.34 || (Math.abs(dragVel) > 0.35 && Math.sign(dragVel) === Math.sign(dx))) stepViewer(dx > 0 ? -1 : 1);
}
function onStageCancel(): void {
  drag.value = false;
  dragPx.value = 0;
  dragId = -1;
}
/* The strip is a horizontal rail, so a normal wheel over it should push it sideways rather than scroll nothing.
   It used to merge the deltas and hand each frame a fresh `scrollBy({ behavior: 'smooth' })`, which restarts its
   own ease-in every ~16 ms: a streamed gesture crawled and hitched instead of running. Now the wheel only moves
   a target and one loop follows it, so a stream keeps its speed and a lone notch still eases. */
let stripWant = 0;
let stripRun = false;
let stripFrame = 0;
function stopStrip(): void {
  stripRun = false;
  if (stripFrame) cancelAnimationFrame(stripFrame);
  stripFrame = 0;
}
function followStrip(): void {
  stripFrame = 0;
  const el = strip.value;
  if (!el) {
    stripRun = false;
    return;
  }
  // The loop moves the rail across a seam by one list-length; the target has to be carried along with it
  // or the follow loop chases an offset the rail no longer has. 「onShift」 in the watch below carries it.
  if (stripRail) stripRail.normalize(true);
  // Asked of the rail, because a gesture that keeps adding to its target runs past where the copies end;
  // there it steps the rail and the target back by a whole list together rather than parking at the wall.
  const want = stripRail ? stripRail.place(stripWant, false) : Math.max(0, Math.min(el.scrollWidth - el.clientWidth, stripWant));
  const before = el.scrollLeft;
  const gap = want - before;
  if (Math.abs(gap) < 0.7) {
    el.scrollLeft = want;
    stripRun = false;
    return;
  }
  el.scrollLeft = before + gap * 0.22;
  // A rail that cannot go further, or one whose offset rounds every nudge away, must not spin.
  if (el.scrollLeft === want || el.scrollLeft === before) stripRun = false;
  else stripFrame = requestAnimationFrame(followStrip);
}
function onStripWheel(e: WheelEvent): void {
  const el = strip.value;
  if (!el) return;
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (!d) return;
  if (!stripRun) {
    // Wherever a thumb click or a drag left the rail is where the gesture starts, and writing the offset back
    // is also what cancels the centring glide, so the two hands never pull the rail against each other.
    const live = el.scrollLeft;
    el.scrollLeft = live;
    stripWant = live;
  }
  stripWant += d;
  stripRun = true;
  if (!stripFrame) stripFrame = requestAnimationFrame(followStrip);
}
/** Pull the thumb being looked at to the middle of the rail. It writes to the same target the wheel does
 *  instead of calling `scrollIntoView`: a native glide keeps its destination to itself, so one notch used to
 *  abandon a twenty-four-thumb jump where it happened to be (measured: 680 of 2380). One target, and the
 *  notches add to the jump instead. */
function centerStrip(i: number): void {
  const el = strip.value;
  // Counted among the rail's own thumbs: the copies a looping rail keeps at either end are children of it
  // too, so `children[i]` would centre the wrong picture.
  const thumb = (stripRail ? stripRail.cardAt(i) : el?.children[i]) as HTMLElement | undefined;
  if (!el || !thumb) return;
  // Both boxes are read in the same frame, so this is the distance from wherever the rail currently sits —
  // which is what a target the wheel is still allowed to add to has to be.
  const b = el.getBoundingClientRect();
  const r = thumb.getBoundingClientRect();
  stripWant = el.scrollLeft + (r.left + r.width / 2) - (b.left + b.width / 2);
  stripRun = true;
  if (!stripFrame) stripFrame = requestAnimationFrame(followStrip);
}
function onViewerKey(e: KeyboardEvent): void {
  if (techPop.value) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeTech();
    }
    return;
  }
  if (viewer.value == null) return;
  if (e.key === 'Escape' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.stopPropagation();
  if (e.key === 'Escape') closeViewer();
  else if (e.key === 'ArrowLeft') stepViewer(-1);
  else if (e.key === 'ArrowRight') stepViewer(1);
}

/* The rail only exists while the viewer is open, so the loop is built and torn down with it. `auto` is
   off because nothing moves this rail on its own: the wheel and the centring both write a target that
   `followStrip` walks to, and that is where the seam is crossed. */
watch(strip, el => {
  stripRail?.destroy();
  stripRail = el ? createLoopRail(el, { auto: false, onShift: d => { stripWant += d; } }) : null;
});

watch(viewer, i => {
  if (i == null) return;
  // The rail slides two frames in from each side before anyone looks at them, so pull them in while this frame
  // is up; a step that has to start a decode is the stall the old insert used to dress up as a flicker.
  for (const d of [-2, -1, 1, 2]) {
    const p = backdrops.value[i + d];
    if (p) new Image().src = bigUrl(p);
  }
  void nextTick(() => centerStrip(i));
});

/* Capture phase, because the titlebar owns Esc as 「go home」 on the same window and registers before this
   view mounts; listening in the bubble phase would close the still and bounce out of the page with it. */
onMounted(() => window.addEventListener('keydown', onViewerKey, true));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onViewerKey, true);
  stripRail?.destroy();
  stripRail = null;
  stopStrip();
});

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

/* A credit's face is the one picture on this page that arrives from a place which can answer with nothing:
   the gateway mints a URL for the person's tag and sometimes will not render it. The initial is already the
   other half of the same test, so a face that will not decode only has to retire its URL. */
const faceDead = ref<Record<string, true>>({});
const faceOf = (p: CrewRow): string => {
  const url = p.face || faces.value[p.id] || '';
  return url && !faceDead.value[url] ? url : '';
};
const onFaceFail = (p: CrewRow): void => {
  const url = p.face || faces.value[p.id] || '';
  if (url) faceDead.value = { ...faceDead.value, [url]: true };
};

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

/** The 在看 rows the lobby pulled, still in hand on this page. Two readers: the work-level pick that
 *  decides which season the page opens on, and the stop a Movie or Episode page names from its own row.
 *  A season's button does not read them — it reads that season's rows. */
const resumeRow = computed(() => app.rows.find(r => r.key === 'resume')?.items || []);
/** The rows of the season on screen, and only while they really are that season's: the band keeps its
 *  height across a switch, so the rows being left sit here for a beat under the new season's number. */
const seasonRows = computed<LibraryItem[]>(() => (episodeN.value === seasonN.value ? episodes.value : []));
/** The row this hero is about, as the shared button reads it. A show's button answers for the season the
 *  page is open on rather than for the work: 第 2 季 says what 第 2 季 holds, and a season nobody has
 *  started names its own first episode. The lobby keeps asking the work-level question of where the viewer
 *  last stopped, so the two now disagree on purpose — measured on 摩登家庭, the work-level button named
 *  「第 1 季 · 第 1 集 · 看到 18:26」 while the page was open on a 特别篇 this server holds nothing for, so
 *  the plate promised a file and the badge under it denied it. */
const resume = computed(() =>
  isSeries.value || isSeason.value ? seasonTarget(seasonRows.value) : resumeTarget(item.value, [], resumeRow.value, false),
);
/** The one item the play button is about: whatever it says, it plays. A type that names no media source is
 *  not handed to the player at all — measured, 合集/播放列表/资源库 pages answering 「播放」 died on
 *  「服务器出错了（HTTP 500）」 because PlaybackInfo has no file to negotiate. */
const playTarget = computed<LibraryItem | null>(
  () => resume.value?.item || (PLAYABLE.includes(item.value?.type || '') ? item.value : null),
);
/** Whether this page's type can hold a play button at all. Read off `pageType`, which is known from the
 *  seed row before the item arrives, so the button is either there or not from the first painted frame —
 *  gating it on `playTarget` would let it pop in when a show's season list lands and slide 收藏 along. */
const pagePlays = computed(() => PLAYABLE_PAGE.includes(pageType.value));
const playableId = computed(() => playTarget.value?.id || '');
/* The file this page describes inline: a page with no episode row has exactly one file to speak of, and
   it is the row the page is built from. On a show the files are named one card at a time instead, by the
   dots at each card's corner. */
const techInline = computed<LibraryItem | null>(() =>
  isSeries.value || isSeason.value || !item.value?.sources?.length ? null : item.value,
);
/* What that button opens. A card's own row carries no MediaSources — measured 2026-10-22 on both
   gateways: the season listing answers none on every episode row, while the item endpoint answers one per
   episode (6.0KB/0.77s on OkEmby, 23.0KB/0.79s on nyamedia) — so the ask goes out when the reader asks
   for it, and the 10-minute cache every other ask uses makes a second look at that episode instant. */
const techPop = ref<{ id: string; title: string; item: LibraryItem | null; dead: boolean } | null>(null);
/* The 轨道 bar is the one block a placeholder cannot read off the ask: measured on 31 episodes, 21 answer with
   that band and 10 — every web rip of 罚罪 — answer with none, and a bar drawn for a block that never arrives
   moves the whole sheet 43px when the file lands. A season is one release, so the page keeps the shape the
   last answer came in and paints the next placeholder like it. The season's own id is the key, because this
   view is not rebuilt when the reader jumps to another title: a guess left over from 罚罪 must not silence
   the band on an anime, and an unknown season keeps drawing it — which is the answer two seasons in three. */
const bandSeen = ref<{ key: string; band: boolean } | null>(null);
const bandGuess = computed(() => {
  const seen = bandSeen.value;
  if (!seen || seen.key !== (seasonAt.value?.season?.id || '')) return true;
  return seen.band;
});

async function openTech(r: BandRow): Promise<void> {
  techPop.value = { id: r.id, title: r.title, item: null, dead: false };
  const res = await embyCached('item', r.id, () => window.echoemby.emby.item(r.id));
  const pop = techPop.value;
  // Closed, or replaced by another card while this was out: that answer belongs to a dialog nobody is
  // reading, and writing it here would paint episode 7's numbers under episode 12's name.
  if (!pop || pop.id !== r.id) return;
  const row = res.ok ? res.data : null;
  pop.item = row?.sources?.length ? row : null;
  pop.dead = !pop.item;
  const src = pop.item?.sources?.[0];
  if (src) bandSeen.value = { key: seasonAt.value?.season?.id || '', band: src.audio.length > 1 || (src.subtitle?.length ?? 0) > 0 };
}

function closeTech(): void {
  techPop.value = null;
}
/** Whether the season on screen is one this server holds nothing for. Only answers that cannot be taken
 *  back count, because a promise retracted a frame later is the same lie in reverse: a TMDB-only season
 *  row is only made once the season list has answered, and a server row carrying `ChildCount: 0` is the
 *  server itself saying it holds no episodes. This is the same test `openSeason` makes at its own early
 *  return, and since 2026-10-20 it is the only place the page says it: the season line's badge is gone and
 *  the hero's 「当前服务器无资源」 carries the sentence, which is where the reader was about to act. */
const seasonAbsent = computed(() => {
  if (!isSeries.value && !isSeason.value) return false;
  const at = seasonAt.value;
  return !!at && (!at.season || at.season.childCount === 0);
});
/** Whether the hero says 「当前服务器无资源」 in the button's place. A page whose item arrived but names no
 *  file is settled by the item endpoint; a rail still on its way keeps saying 播放. */
const noResource = computed(() => {
  if (!pagePlays.value || playTarget.value) return false;
  return isSeries.value || isSeason.value ? seasonAbsent.value : !!item.value;
});
const epiBand = ref<InstanceType<typeof HScroller> | null>(null);
/** The card the episode row should open on: the episode still in progress, when the season on screen holds
 *  it. -1 for a movie, for a finished show and for a season the viewer never started. */
const resumeIndex = computed(() => {
  const id = resume.value?.item.id;
  return id ? episodes.value.findIndex(e => e.id === id) : -1;
});
/* One glide per season, keyed instead of unconditional: the cards re-paint again when TMDB's stills land a
   beat after the row, and a watcher that ran on every recompute would pull the reader back onto the stopped
   episode while they were already looking for the one past it. Index 0 is where the row opens anyway.
   The band is a source because the switch unmounts it for the beat where `episodes` is empty: a key spent on
   a band that is not there is the last glide that season gets. And the key is dropped in `paint`, because
   vue-router hands the SAME instance to the next `/detail/*` — measured, 凡人修仙传's series page and its
   第 1 季 page are one object over one stopped card, so the season page mounted to find the key already
   spent and held scrollLeft 0 while the card sat 56206px away. */
let focusedOn = '';
watch([episodeN, resumeIndex, () => epiBand.value], async () => {
  if (episodeN.value < 0 || !epiBand.value) return;
  // -1 is a season the viewer never started, and 0 is one whose stop is its first card: both are read
  // from the front, so the ask is card 0 either way. Skipping it left the rail where the previous season
  // had put it — 爱情公寓 第 4 季 opened holding 4075px of the 第 1 季 list it no longer shows.
  const i = Math.max(0, resumeIndex.value);
  const key = `${episodeN.value}:${i}`;
  if (focusedOn === key) return;
  await nextTick();
  if (epiBand.value?.focusCard(i)) focusedOn = key;
});
/** The row's headline is the episode's own number and then whatever it is actually called. The 「第 1 季」
 *  half is gone: the picker above the row already names the season, so restating it on every card spent
 *  the line's whole width on nothing. The names come off `stillRow`, the same season reply the art and
 *  the paragraph are already asked for, so a title costs 24 bytes and no round trip — and in the one order
 *  every text surface here now uses: TMDB in Chinese, then TMDB in whatever else it files the work, then
 *  the server's row. Every candidate goes through `episodeTail`, which drops a name that only repeats the
 *  position the card already prints: measured over 3681 rows, 645 are 「第 57 集」 and 63 more are
 *  「ゆるキャン△ - S01E06」, while the rest keep their own title. */
const epTitle = (e: LibraryItem): string => {
  const r = stillRow(e.indexNumber, e.premiereDate);
  return episodeHead(
    { episode: e.indexNumber, season: e.parentIndexNumber ?? seasonNumber.value, seriesName: e.seriesName || work.value?.name },
    r?.nZh,
    r?.nOther,
    e.name,
  );
};
const epSeen = (e: LibraryItem): string => seenLabel(e.userData, e.runTimeTicks);
const epPlayed = (e: LibraryItem): number => Math.min(100, e.userData?.playedPercentage || 0);

/** One card of the episode band, drawn from whichever side owns that episode. A season this server holds
 *  files for answers with its own rows — its art, its length, where the viewer stopped; a season it holds
 *  none of answers with TMDB's list, and its card has no file to open, so `id` is empty and the play
 *  triangle is not drawn. One shape rather than two blocks of markup, because the same episode must not be
 *  able to wear two different cards on the same page. */
interface BandRow {
  key: string;
  id: string;
  art: string;
  ph: string;
  title: string;
  date: string;
  len: string;
  seen: string;
  played: number;
  ov: string;
}
const artDead = ref<Record<string, true>>({});
/** A card's picture is a ladder, and a rung that will not decode has to step down rather than leave an
 *  empty frame: the gateway mints a URL for an episode's own Primary it cannot always render (measured: it
 *  answers 500 for some), and the same card has a still of its own on TMDB behind it. Keyed by the URL, so
 *  the second rung is tried, and the letter only shows once every candidate has failed. */
const pickArt = (key: string, urls: string[]): string => urls.find(u => u && !artDead.value[`${key}|${u}`]) || '';
const onArtFail = (r: BandRow): void => {
  if (!r.art) return;
  artDead.value = { ...artDead.value, [`${r.key}|${r.art}`]: true };
};
const band = computed<BandRow[]>(() => {
  if (seasonRow.value) {
    return episodes.value.map(e => ({
      key: e.id,
      id: e.id,
      art: pickArt(e.id, [epArt.value[e.id] || '', stillUrl(e.indexNumber, e.premiereDate)]),
      ph: (e.name || '?').slice(0, 1),
      title: epTitle(e),
      date: epDate(e),
      len: epLen(e),
      seen: epSeen(e),
      played: epPlayed(e),
      ov: epOverview(e),
    }));
  }
  return Object.keys(stills.value)
    .map(Number)
    .sort((a, b) => a - b)
    .map(k => {
      const r = stills.value[k];
      return {
        key: `t${k}`,
        id: '',
        art: pickArt(`t${k}`, [tmdbStillUrl(r?.p)]),
        ph: (r?.nZh || r?.nOther || '?').slice(0, 1),
        title: episodeHead({ episode: k, season: seasonNumber.value, seriesName: work.value?.name }, r?.nZh, r?.nOther),
        date: fmtDate(r?.air),
        len: fmtMinutes(r?.rt),
        seen: '',
        played: 0,
        ov: r?.ovZh || r?.ovOther || '',
      };
    });
});

/** The band on screen with its header and no cards. The header holds the season picker, so a season that
 *  turns out to have nothing to show has to keep the band: without it the control that put the reader here
 *  goes away with the cards and there is no way back. It waits for the ask to land, because a line about
 *  what is missing while the answer is still on its way is the same lie as a blank stretch of page. */
const noBand = computed(() => seasonN.value >= 0 && !band.value.length && !wantRail.value && stillsSettled.value);

/* The 分类 block is about the work, not about this server's tagging of it, so it reads TMDB first and the
   gateway's own labels after. Measured here: 32 of this library's 400 Series/Movie rows bill no genre at all
   (暗杀教室：365天的时间 among them), and the block used to disappear with them. */
const genres = computed(() => mergeGenres(scores.value.tmdb?.genres, work.value?.genres));
const premiered = computed(() => fmtDate(item.value?.premiereDate) || String(item.value?.productionYear || ''));

/** One numbered season of this work, and where its files would be. `season` is null for the seasons this
 *  server has no row for — the ones the reader now opens here instead of on another page. */
interface ServerSeason {
  n: number;
  seriesId: string;
  season: LibraryItem | null;
}

/* TMDB and this server do not always count the same season. The threshold and the sweep that picked it
   live in `trustSeason`, because the player's season chips have to refuse the same pairings this page does. */
const trustRow = (n?: number | null, count?: number): TmdbSeasonRow | null => trustSeason(scores.value.tmdb?.seasons, n, count);

/** Every season this work has, on either side of the pair, in one number-ordered list.
 *
 *  Two rows of one split work can both bill a 第 1 季 (measured: 11 of 14 sampled split works overlap that
 *  way, and 碧蓝之海 holds two copies of 第 3 季), so the rows are never concatenated — the fuller one
 *  answers for the number. TMDB's own rows join only once the server has finished answering, so the list can
 *  grow but cannot contradict itself: a season added after the sweep is one the sweep found nothing for.
 *  TMDB's own rows join only when they hold episodes: 15 of the 1753 season rows in this machine's cache
 *  carry a number and no episodes at all, which is an announcement, not anything a viewer can press. Season
 *  0 joins on those same terms (232 of the 889 works cached here hold a 特别篇 with episodes in it, and
 *  TMDB names every one of them 特别篇, so the picker never reads 第 0 季), and a server row for the same
 *  number answers for it first, which is how 冰菓 keeps its own 「Specials」. */
const seasons = computed<ServerSeason[]>(() => {
  const byN = new Map<number, ServerSeason>();
  for (const g of serverSeasons.value) {
    const n = g.season.indexNumber ?? 0;
    if (n < 0) continue;
    const held = byN.get(n);
    if (!held || (g.season.childCount || 0) > (held.season?.childCount || 0)) byN.set(n, { n, seriesId: g.seriesId, season: g.season });
  }
  if (seasonsAsked.value) {
    for (const t of scores.value.tmdb?.seasons || []) if (t.epCount && !byN.has(t.n)) byN.set(t.n, { n: t.n, seriesId: '', season: null });
  }
  return [...byN.values()].sort((a, b) => a.n - b.n);
});

/** The season this page is answering for: the open tab on a Series, the item itself on a Season page. A page
 *  opened straight on a season its parent's list did not answer with is still its own answer, and the series
 *  above it is the row those episodes belong to. */
const seasonAt = computed<ServerSeason | null>(() => {
  const hit = seasons.value.find(x => x.n === seasonN.value);
  if (hit) return hit;
  return isSeason.value && item.value && (item.value.indexNumber ?? 0) === seasonN.value
    ? { n: seasonN.value, seriesId: item.value.parentId || '', season: item.value }
    : null;
});
const seasonRow = computed<LibraryItem | null>(() => seasonAt.value?.season || null);
const seasonNumber = computed(() => (seasonN.value >= 0 ? seasonN.value : null));
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
  return tmdbSeason.value && seasonNumber.value != null && /^\d{1,8}$/.test(id) ? `${seasonNumber.value}|${id}` : '';
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
  const [n, id] = key.split('|');
  const at = seasonN.value;
  void window.echoemby.meta.tmdbSeasonCast({ tmdbId: id, season: Number(n) }).then(x => {
    if (!x.ok || !x.data) return;
    castByKey.set(key, x.data);
    if (seasonN.value === at) seasonCast.value = x.data;
  });
});

/* The ask is not gated on the season pairing, but every reader of its rows is. A count test cannot tell a
   mispaired season from a show that is still airing — PSYREN's 3 files against TMDB's 13 refused the season
   and cost all three cards a picture TMDB has for each of them — so the reply is fetched whenever the work
   has a TMDB id and a season number, and `stillRow` then decides per episode, on that episode's own air
   date, whether a row may dress the card. A pairing that is genuinely wrong (800 Meters' 1 against TMDB's
   3) fails the date test too and paints what it painted before. What this costs is one season reply per
   refused pairing, cached for 14 days. Held keyed and repainted from the key, because `loadEpisodes` clears
   the map on every switch and a switch back must not wait out a second ask. */
const stillsAsked = new Set<string>();
const stillsByKey = new Map<string, TmdbStills>();
const stillsKey = (): string => {
  const id = String(work.value?.providers?.tmdb || '');
  return seasonNumber.value != null && /^\d{1,8}$/.test(id) ? `${seasonNumber.value}|${id}` : '';
};
watch(stillsKey, key => {
  if (!key) return;
  const hit = stillsByKey.get(key);
  if (hit) {
    stills.value = hit;
    stillsSettled.value = true;
    return;
  }
  if (stillsAsked.has(key)) return;
  stillsAsked.add(key);
  const [n, id] = key.split('|');
  const at = seasonN.value;
  void window.echoemby.meta.tmdbStills({ tmdbId: id, season: Number(n) }).then(x => {
    if (!x.ok || !x.data) {
      /* A question that failed is not an answer of no. Let the next visit ask it again, and say on screen
         for the season open now that there is no list, since the band would otherwise stay empty with no
         reason given for it. */
      stillsAsked.delete(key);
      if (seasonN.value === at) stillsSettled.value = true;
      return;
    }
    stillsByKey.set(key, x.data);
    if (seasonN.value === at) {
      stills.value = x.data;
      stillsSettled.value = true;
    }
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
    /* This season's own date, from either side of the pair. The work-level premiere used to sit here as
       the last fallback, and under a heading that names a season it prints the day the series started as
       though that season aired then. */
    date: fmtDate(t?.airDate) || fmtDate(row?.premiereDate),
    eps: row?.childCount ?? t?.epCount ?? 0,
    /* The season's length summed from the rows in hand, and only when those rows are this season's. The
       server's Series-level RunTimeTicks is neither this season's nor any episode's (measured: 64 分钟 for a
       season that runs 17 小时 18 分), so there is no cheaper number to put here while the fetch is out. */
    runtime: episodeN.value === seasonN.value ? fmtRuntime(episodes.value.reduce((a, e) => a + (e.runTimeTicks || 0), 0)) : '',
    vote: t?.voteAverage || 0,
    overview: t?.ovZh || t?.ovOther || row?.overview || '',
  };
});
const overviewText = computed(() => pack.value?.overview || workOverview.value);

/** 「2021-04-09 · 16 集 · 17小时18分」 for the season on screen. Until that season is known the line says
 *  nothing about counts: a collection keeps its own 部 count, which is the one number whose subject is
 *  already on screen. */
const metaLine = computed(() => {
  const p = pack.value;
  const parts = p
    ? [p.date, p.eps ? `${p.eps} 集` : '', p.runtime]
    : [
        premiered.value,
        /* The row's ChildCount answers for whatever the row is, and while `pack` is out the row is not yet
           the subject this line speaks for: on a season page it is the season's own episode count, which
           this line then printed with the 季 unit — measured, 「2018-10-16 · 20 季」 readable for 0.6-1.9 s
           over the 「第 1 季」 heading before it corrected itself to 「20 集」 (菜鸟老警 第 1 季). Same reason
           the runtime below waits: one row's figure under a heading that names a season. */
        isSeries.value || isSeason.value
          ? ''
          : item.value?.type === 'BoxSet' && item.value.childCount
            ? `${item.value.childCount} 部`
            : '',
        // A show's own RunTimeTicks is neither its seasons' nor its episodes' — measured 64 分钟 for a
        // season that runs 17 小时 18 分 — so the one line that number belongs to stays empty until the
        // season rows arrive and `pack` can sum a real one.
        isSeries.value || isSeason.value ? '' : fmtRuntime(item.value?.runTimeTicks),
      ];
  return parts.filter(Boolean).join(' · ');
});

/* The season's own number, printed on the line that already names the season. TMDB bills a season inside
   the work-level reply this page already holds (measured: 224 of the 315 seasons opened on this machine have
   one, and it sits a median 0.6 away from the work's figure). A season TMDB does not score prints nothing
   here: the work's figure would answer for a different subject than the one this line has just named. */
const seasonVote = computed(() => pack.value?.vote || 0);
const seasonVoteUrl = computed(() => {
  const id = String(work.value?.providers?.tmdb || '');
  return seasonVote.value && tmdbSeason.value && /^\d{1,8}$/.test(id)
    ? `https://www.themoviedb.org/tv/${id}/season/${seasonNumber.value}`
    : '';
});

const fav = computed(() => !!work.value?.userData?.isFavorite);

async function loadSeason(n: number) {
  if (!(n >= 0)) return;
  seasonN.value = n;
  // Whatever belonged to the season being left goes before anything new is asked for: an old season's
  // stills would otherwise hang on the new season's episode numbers for the few hundred ms TMDB takes,
  // and its art would dress the new one. The episode row keeps its height, so the page does not jump.
  // The stills and the credits are repainted from the key this season is asked under rather than blanked:
  // clicking the season already on screen re-enters here, and the watches do not fire for a key they have
  // already seen, so a blind clear would drop this season's pictures for the rest of the visit.
  const hit = stillsByKey.get(stillsKey());
  stills.value = hit || {};
  stillsSettled.value = !!hit;
  seasonArt.value = '';
  seasonCast.value = castByKey.get(castKey()) || null;
  const at = seasonAt.value;
  if (!at?.season) {
    // This machine holds no row for the season just picked, so there is nothing to ask it for. The band
    // below is built from TMDB's own list, and the cards it draws carry no file to open.
    episodes.value = [];
    episodeN.value = n;
    return;
  }
  const seriesId = at.seriesId;
  const sid = at.season.id;
  if (at.season.primaryImageTag) {
    void app.imageUrl({ id: sid, primaryImageTag: at.season.primaryImageTag }, 300).then(u => {
      if (seasonN.value === n) seasonArt.value = u;
    });
  }
  const r = await embyCached('episodes', { seriesId, seasonId: sid }, () => window.echoemby.emby.episodes({ seriesId, seasonId: sid }));
  if (r.ok && seasonN.value === n) {
    episodes.value = r.data || [];
    episodeN.value = n;
  }
  if (isSeason.value) await loadSeries(seriesId);
}

/** The seasons this work's sibling Series rows hold.
 *
 *  Run beside the row on screen rather than before it: the picker can be drawn from one answer, and all this
 *  sweep adds is the seasons that row does not have — and the label saying whether anything does. A work
 *  filed as a single row (374 of this library's 386) pays one cached title query and no season query at all.
 *
 *  It is also the only thing that keeps that verdict honest. Measured: of 72 rows with a shortfall, 6 have
 *  the missing season on a sibling row, and a list built from one row would print that label on files the
 *  account really does hold. */
async function askSiblings(series: LibraryItem): Promise<void> {
  const page = props.id;
  const tmdb = String(series.providers?.tmdb || '');
  const kind = kindOf(series);
  if (!kind || !/^\d{1,8}$/.test(tmdb)) {
    seasonsAsked.value = true;
    return;
  }
  const rows = await libraryWorks(kind, tmdb, series.name);
  // `null` is a server that has not answered, not one that holds nothing: the list keeps its silence about
  // seasons nobody has been asked for rather than label them absent.
  if (props.id !== page || rows === null) return;
  const groups = await Promise.all(
    rows
      .filter(x => x.id !== series.id)
      .map(async row => ({ id: row.id, s: await embyCached('seasons', row.id, () => window.echoemby.emby.seasons(row.id)) })),
  );
  if (props.id !== page) return;
  const extra = groups.flatMap(g => (g.s.ok ? g.s.data || [] : []).map(season => ({ seriesId: g.id, season })));
  if (extra.length) serverSeasons.value = [...serverSeasons.value, ...extra];
  seasonsAsked.value = groups.every(g => g.s.ok);
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
/** 「第 3 季 · 刀匠村篇」, and nothing else. The name comes off whichever side has one: TMDB bills 立志篇
 *  for seasons this machine files by number alone, and it bills the ones nobody has at all. Whether this
 *  server holds the season is not part of its name — that is the badge beside the picker's job, so the pill
 *  reads the same width whichever season is picked and the work page's rows match these. */
const seasonLabel = (s: ServerSeason): string => seasonTitle(s.n, s.season?.name, trustRow(s.n, s.season?.childCount)?.name);

/* One button that pours the season list out of its bottom edge, on the picker's own vocabulary rather than a
   second dropdown drawn for this page. Its options stack one to a row: 「第 1 季」 and
   「第 1 季 · 追想篇」 have no cell wide enough for both, and a cloud of them wrapped into two columns
   whose right edges lined up with nothing. */
const seasonOptions = computed(() => seasons.value.map(s => ({ value: String(s.n), label: seasonLabel(s) })));
/** A Season page can name a season its parent's list did not answer with, and a picker that cannot match its
 *  value prints that value as the label. An unmatched season hands it the empty one instead. */
const seasonPick = computed(() => (seasons.value.some(s => s.n === seasonN.value) ? String(seasonN.value) : ''));
/** Re-picking the season already on screen is the picker's "unset" answer, not a request to load it again. */
function pickSeason(v: string | string[]): void {
  // The control answers with the empty string when the chip already on screen is pressed again, and
  // `Number('')` is 0 — which is 第 0 季 here, not "nothing". Read the string before the number.
  const n = typeof v === 'string' && v !== '' ? Number(v) : NaN;
  if (!(n >= 0)) return;
  void loadSeason(n);
}

/** Which title the once-per-title asks (the logo band and the backdrop strip) have been made
 *  for. The row and the server's copy of it are the same work, so the second paint refines the item
 *  without paying for them again. */
let painted = '';
/** Set when the lobby's 播放 pressed on a slide it could not play itself — a Series names no file — and the
 *  page it opened is the only place that knows which episode to start. Held as an id so a switch to another
 *  title drops it: an arrival is a request about one work, not a mode the page stays in. */
let autoplayFor = '';
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
  serverSeasons.value = [];
  seasonsAsked.value = false;
  seasonN.value = -1;
  episodes.value = [];
  episodeN.value = -1;
  stillsSettled.value = false;
  focusedOn = '';
  stills.value = {};
  seasonArt.value = '';
  seasonCast.value = null;
  // The line that says 「这一项还不能直接播放」 is about the title being left, not the one arriving.
  playErr.value = '';
  scroll.value = 0;
  resetPageScroll(scroller.value);
  // A Season row carries no external id and no Logo, so every ask below would be made against nothing.
  // On those pages they come with the series, from loadChildren.
  if (it.type === 'Season') return;
  askWork(it);
}

/** The title's own two asks: its ranked treatments and its backdrop strip. None of
 *  them has a season-level answer, so a Season page runs them for the series above it. */
function askWork(series: LibraryItem): void {
  const page = props.id;
  void app.logoCandidates(series).then(u => (props.id === page ? (titleUrls.value = u) : undefined));
  const kind = kindOf(series);
  const tmdbId = String(series.providers?.tmdb || '');
  if (!kind || !/^\d{1,8}$/.test(tmdbId)) return;
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
    serverSeasons.value = (s.ok ? s.data || [] : []).map(season => ({ seriesId: it.id, season }));
    void askSiblings(it);
    /* Open on the season the viewer stopped in, not on whichever row the server listed first: 爱情公寓 was left
       at 第 2 季 第 3 集 while the page showed 第 1 季's cards, so the episode they meant to press sat behind a
       tab. Read off the 在看 rows the lobby already pulled — measured: 200/200 of the resumable episode rows
       that query answers carry their ParentId, so this costs no request. A show nobody has started falls back
       to the first season with episodes, exactly as before. */
    const stop = resumeTarget(it, resumeRow.value)?.item;
    const home =
      (stop && serverSeasons.value.find(x => x.season.id === stop.seasonId)) ||
      (stop && stop.parentIndexNumber != null && serverSeasons.value.find(x => x.season.indexNumber === stop.parentIndexNumber)) ||
      undefined;
    const first = home?.season.childCount ? home : serverSeasons.value.find(x => x.season.childCount) || serverSeasons.value[0];
    if (first) await loadSeason(first.season.indexNumber ?? 0);
  } else if (it.type === 'Season') {
    /* A page opened on one season is still a page about a series: its scores, its logo and its season
       tabs all belong one level up, and the switcher cannot be drawn from a list nobody asked for. */
    const series = await loadSeries(it.parentId || '');
    if (props.id !== it.id) return;
    if (series) {
      askWork(series);
      const s = await embyCached('seasons', series.id, () => window.echoemby.emby.seasons(series.id));
      if (props.id === it.id) {
        serverSeasons.value = (s.ok ? s.data || [] : []).map(season => ({ seriesId: series.id, season }));
        void askSiblings(series);
      }
    }
    await loadSeason(it.indexNumber ?? 0);
  }
}

watch(
  () => props.id,
  async id => {
    autoplayFor = takeAutoplay(id) ? id : '';
    error.value = '';
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
      serverSeasons.value = [];
      seasonsAsked.value = false;
      seasonN.value = -1;
      episodeN.value = -1;
      stillsSettled.value = false;
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

/** The hero's own label is the promise: 「播放」 opens the file at 0, 「继续播放」 takes the server's
 *  offset. Measured on both hosts, every row the button calls unwatched really has no offset (12/12 在看
 *  rows answered the same position on the item endpoint), so honouring the label costs no real progress —
 *  and it stops a page that has not yet been handed the row from starting halfway through a first watch.
 *  The 选集 band passes false on purpose: those cards print their own 「看到」 and bar, so they resume. */
async function play(id = playableId.value, fromStart = !resume.value?.resumed) {
  if (!id) {
    playErr.value = '这一项还不能直接播放';
    return;
  }
  playErr.value = '';
  const ok = await player.play(id, fromStart);
  if (!ok) playErr.value = player.error;
}

/* The lobby's note fires the moment this page knows what to open, which for a show is after its season
   arrives — and only against the title this page actually painted: on a page-to-page switch the outgoing
   hero stays on screen a beat, and its episode is not the one that was asked for. */
watch(
  playableId,
  id => {
    if (!id || autoplayFor !== props.id || painted !== props.id) return;
    autoplayFor = '';
    void play(id);
  },
  { immediate: true },
);

async function toggleFav() {
  // The server files the heart on the series, so a page opened on one season reads and writes that,
  // rather than starring a season and leaving the show it belongs to unmarked.
  const it = work.value;
  if (!it || favBusy.value) return;
  favBusy.value = true;
  const on = !fav.value;
  // The press answers for itself: the write-back only lands when the server has filed it, and that
  // round trip measured 300-600ms on this gateway — long enough for the heart to look untouched.
  it.userData = { ...it.userData, isFavorite: on };
  if (!(await app.setFavorite(it.id, on))) it.userData = { ...it.userData, isFavorite: !on };
  favBusy.value = false;
}

const LEVEL_WORD = ['无', '极少', '轻微', '中等', '较多', '严重'];
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
              <ScoreStrip v-if="work" :item="work" class="badges" />
              <p class="overview">{{ overviewText || '暂无简介。' }}</p>
            </div>
            <div class="actions">
              <HeroPlay v-if="pagePlays" :target="resume" :busy="player.busy" :server="serverName" :none="noResource" @play="play()" />
              <button class="iconb" :class="{ on: fav }" :disabled="favBusy" :title="fav ? '已收藏' : '收藏'" @click="toggleFav">
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 20.8C10.3 18.5 2.6 14.4 2.6 8.9 2.6 5.7 4.9 3.5 7.8 3.5 9.8 3.5 11.1 5.2 12 7 12.9 5.2 14.2 3.5 16.2 3.5 19.1 3.5 21.4 5.7 21.4 8.9 21.4 14.4 13.7 18.5 12 20.8Z" fill="currentColor" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" /></svg>
              </button>
            </div>
          </div>
        </div>
      </section>
    </Transition>

    <template v-if="!item && !error">
      <div class="flow">
        <BlockPh v-if="wantRail" />
        <div v-for="n in 2" :key="n" class="block skb">
          <div class="skhd"></div>
          <div class="skrow"><div v-for="m in 5" :key="m" class="skcd"></div></div>
        </div>
      </div>
    </template>
    <p v-else-if="error" class="err pad">{{ error }}</p>

    <template v-else-if="item">
      <div class="flow sw" :class="{ on: swap }">
        <HScroller v-if="band.length || noBand" ref="epiBand" class="block epi-row" :class="{ solo: noBand }">
          <template #header>
            <div class="ep-head">
              <FilterSelect
                v-if="seasons.length > 1"
                bare
                neutral
                rows
                label="季"
                :options="seasonOptions"
                :model-value="seasonPick"
                @update:model-value="pickSeason"
              />
              <h2 v-else>{{ pack?.label || item.name }}</h2>
              <span v-if="seasonVote" class="qline">
                <span class="qn">本季评分</span>
                <a
                  class="qv"
                  :href="seasonVoteUrl || undefined"
                  target="_blank"
                  rel="noreferrer"
                  :title="`TMDB ${pack?.tag} 评分`"
                >TMDB <i>{{ seasonVote.toFixed(1) }}</i></a>
              </span>
            </div>
          </template>
          <div v-for="r in band" :key="r.key" class="epi-wrap">
            <button class="epi" :class="{ off: !r.id }" :disabled="!r.id" @click="play(r.id, false)">
              <div class="ethumb">
                <img v-reveal v-if="r.art" :src="r.art" alt="" loading="lazy" decoding="async" @error="onArtFail(r)" />
                <span v-else class="ph">{{ r.ph }}</span>
                <span class="disc" role="presentation"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 5l12 7-12 7z" fill="currentColor" /></svg></span>
                <span v-if="r.seen" class="echip">{{ r.seen }}</span>
                <div v-if="r.played > 0" class="eprog"><i :style="{ width: r.played + '%' }"></i></div>
              </div>
              <div class="einfo">
                <LoopTitle class="etitle" :text="r.title" />
                <p v-if="r.date || r.len" class="emeta">
                  <span v-if="r.date">{{ r.date }}</span>
                  <span>{{ r.len }}</span>
                </p>
                <p v-if="r.ov" class="eov">{{ r.ov }}</p>
              </div>
            </button>
            <button v-if="r.id" type="button" class="res" aria-label="播放资源" @click="openTech(r)"><i></i><i></i><i></i></button>
          </div>
          <!-- Two empties, and only one of them gets a sentence here: a season this server holds nothing
               for is answered by the hero's own 「当前服务器无资源」, which is where the reader was about to
               act. What is left to say is the anomaly the button cannot see — a row that promised episodes
               and then answered with none. -->
          <p v-if="noBand && !seasonAbsent" class="noband">这台服务器在这一季没有文件，分集也列不出来。</p>
        </HScroller>
        <BlockPh v-else-if="wantRail" />

        <section v-if="techInline" class="block">
          <h2>播放资源</h2>
          <TechCard :item="techInline" />
        </section>

        <HScroller v-if="crew.length" title="演职员" :count="crew.length" class="block">
          <div v-for="p in crew" :key="p.id" class="person">
            <div class="face">
              <img v-reveal v-if="faceOf(p)" :src="faceOf(p)" alt="" loading="lazy" @error="onFaceFail(p)" />
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

        <RelatedStrip :cards="related" />
      </div>
    </template>

    <Teleport to="body">
      <Transition name="lightbox">
        <div v-if="viewer !== null" class="lightbox" role="dialog" aria-modal="true" aria-label="剧照大图" @click.self="closeViewer" @wheel.prevent>
          <button type="button" class="lb-x" aria-label="关闭" @click="closeViewer">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" /></svg>
          </button>

          <div ref="stage" class="lb-stage" :class="{ grab: drag }" @pointerdown="onStageDown" @pointermove="onStageMove" @pointerup="onStageUp" @pointercancel="onStageCancel">
            <div ref="rail" class="lb-rail" :class="{ cut }" :style="railStyle">
              <div v-for="f in frames" :key="f.k" class="lb-fr" :class="{ on: f.k === viewer }" :data-k="f.k" :style="{ '--k': f.k, backgroundImage: `url('${backdropUrl(f.p)}')` }">
                <img :src="bigUrl(f.p)" alt="" draggable="false" decoding="async" />
              </div>
            </div>
            <button v-if="backdrops.length > 1" type="button" class="lb-edge left" aria-label="上一张" :disabled="viewer === 0" @click.stop="stepViewer(-1)">
              <svg viewBox="0 0 24 24" width="19" height="19"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
            <button v-if="backdrops.length > 1" type="button" class="lb-edge right" aria-label="下一张" :disabled="viewer === backdrops.length - 1" @click.stop="stepViewer(1)">
              <svg viewBox="0 0 24 24" width="19" height="19"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
          </div>

          <footer class="lb-foot">
            <div ref="strip" class="lb-strip" @wheel.prevent.stop="onStripWheel">
              <button v-for="(b, i) in backdrops" :key="i" type="button" class="lb-th" :class="{ on: i === viewer }" @click="place(i, false)">
                <img v-reveal :src="backdropUrl(b)" alt="" draggable="false" loading="lazy" decoding="async" />
              </button>
            </div>
            <p class="lb-count">{{ (viewer ?? 0) + 1 }} / {{ backdrops.length }}</p>
          </footer>
        </div>
      </Transition>
    </Teleport>

    <Teleport to="body">
      <Transition name="techpop">
        <div v-if="techPop" class="tech-pop" role="dialog" aria-modal="true" aria-label="播放资源" @click.self="closeTech">
          <section class="tp-card">
            <header class="tp-head">
              <div>
                <h2>播放资源</h2>
                <p class="tp-title">{{ techPop.title }}</p>
              </div>
              <button type="button" class="tp-x" aria-label="关闭" @click="closeTech">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" /></svg>
              </button>
            </header>
            <TechCard v-if="techPop.item" :item="techPop.item" />
            <p v-else-if="techPop.dead" class="tp-msg">这台服务器读不出这一集的文件参数。</p>
            <div v-else class="tp-load" aria-hidden="true">
              <i class="strip"></i>
              <div class="cols"><i class="video"></i><i class="audio"></i></div>
              <i v-if="bandGuess" class="band"></i>
              <div class="foot"><i class="name"></i><i class="date"></i></div>
            </div>
          </section>
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
.iconb:disabled { opacity: 0.62; cursor: default; }
/* One contour, stroked while off and filled while on, so the silhouette the eye compares across a press
   never moves. Its ink stays symmetric about x=12 because that is the point the plate centres on — the two
   paths this button used to swap between were not, and neither matched the other. `fill-opacity` rather
   than `fill: none` because only the first interpolates: the heart takes on colour instead of snapping. */
.iconb path { fill-opacity: 0; transition: fill-opacity var(--hov) var(--ease); }
.iconb.on path { fill-opacity: 1; }
.iconb.on { color: #ff5a6a; }

/* Mirrors the lobby's .flow: the bands clip their art here (under the rail) while the plain blocks
   inset to the content line. Children that need the line add their own --gutter padding. */
.flow {
  position: relative;
  z-index: 1;
  margin-left: var(--rail-x);
  overflow-x: clip;
  /* No reading cap, because the lobby has none either: its bands end at the window edge, so the last card is
     cut by the screen and the row reads as running off it. A cap here stopped the art 28px short of that edge
     (measured at innerWidth 1360: lobby track right 1360, this flow's right 1332), and a cut that lands in the
     middle of nothing reads as a clipped box rather than a rail. */
}
/* The season button sits in the low half of a short window, and a menu that runs off the bottom edge is
   not a choice, so the picker turns upward instead (FilterSelect's place()). Above that row is the hero, and
   its copy paints over the flow - while a panel is open, the flow has to be the thing on top. */
.flow:has(.sel.on) { z-index: 3; }
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

/* The switcher used to hang in the hero's top-right corner, where it faded out with the hero's parallax and
   had to clear the back disc. It is the title line of the row it decides now, so it rides the page and the
   sibling-switch dim like everything else under the hero. */
.ep-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  /* The line is the button's height on every title: a one-season heading stands 28px tall and would start the
     cards 6px above the line the placeholder promised them. */
  min-height: 34px;
}
.ep-head h2 { margin-bottom: 0; }
/* The season's mark hangs off the line that names the season, so the subject is said once instead of
   repeated on the number. It does not change size on hover or on a season switch: this line already
   carries the picker, and a mark that grew would push it sideways. */
.qline {
  display: inline-flex;
  align-items: baseline;
  gap: 9px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  animation: fade-in 0.3s var(--ease) both;
}
.qn {
  color: var(--text-dim);
  font-weight: 550;
}
.qv {
  color: var(--text-dim);
  font-weight: 550;
  text-decoration: none;
  transition: opacity var(--hov) var(--ease);
}
.qv i {
  font-style: normal;
  color: var(--text);
  font-weight: 700;
}
.qv:hover {
  opacity: 0.82;
}

.epi {
  flex: none;
  width: 280px;
  display: flex;
  flex-direction: column;
  /* A button's UA sheet asks for flex-start, which lets the title's own width set the column's, so a long
     特别篇 name paints over its neighbour. The work page's copy of this card already says stretch. */
  align-items: stretch;
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
/* One line, cut where it runs out: a real episode title now lands here, and a card whose headline wrapped to
   two lines would slide its date, its runtime and its paragraph down past every neighbour in the row. */
.etitle { margin: 0; font-size: 14px; font-weight: 650; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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

/* The card and its corner button are siblings, because the whole card *is* the play button and a button
   cannot hold another one: the wrapper is what the rail counts and clones, and it is the positioned box
   the badge hangs off. */
.epi-wrap {
  position: relative;
  flex: none;
  width: 280px;
}
.epi-wrap .epi { width: 100%; }
/* The menu dots, drawn rather than typed: three 3px circles in the frame's top-right corner, which is the
   only corner free — the 「看到 …」 chip holds the bottom-left and the play disc the middle. Drawn because a
   ⋮ glyph centres differently in every font, and this mark has to read as a control at 26px.
   It appears on the card the pointer is on and nowhere else: with a permanent badge on all 293 cards the
   rail wore a button in its corner like a sticker, and the corner is where the picture's own detail is.
   Hidden means unclickable, so a press there is still 播放 — the card underneath is the play target either
   way, and the keyboard reaches the dots through :focus-within without a pointer. */
.epi-wrap:hover .res,
.epi-wrap:focus-within .res { opacity: 1; pointer-events: auto; }
.res {
  position: absolute;
  top: 9px;
  right: 9px;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--r-badge);
  background: rgba(16, 16, 22, 0.74);
  backdrop-filter: blur(8px);
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--hov) var(--ease), background var(--hov) var(--ease);
}
.res i { width: 3px; height: 3px; border-radius: 50%; background: #fff; }
.res:hover { background: rgba(16, 16, 22, 0.92); }
.res:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }

/* — the dialog one of those buttons opens — */
.tech-pop {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: grid;
  place-items: center;
  padding: 32px 24px;
  background: rgba(8, 8, 12, 0.55);
  backdrop-filter: blur(14px);
  cursor: zoom-out;
}
/* 880px, because the sheet inside wants its two columns side by side: below 776px of content they stack,
   and a dialog that stacks what the page itself showed across is a worse copy of the same table. */
.tp-card {
  width: min(880px, 100%);
  max-height: 100%;
  overflow: auto;
  padding: 20px 22px 22px;
  border-radius: calc(var(--radius) + 4px);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
  cursor: default;
}
.tp-head { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 16px; }
.tp-head h2 { margin: 0; font-size: 17px; font-weight: 700; color: var(--text); }
/* The card's own headline: which episode this file belongs to, so the numbers cannot be read as the
   season's. It is the same string the card under the dialog shows, not a second spelling of it. */
.tp-title { margin: 4px 0 0; font-size: 13px; color: var(--text-dim); }
.tp-x {
  margin-left: auto;
  flex: none;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 0;
  background: var(--chip);
  color: var(--text-dim);
  cursor: pointer;
  transition: background var(--hov) var(--ease), color var(--hov) var(--ease);
}
.tp-x:hover { background: var(--chip-hi); color: var(--text); }
.tp-msg { margin: 0; padding: 30px 0; font-size: 13px; color: var(--text-dim); text-align: center; }
/* The ask is a second long, so the dialog opens on the shape of the answer rather than on a spinner:
   every block below is one the sheet really has. */
/* Measured against the sheet on two kinds of file: the strip is 834.4×50 wherever the episode
   has a source, the columns come in at 409.2 wide with a 16 gutter and, on every one of the 31 episodes
   sampled, 214.2 tall over 266.5, and the foot is a name that ellipsises beside a date pinned to the right
   edge. Those boxes are drawn here, so the rows do not move when the data arrives.
   The 轨道 band is the one block a placeholder cannot know about — 20/20 episodes of 罚罪 have no subtitles at
   all, 11/11 of the anime sampled do — and it is drawn anyway at the 86.7 its single-line form measured,
   because the alternative was a sheet that grows by a third of itself in front of the reader. */
.tp-load { display: flex; flex-direction: column; gap: 16px; }
.tp-load i { display: block; border-radius: var(--radius); background: var(--shimmer); background-size: var(--sk-tile) 100%; animation: sh 1.3s linear infinite; }
.tp-load .strip { height: 50px; }
.tp-load .cols { display: flex; gap: 16px; align-items: flex-start; }
.tp-load .cols i { flex: 1 1 0; }
.tp-load .video { height: 214.2px; }
.tp-load .audio { height: 266.5px; }
.tp-load .band { height: 86.7px; }
.tp-load .foot { display: flex; justify-content: space-between; gap: 18px; }
.tp-load .foot i { height: 20.1px; border-radius: 6px; }
.tp-load .name { flex: 1 1 auto; min-width: 0; }
.tp-load .date { flex: none; width: 186px; }
.techpop-enter-active,
.techpop-leave-active { transition: opacity 0.16s var(--ease); }
.techpop-enter-from,
.techpop-leave-to { opacity: 0; }
/* Only the card travels, 8px, and it travels in pixels: a dialog that scales on the way in reads as a
   different window opening rather than this page lifting a sheet over itself. */
.techpop-enter-active .tp-card,
.techpop-leave-active .tp-card { transition: transform 0.16s var(--ease-out); }
.techpop-enter-from .tp-card,
.techpop-leave-to .tp-card { transform: translate3d(0, 8px, 0); }

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

/* Neither side has anything for the season on screen: no files here, and no list from TMDB yet either.
   Printed where the band would have been, because a blank stretch of the page reads as a load that failed. */
.noband { font-size: 13px; color: var(--text-faint); }
/* The band's floor exists so the blocks under it never jump when the cards land. With no cards there is
   nothing to floor, and 370px of nothing under one line reads as a load that failed. */
.epi-row.solo { min-height: 0; }
.epi-row .noband { align-self: center; max-width: 62ch; }
/* A card for an episode this machine has no file for is the same plate with the same text and nothing to
   press. Only the triangle comes off, since it is the one mark on the card that promises a file. */
.epi.off { cursor: default; }
.epi.off .disc { display: none; }

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
.lb-stage {
  /* The centre is the foreground and the two beside it are only the promise that there is more. At 88% of the
     stage each side has 79 px to work with, so 46 of those go to the neighbour's art at 0.78 scale, the rest
     is the gap and the fade; the pitch sits inside one frame box so the neighbour hugs the shoulder. */
  --frame-w: 88%;
  --pitch: 92%;
  position: relative;
  overflow: hidden;
  touch-action: none;
}
.lb-stage.grab { cursor: grabbing; }
.lb-rail {
  position: absolute;
  inset: 0;
  --slide: 0.42s;
  /* Neighbours come in and out at the edges rather than being cut straight across there. Same soft
     edge the filmstrip already has, and it has to stay narrower than the sliver it softens. */
  mask-image: linear-gradient(90deg, transparent, #000 16px, #000 calc(100% - 16px), transparent);
}
.lb-fr {
  --sc: 0.78;
  --dim: 0.22;
  position: absolute;
  top: 0;
  left: calc((100% - var(--frame-w)) / 2);
  width: var(--frame-w);
  height: 100%;
  /* One custom property drives the whole move, so a step inserts nothing: the frames that are already on screen
     keep their layers and the shift is a plain transform on what is already composited. */
  transform: translate3d(calc((var(--k) - var(--cur)) * var(--pitch) + var(--drag)), 0, 0) scale(var(--sc));
  /* Dimming through opacity rather than a filter: the ground here is (8,8,12), so a side frame carries 78%
     of a near-black wash laid over the art, the depth a brightness() would give at no compositor cost. */
  opacity: var(--dim);
  background-position: center;
  background-size: contain;
  background-repeat: no-repeat;
  cursor: pointer;
  user-select: none;
  transition: transform var(--slide) var(--ease-out), opacity var(--slide) var(--ease);
}
.lb-fr.on { --sc: 1; --dim: 1; cursor: zoom-out; }
/* The cut class goes away after a forced reflow, so the frames land on their new offsets while the transition
   is still switched off and there is nothing left to interpolate. */
.lb-rail.cut .lb-fr { transition: none; }
.lb-fr img {
  display: block;
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
  /* On the centre's own shoulder rather than at the stage edge: the neighbour sliver is the only
     thing left there, and a 40px button parked on it would be the whole of the hint. */
.lb-edge.left { left: calc((100% - var(--frame-w)) / 2 + 12px); }
.lb-edge.right { right: calc((100% - var(--frame-w)) / 2 + 12px); }
.lb-edge:hover:not(:disabled) { opacity: 1; background: rgba(255, 255, 255, 0.22); }
.lb-edge:active:not(:disabled) { opacity: 1; background: rgba(255, 255, 255, 0.3); }
/* Clamped rather than wrapped, so the first and last still have an arrow that goes nowhere. It stays in place
   and only dims: an arrow that appeared and disappeared would shove the peek underneath it. */
.lb-edge:disabled { opacity: 0.12; cursor: default; }
.lb-foot { display: flex; flex-direction: column; align-items: center; gap: 10px; cursor: default; }
.lb-strip {
  display: flex;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  padding: 4px 2px;
  scrollbar-width: none;
  /* No snap on this rail. Proximity looks harmless, but Chrome resolves a scripted scroll that lands near a
     snap point onto that point instead: 240 px asked of a rail sitting at its snap position read back as 0,
     while the same write with the snap switched off landed on 240. The follow loop advances by a fraction of
     the gap each frame, so a snap here cancels the wheel one frame at a time, which is the 「滚不动、有时候会
     丢失」 the wheel was blamed for. Centering is a click's job, and the edge fade already says the rest is off
     the rail. */
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
