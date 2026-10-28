<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { hasContent, type LibraryItem, type TmdbCreditRow, type TmdbCredits, type TmdbEpisodeRow, type TmdbSeasonRow, type TmdbStills } from '../../shared/types';
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
import { pairedSeason, tmdbKind as kindOf, trustSeason, useScores } from '../lib/scores';
import { usePlayerStore } from '../stores/player';
import { useAppStore } from '../stores/app';
import { accountName, episodeHead, fmtDate, fmtMinutes, fmtRuntime, seenLabel, seasonTitle, watchedRatio } from '../lib/format';
import { PLAYABLE, PLAYABLE_PAGE, isStoppedRow, isUnfinishedRow, resumeTarget, seasonTarget } from '../lib/resume';
import { mergeGenres } from '../lib/genres';
import { createLoopRail, type LoopRail } from '../lib/looprail';
import { embyCached } from '../lib/embycache';
import { libraryWorks, useRelated, type WorkSeed } from '../lib/related';
import { episodeClicked, seedFor, seedItemFor, seedTypeFor, takeAutoplay } from '../lib/handoff';
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
/** Which season the rows now in `episodes` have been *answered* for — asked, rows or failure both count,
 *  unlike `episodeN` which only takes the rows. The season pairing reads it as "is the evidence still on its
 *  way": a verdict cannot be handed out before the files that decide it, and it must not be held back forever
 *  because one request died. */
const filesFor = ref(-1);
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
/* Whether TMDB's row for episode number N is *this* card's episode, and the one place the answer is read.
   The pairing verdict is the season's own files (see `tmdbSeason` below), and a refusal is not final: TMDB's
   row for that number is still fetched, because a season can be refused by a rule that cannot tell a
   mispairing from a show still airing — PSYREN 第 1 季's 3 files against TMDB's 13 is a partial download —
   so two sides that agree on when this one episode aired still get to dress the card. */
const seasonPaired = computed(() => !!tmdbSeason.value);
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
  if (!r || seasonPaired.value) return r;
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
/** The 播放资源 sheet, and the focus ring that has to stay inside it. `role="dialog" aria-modal="true"` is
 *  a claim about the page, not a mechanism: with no trap the Tab after the × button landed on the 分集 rail
 *  behind the backdrop, where the reader could keep walking with no ring visible anywhere on screen.
 *  The card itself is in the ring because it is what takes focus on open — a trap that skipped it would
 *  send the first Tab straight to the × and lose the fact that the dialog, not a control, was addressed. */
const popCard = (): HTMLElement | null => document.querySelector<HTMLElement>('.tech-pop .tp-card');
const POP_FOCUSABLE = 'a[href], button:not(:disabled), input, select, textarea, [tabindex]:not([tabindex="-1"])';
function trapPopTab(e: KeyboardEvent): void {
  const card = popCard();
  if (!card) return;
  const ring = [card, ...Array.from(card.querySelectorAll<HTMLElement>(POP_FOCUSABLE))];
  const at = ring.indexOf(document.activeElement as HTMLElement);
  e.preventDefault();
  if (at < 0) {
    ring[0].focus();
    return;
  }
  ring[(at + (e.shiftKey ? -1 : 1) + ring.length) % ring.length].focus();
}
function onViewerKey(e: KeyboardEvent): void {
  if (techPop.value) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeTech();
    } else if (e.key === 'Tab') {
      e.stopPropagation();
      trapPopTab(e);
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
/** The band behind the copy: TMDB's best-voted shot, with the server's own Backdrop as the stand-in for a
 *  page TMDB never answered. This page asked the server alone, so the same work wore two different films
 *  across the same band depending on which page the reader was on — measured over the 11 works on 收藏, all
 *  11 disagreed (玩具总动员5: a toy box here, a green alien on the work page). The work page has always read
 *  `backdrops[0]`, so this is the same rule, not a new picture, and the two bands now print the same file on
 *  11/11. No new request either: these are the paths the 剧照 strip further down already fetches. */
const heroArt = computed(() => (backdrops.value.length ? backdropUrl(backdrops.value[0]) : heroBackdrop.value));
/** What the plate paints, in the order the season decides it: TMDB's own poster for that season, then the
 *  server's season art, then TMDB's poster for the work, then the server's, for a page neither side dresses
 *  in its own picture. The card art this page was opened from sits behind all four: it paints the first
 *  frame so the plate is never empty, and the season's own picture takes it over as soon as that picture is
 *  known. Measured on
 *  Ted Lasso, handing the seed the top of this ladder instead left the plate on the series poster through
 *  chips 1, 2 and 3 while its date, 集数, rating and credit band all moved with the season. */
const tmdbPlate = computed(() => posterUrl(tmdbSeason.value?.poster));
/** TMDB's poster for the work itself, one rung under the season's own art rather than over it: a season that
 *  has a picture keeps it, and only a page with nothing to dress falls to this. A Movie is the case that had
 *  no rung at all, since there is no season level under a film, so this plate used to read straight through to
 *  the gateway's single Primary (measured on 玩具总动员5: card and plate two different pictures). Placing it
 *  above `heroPoster` also means a season neither side dresses wears TMDB's Chinese art, which is the picture
 *  the card that opened the page was already wearing. */
const tmdbWorkPlate = computed(() => posterUrl(scores.value.tmdb?.poster));
const plateSrc = computed(() => tmdbPlate.value || seasonArt.value || tmdbWorkPlate.value || heroPoster.value || seedFor(props.id));
/** Ranked title treatments for this item; TitleArt walks them and falls back to the name. */
const titleUrls = ref<string[]>([]);

/** The 在看 rows the lobby pulled, still in hand on this page. Two readers: the work-level pick that
 *  decides which season the page opens on, and the stop a Movie or Episode page names from its own row.
 *  A season's button does not read them — it reads that season's rows. */
const resumeRow = computed(() => app.rows.find(r => r.key === 'resume')?.items || []);
/** The rows of the season on screen, and only while they really are that season's: the band keeps its
 *  height across a switch, so the rows being left sit here for a beat under the new season's number. */
const seasonRows = computed<LibraryItem[]>(() => (episodeN.value === seasonN.value ? episodes.value : []));

/** The row this work is on, asked from the server when the lobby's 在看 window holds no row for it. That
 *  window is 22 shows (the lobby asks the store's row with no limit, while the 在看 page asks 200), so an entry
 *  ranked 23rd or lower is invisible here, and 收藏 or 搜索 can open a work older than all of them; without this
 *  the page answered with the furthest-started episode of the open season instead. Measured on the two works the
 *  window misses: their 200-row entries are 鱿鱼游戏 第 3 季 第 5 集 and 冰菓 第 0 季 第 1 集, while the page opened
 *  each on 第 1 集 of a season and its hero said so.
 *  The ask is `IsResumable: true`, not `Filters: IsResumable`: on this gateway the filter form answers with
 *  nothing at all for these works, because it keeps only rows that still carry an offset, and those are the rows
 *  the gateway has reset (measured over 4 works — the filter form returns 0 rows for 鱿鱼游戏 / 冰菓 / 金装律师 /
 *  牧神记 where the parameter form returns 12 in ~0.5s, its first row 3-5 / 0-1 / 1-8 / 1-104). The parameter form asks
 *  which files *can* be resumed, so its first row is the last episode opened, offset or not. */
const askedRow = ref<{ forId: string; item: LibraryItem } | null>(null);
let askedFor = '';
async function askWorkRow(seriesId: string): Promise<void> {
  if (!seriesId || askedFor === seriesId) return;
  askedFor = seriesId;
  const r = await window.echoemby.emby.items({
    ParentId: seriesId,
    Recursive: true,
    IncludeItemTypes: 'Episode',
    SortBy: 'DatePlayed',
    SortOrder: 'Descending',
    IsResumable: true,
    Limit: 12,
  });
  // The page may have moved to another work while this was out: that answer is about a title nobody is
  // reading, and storing it would put one work's stop over another's season list.
  if (askedFor !== seriesId) return;
  // A request that did not answer is not an answer, so the guard that keeps this work from asking twice
  // is handed back — a route blip would otherwise leave the page holding nothing, and the hero would fall
  // back to the season's furthest-started episode while still claiming it is where the viewer stopped.
  if (!r.ok) {
    askedFor = '';
    return;
  }
  // The first row that is really a stop, and failing that the first row the viewer has not finished. The list
  // can also name episodes watched to the end — this fork marks them Played with the position reset — and
  // those are not where the viewer continues; the same rule the 在看 shelf and the season's own button read.
  // The second tier is what the reset works need: 鱿鱼游戏 answers with 12 rows at pos 0, and the first one it
  // has not finished is 3-5, the episode the 在看 page lists it under. A head row watched to its end is dropped
  // rather than adopted, so a season that is finished still opens at its front.
  const rows = r.data || [];
  const stop = rows.find(isStoppedRow) || rows.find(isUnfinishedRow) || null;
  askedRow.value = stop ? { forId: seriesId, item: stop } : null;
}

/** The 在看 row this work's entry is about. `resumeTarget` answers with it whether or not the server kept
 *  an offset, which is the point: the shelf listed this episode as the thing to come back to. */
const shelfRowOf = (it: LibraryItem | null): LibraryItem | null =>
  (it && resumeTarget(it, resumeRow.value)?.item) || null;
const shelfRow = computed(() => shelfRowOf(work.value));

/** The episode the clicked card was drawn from, when the card was one episode and the page it opened is its
 *  work: a 搜索 list hands over 爱情公寓 第 3 集 while the destination is the same Series page the 在看 rail opens,
 *  and nothing on that page says which of its 20 cards the reader aimed at. Measured on a search row: the
 *  page opened on the newest stop instead (第 16 集), so the band slid four cards past the one under the pointer.
 *  A row watched to its end does not qualify: `stoppedAtMs` multiplies that row's 100% into its whole runtime,
 *  and the button would read 「继续播放 · 看到 41:00」 over an episode that has nothing left in it — the same line the work-scoped
 *  ask reads off its head row. */
const clickedRow = computed(() => {
  const it = episodeClicked(props.id);
  return it && isUnfinishedRow(it) ? it : null;
});

/** The row this page is about, in the order the reader meant it: the episode a clicked card was drawn from,
 *  else the one the 在看 shelf holds for this work, and only when the shelf holds none — its window is 22 shows
 *  — does the work-scoped ask answer for it.
 *  The shelf row wins whether or not it carries an offset: it is the row the viewer pressed, and it is folded by
 *  the same rule the ask imitates (a stop-row first per show, off [...resumePoints, ...datePlayed]). Measured over
 *  4 works, the ask cannot be trusted to outrank it — its list is not in recency order once the gateway has
 *  stopped returning dates: 善意的竞争 answers 1-4, 1-3 (both watched to the end), 1-1, then 1-2 at 60s, with the
 *  shelf's own 1-5 fifth and the furthest stop 1-7 (14:20) seventh, so the first row with a number named 第 2 集
 *  over the card that had just been pressed; 牧神记 answers 1-104 (watched) then 1-1 while the shelf names 1-105,
 *  the season's last card.
 *  Reading past the shelf for an offset used to be right: 火影忍者's shelf row was 第 222 集 at pos 0 while 第 224
 *  集 held 498s. That is closed at the source now (the fold prefers a stop-row), and the shelf's row for
 *  火影忍者 is 1-224 with its 8:18 — so an offset-less shelf row is no longer evidence of a stale row. */
const workRow = computed<LibraryItem | null>(() => {
  const aim = clickedRow.value;
  if (aim) return aim;
  const live = shelfRow.value;
  if (live) return live;
  const asked = askedRow.value;
  return asked && asked.forId === work.value?.id ? asked.item : null;
});
/** That row, when the season on screen holds it. Read off the settled season rows rather than every
 *  episode in hand: a switch keeps the outgoing rows for a beat under the new season's number. */
const rowHere = computed(() => {
  const it = workRow.value;
  return it && seasonRows.value.some(e => e.id === it.id) ? it : null;
});
/** The row this hero is about, as the shared button reads it. It names the row the entry is about whenever
 *  the season on screen holds it — the same episode 在看 names and the band opens on. Only a season the
 *  viewer never took that stop in falls back to the season's own answer (furthest started, else first):
 *  the button answers for the season the page is open on rather than for the work, so 第 2 季 says what
 *  第 2 季 holds. Measured on 摩登家庭, a work-level button named 「第 1 季 · 第 1 集 · 看到 18:26」 while
 *  the page was open on a 特别篇 this server holds nothing for, so the plate promised a file and the
 *  badge under it denied it. */
const resume = computed(() => {
  if (!isSeries.value && !isSeason.value) return resumeTarget(item.value, [], resumeRow.value, false);
  const it = rowHere.value;
  return it ? resumeTarget(it, [it], [it], true) : seasonTarget(seasonRows.value);
});
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
const techPop = ref<{ id: string; title: string; item: LibraryItem | null; dead: 'empty' | 'failed' | null; note: string } | null>(null);
/** The element focus returns to when the sheet closes. A plain binding rather than a ref: it is a node, it
 *  is never rendered, and making it reactive would only ask Vue to walk a subtree it does not own. */
let techTrigger: HTMLElement | null = null;
/* The version a 播放 of this item takes is held once, in the player controller, and this map is only this
   window's copy of it for drawing. The copy is needed because the controller answers synchronously on the
   main side while the card paints on this side: the strip has to be pressed before the ask returns.
   Keyed by item id because the popup's card and the 选集 row it was opened from name the same episode. */
const wantedSource = ref<Record<string, string>>({});
const onTechPick = (itemId: string, sourceId: string): void => {
  const prev = wantedSource.value[itemId];
  wantedSource.value[itemId] = sourceId;
  // Write through, rather than handing the pick to `play` as an argument: a switch pressed inside the
  // player writes the same map in the controller, and two memories ranked against each other is how a
  // newer pick on the 播放源 card used to lose to an older click here. The ask is answered, not fired and
  // forgotten, because a pick about the file already playing now switches that file: if the switch fails
  // the strip has to go back, or the card keeps pressing a version nothing loaded.
  void window.echoemby.player.chooseSource(itemId, sourceId).then(r => {
    if (r.ok) return;
    if (prev) wantedSource.value[itemId] = prev;
    else delete wantedSource.value[itemId];
  });
};
/** Pull the controller's answer for one item down before a card paints it. An empty means nobody has
 *  chosen, which leaves this window's copy alone — the card then falls on the first playable row, which is
 *  where the negotiation lands too. */
async function syncWanted(id: string): Promise<void> {
  if (!id) return;
  const s = await window.echoemby.player.lastSource(id);
  if (s) wantedSource.value[id] = s;
}
/** The card has to open on the version the page would play, not on the first strip: the popup is `v-if`, so
 *  it remounts every time it opens, and a locally-held `picked = 0` there showed 第一格 pressed while 播放
 *  still loaded the second. */
const wantedFor = (it: LibraryItem | null): string | undefined => (it ? wantedSource.value[it.id] : undefined);
watch(techInline, it => void syncWanted(it?.id || ''), { immediate: true });
/* A version switched on the player's own 播放源 card must move this page's mark too. The session event is
   already sent to every window, so this is the library window reading the same publish the player reads;
   without it a DetailView that stayed mounted behind the player kept pressing the older row. */
const offPlayerSession = window.echoemby.player.onSession(s => {
  if (s) wantedSource.value[s.itemId] = s.sourceId;
});
onBeforeUnmount(() => offPlayerSession());
/* Three plates are a guess, because the ask has not answered yet: whether the 字幕 band appears at all, and how
   tall the version strip, the 音频 card and that band came in. Measured 2026-10-26: 罚罪's web rips answer with
   no band at all (10 of the 31 episodes sampled), while 小林家的龙女仆 answers 10 consecutive episodes with one
   and the same sheet — 44 strip, 138.1 audio, 88.4 band — because one season is one release. So the page keeps
   the shape the last answer came in and paints the next placeholder like it. The season's own id is the key,
   because a page walks its seasons and the previous season's shape must not silence the next one's band: a
   guess left over from 罚罪 must not silence it on an anime, and an unknown season keeps drawing it — which is
   the answer two seasons in three.
   With nothing seen yet the plates fall back to the smallest true answer (361 of 468 files carry one audio
   track; every extra track adds 27.1), and only that floor is allowed to move the card: the dialog is centred,
   so a placeholder drawn *taller* than the file would shrink it under the reader's eyes.
   Since 2026-10-26 the 音频 card joins the guess: it used to fold into the band whenever a file had a second
   track, and now it lists every track in its own card, which a file without audio streams is the only way to
   empty. */
const sheetSeen = ref<{ key: string; strip: number; aud: number; wide: number } | null>(null);
const plate = computed(() => {
  const seen = sheetSeen.value;
  const same = seen && seen.key === (seasonAt.value?.season?.id || '') ? seen : null;
  const px = (n?: number) => (n ? { height: `${n}px` } : undefined);
  return { band: same ? same.wide > 0 : true, strip: px(same?.strip), aud: px(same?.aud), wide: px(same?.wide) };
});

async function openTech(r: BandRow, ev?: MouseEvent): Promise<void> {
  // The dot that opened the sheet, kept because focus has to go back to it: `currentTarget` is null by the
  // time the await below returns, so it is read here and not in `closeTech`.
  techTrigger = (ev?.currentTarget as HTMLElement | null) || (document.activeElement as HTMLElement | null);
  techPop.value = { id: r.id, title: r.title, item: null, dead: null, note: '' };
  // Focus moves as soon as the dialog exists rather than when the item answers. The ask takes 0.77s on
  // OkEmby and 0.79s on nyamedia (measured 2026-10-22), which is long enough for a reader who tabs straight
  // after opening to have walked into the rail behind the backdrop — `aria-modal` says the page behind is
  // inert, and until this moved it was a claim with nothing enforcing it.
  await nextTick();
  popCard()?.focus();
  const [res] = await Promise.all([embyCached('item', r.id, () => window.echoemby.emby.item(r.id)), syncWanted(r.id)]);
  const pop = techPop.value;
  // Closed, or replaced by another card while this was out: that answer belongs to a dialog nobody is
  // reading, and writing it here would paint episode 7's numbers under episode 12's name.
  if (!pop || pop.id !== r.id) return;
  const row = res.ok ? res.data : null;
  // Two empties, and they are not one sentence. A row the server lists but cannot probe — the `.strm` and
  // `.iso` versions with no stream behind them, 133 of 23,027 measured — is a fact about the file, and 播放
  // would refuse it the same way, so the card draws the same answer here that the negotiation gives.
  // A request that did not answer is a fact about this moment: the sheet says what the ask said, and
  // opening it again is the fix.
  const usable = (row?.sources || []).filter(hasContent);
  pop.item = row && usable.length ? row : null;
  pop.dead = pop.item ? null : res.ok ? 'empty' : 'failed';
  pop.note = res.ok ? '' : res.error || '没有问到这一集的资源';
  const src = usable[0];
  if (src) {
    await nextTick();
    const h = (sel: string): number => {
      const el = document.querySelector(`.tech-pop ${sel}`);
      return el ? Math.round(el.getBoundingClientRect().height * 10) / 10 : 0;
    };
    sheetSeen.value = {
      key: seasonAt.value?.season?.id || '',
      strip: h('.src'),
      aud: h('.tcard.aud'),
      wide: h('.tcard.wide'),
    };
  }
}

function closeTech(): void {
  techPop.value = null;
  // Back to the dot that opened it, which is where the reader's hands were. Without this the sheet closed
  // onto <body> and the next Tab started over at the top of the page, so leaving the dialog cost the place
  // in the 分集 rail it had been opened from.
  techTrigger?.focus();
  techTrigger = null;
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
/** The card the episode row should open on. -1 for a movie, for a finished show and for a season the viewer
 *  never started; a season the stop is not in falls back to that season's own 继续 target. */
const resumeIndex = computed(() => {
  const id = resume.value?.item.id;
  return id ? episodes.value.findIndex(e => e.id === id) : -1;
});
/* One glide per season, keyed instead of unconditional: the cards re-paint again when TMDB's stills land a
   beat after the row, and a watcher that ran on every recompute would pull the reader back onto the stopped
   episode while they were already looking for the one past it. Index 0 is where the row opens anyway.
   The band is a source because a season switch unmounts it for the beat where `episodes` is empty: a key
   spent on a band that is not there is the last glide that season gets. The key needs no dropping, because
   the page is mounted for one title — 凡人修仙传's series page and its 第 1 季 page used to be one object
   over one stopped card, and the season page mounted to find the key already spent and held scrollLeft 0
   while the card sat 56206px away. */
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
  // Only a stop is carried to the middle. Card 0 is where the band already opens, and centring it would
  // pull the season's own tail clones in front of it and leave 第 1 集 off the reader's left.
  if (epiBand.value?.focusCard(i, i > 0)) focusedOn = key;
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
const epPlayed = (e: LibraryItem): number => Math.round(watchedRatio(e.userData, e.runTimeTicks) * 100);

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

/* TMDB and this server do not always count the same season. Once a page holds the season's own files the
   pairing is judged by where those files sit (`pairedSeason`); the count test in `trustSeason` is what is left
   for the surfaces that hold a count and nothing else — this page's picker rows for the seasons nobody has
   opened, whose files are one request per season away, and the player's season chips, which have no files at
   all until the reader presses one. */
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
/** TMDB's own row for the season on screen, straight out of the work-level table and before any pairing test:
 *  the test needs the count TMDB itself bills, which a merged list would have replaced with the server's. */
const tmdbRow = computed(() => {
  const n = seasonNumber.value;
  return n == null ? null : scores.value.tmdb?.seasons?.find(x => x.n === n) || null;
});
/** This season's files in the shape the pairing reads: `undefined` when this machine holds no row for the
 *  season (nothing to pair, so nothing to wait for), `null` while its file list is still out, and the numbers
 *  once it has answered — an empty array included, because a season whose files carry no `indexNumber` at all
 *  (22 of the 389 measured pairs) is an answer, not a wait, and falls back to the count test. */
const seasonFiles = computed<number[] | null | undefined>(() => {
  if (!seasonRow.value) return undefined;
  if (filesFor.value !== seasonN.value) return null;
  if (episodeN.value !== seasonN.value) return [];
  return episodes.value.map(e => e.indexNumber).filter((x): x is number => typeof x === 'number');
});
/** The season on screen as its own files bill it. A refusal costs the hero its date, its art, its rating, its
 *  paragraph and its credits, and costs every card in the band its outside picture — and a season nobody has
 *  opened yet keeps the count test, since its files are a request away and a caption cannot wait on them. */
const tmdbSeason = computed(() =>
  pairedSeason({ tmdb: tmdbRow.value, files: seasonFiles.value, count: seasonRow.value?.childCount }),
);

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

/** 「2021-04-09 · 16 集 · 17小时18分钟」 for the season on screen. Until that season is known the line says
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

/** The series' own heart says nothing about a favourite another client filed on one of its episodes.
 *  The collection page folds those into the work, so the page that owns the heart reads the same union
 *  or a folded card would open onto an empty heart. */
const epFavIds = ref<string[]>([]);
/** Which work the ids were asked for, so the watcher's second and third run for the same title — the type
 *  landing after the id, the server's copy landing after the row's — does not ask twice. */
let epFavFor = '';

async function askEpisodeFavs(seriesId: string): Promise<{ ok: boolean; ids: string[] }> {
  if (!seriesId) return { ok: true, ids: [] };
  const r = await window.echoemby.emby.items({
    Recursive: true,
    ParentId: seriesId,
    IncludeItemTypes: 'Episode',
    Filters: 'IsFavorite',
    Limit: 1000,
  });
  return { ok: r.ok, ids: r.ok ? (r.data || []).map(x => x.id) : [] };
}

const fav = computed(
  () => !!work.value?.userData?.isFavorite || (work.value?.type === 'Series' && epFavIds.value.length > 0),
);

watch(
  () => [work.value?.id, work.value?.type] as const,
  async ([id, type]) => {
    if (!id || type !== 'Series') {
      epFavIds.value = [];
      epFavFor = '';
      return;
    }
    if (epFavFor === id) return;
    epFavFor = id;
    epFavIds.value = [];
    // The series' own heart is enough; only a work that is not starred needs the episode lookup.
    if (work.value?.userData?.isFavorite) return;
    const r = await askEpisodeFavs(id);
    if (work.value?.id !== id) return;
    if (r.ok) epFavIds.value = r.ids;
  },
  { immediate: true },
);

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
  // Answered either way, and that is what lets the pairing be judged: a failure is not a wait, and a caption
  // that waited on a request the gateway never answers would withhold its marks for the rest of the visit.
  if (seasonN.value === n) filesFor.value = n;
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
  const tmdb = String(series.providers?.tmdb || '');
  const kind = kindOf(series);
  if (!kind || !/^\d{1,8}$/.test(tmdb)) {
    seasonsAsked.value = true;
    return;
  }
  const rows = await libraryWorks(kind, tmdb, series.name);
  // `null` is a server that has not answered, not one that holds nothing: the list keeps its silence about
  // seasons nobody has been asked for rather than label them absent.
  if (rows === null) return;
  const groups = await Promise.all(
    rows
      .filter(x => x.id !== series.id)
      .map(async row => ({ id: row.id, s: await embyCached('seasons', row.id, () => window.echoemby.emby.seasons(row.id)) })),
  );
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
  const r = await embyCached('item', seriesId, () => window.echoemby.emby.item(seriesId));
  const it = r.ok ? r.data || null : null;
  if (it) {
    seriesItem.value = it;
    /* A season row often carries no art at all (measured: 模范出租车's seasons 1 and 2 have neither a
       Primary nor a Backdrop tag), which left the hero a flat gradient. TMDB has no season-wide shot
       either, so the work's own backdrop is the stand-in the ladder calls for. */
    if (!item.value?.backdropImageTag && !item.value?.primaryImageTag && it.backdropImageTag)
      void app.backdropUrl({ id: it.id, backdropImageTag: it.backdropImageTag }, 1600).then(u => (heroBackdrop.value = u));
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
/** The row's name comes from the verdict that page has evidence for: the season on screen is judged by its
 *  own files, exactly as the hero above it is, so the trigger and the caption cannot wear two different
 *  season names; the rows below it are judged by the counts, which is all a season nobody has opened gives. */
const seasonLabel = (s: ServerSeason): string =>
  seasonTitle(
    s.n,
    s.season?.name,
    (s.n === seasonNumber.value ? tmdbSeason.value : trustRow(s.n, s.season?.childCount))?.name,
  );

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
 *  page it opened is the only place that knows which episode to start. Held as an id so the note can only be
 *  spent by the page it was made for, and spent once. */
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
  if (it.primaryImageTag) void app.imageUrl({ id: it.id, primaryImageTag: it.primaryImageTag }, 300).then(u => (heroPoster.value = u));
  if (it.backdropImageTag)
    void app.backdropUrl({ id: it.id, backdropImageTag: it.backdropImageTag }, 1600).then(u => (heroBackdrop.value = u));
  else if (it.primaryImageTag) {
    // No wide art on the server: reuse the poster as a soft backdrop rather than a flat gradient.
    void app.imageUrl({ id: it.id, primaryImageTag: it.primaryImageTag }, 1000).then(u => (heroBackdrop.value = u));
  }

  if (painted === id) return;
  painted = id;
  // A Season row carries no external id and no Logo, so every ask below would be made against nothing.
  // On those pages they come with the series, from loadChildren.
  if (it.type === 'Season') return;
  askWork(it);
}

/** The title's own two asks: its ranked treatments and its backdrop strip. None of
 *  them has a season-level answer, so a Season page runs them for the series above it. */
function askWork(series: LibraryItem): void {
  void app.logoCandidates(series).then(u => (titleUrls.value = u));
  const kind = kindOf(series);
  const tmdbId = String(series.providers?.tmdb || '');
  if (!kind || !/^\d{1,8}$/.test(tmdbId)) return;
  void window.echoemby.meta.tmdbImages({ kind, tmdbId }).then(x => (backdrops.value = x.ok ? x.data || [] : []));
}

/** The season rail, started from whichever half of the pair painted the page — which is what takes the
 *  seasons query out of the item query's critical path (measured: +350ms waiting for nothing). */
async function loadChildren(it: LibraryItem): Promise<void> {
  if (loaded === it.id) return;
  loaded = it.id;
  if (it.type === 'Series') {
    // The 在看 row is the only source that says which episode was played most recently; a window restored
    // on a shelf other than the lobby holds no rows yet, and the season below opens on that stop.
    const [s] = await Promise.all([
      embyCached('seasons', it.id, () => window.echoemby.emby.seasons(it.id)),
      app.ensureResumeRow(),
    ]);
    serverSeasons.value = (s.ok ? s.data || [] : []).map(season => ({ seriesId: it.id, season }));
    void askSiblings(it);
    /* Open on the season the viewer stopped in, not on whichever row the server listed first: 爱情公寓 was left
       at 第 2 季 第 3 集 while the page showed 第 1 季's cards, so the episode they meant to press sat behind a
       tab. The 在看 row is the source whenever the lobby's 22-row window holds this show; only when it
       holds nothing is the server asked for the row this work is on, which costs 0.3-0.5s and no more than one
       ask per page. A show nobody has started falls back to the first season with episodes, exactly as before. */
    if (!shelfRowOf(it) && !clickedRow.value) await askWorkRow(it.id);
    const stop = workRow.value;
    const home =
      (stop && serverSeasons.value.find(x => x.season.id === stop.seasonId)) ||
      (stop && stop.parentIndexNumber != null && serverSeasons.value.find(x => x.season.indexNumber === stop.parentIndexNumber)) ||
      undefined;
    const first = home?.season.childCount ? home : serverSeasons.value.find(x => x.season.childCount) || serverSeasons.value[0];
    if (first) await loadSeason(first.season.indexNumber ?? 0);
  } else if (it.type === 'Season') {
    /* A page opened on one season is still a page about a series: its scores, its logo and its season
       tabs all belong one level up, and the switcher cannot be drawn from a list nobody asked for. */
    const [series] = await Promise.all([loadSeries(it.parentId || ''), app.ensureResumeRow()]);
    if (series) {
      askWork(series);
      // The row this work is on rides beside the season list: the band and the hero both read it, and asking
      // after the rows landed would re-glide the band from the season's own target onto that row.
      const [s] = await Promise.all([
        embyCached('seasons', series.id, () => window.echoemby.emby.seasons(series.id)),
        shelfRowOf(series) || clickedRow.value ? Promise.resolve() : askWorkRow(series.id),
      ]);
      serverSeasons.value = (s.ok ? s.data || [] : []).map(season => ({ seriesId: series.id, season }));
      void askSiblings(series);
    }
    await loadSeason(it.indexNumber ?? 0);
  }
}

/* The one load this page ever does. App.vue keys the page component on the path, so this instance is bound
   to one id for its whole life and nothing here has to be cleared for a next title: the season state, the
   band's focus key, the scroll offset and the outgoing hero all go with the element. The block of resets
   that used to sit in `paint` was measured into existence — walking 咒术回战 → 007 left 「2023-07-06 ·
   59 集 · 24小时6分」 printed under a movie that has neither — and a rebuild cannot carry that over.
   The page starts from the row the clicked card handed over, which every 相似卡 and every list card hands
   over, so a sibling switch paints its first frame from it exactly as a cold arrival does. */
async function loadPage(): Promise<void> {
  const id = props.id;
  autoplayFor = takeAutoplay(id) ? id : '';
  // The row the card was drawn from is already this title, so the hero paints from it instead of
  // waiting out a round trip measured at 493ms — and 2.0s when the gateway is having a slow minute.
  const row = seedItemFor(id);
  if (row) {
    paint(row);
    void loadChildren(row);
  }
  const r = await embyCached('item', id, () => window.echoemby.emby.item(id));
  if (!r.ok || !r.data) {
    // A page the row already painted is not a failed page: the title is on screen, only the
    // detail-only blocks stay away. The error line is for when nothing could be shown at all.
    if (!item.value) error.value = r.error || '打不开这一项';
    return;
  }
  paint(r.data);
  void loadChildren(r.data);
}
void loadPage();

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
   arrives — and only once this page has actually painted, so the note is played against the title it was
   made for rather than against a hero still on its way. */
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
  const seriesId = it.type === 'Series' ? it.id : '';
  const was = fav.value;
  const wasEps = epFavIds.value;
  const on = !was;
  favBusy.value = true;
  // The press answers for itself: the write-back only lands when the server has filed it, and that
  // round trip measured 300-600ms on this gateway — long enough for the heart to look untouched. The
  // union that lit the heart has to come down with it, or the optimistic press would leave it on.
  it.userData = { ...it.userData, isFavorite: on };
  if (!on) epFavIds.value = [];
  try {
    if (on) {
      if (!(await app.setFavorite(it.id, true))) it.userData = { ...it.userData, isFavorite: false };
      return;
    }
    // 收藏 folds a series' episode favourites into the work, so turning the work off has to clear them
    // too; writing only the series would leave the card on the collection page. The lookup comes first
    // because a failed one cannot tell fan-out what to remove.
    const eps = await askEpisodeFavs(seriesId);
    if (!eps.ok) {
      if (work.value?.id === it.id) epFavIds.value = wasEps;
      it.userData = { ...it.userData, isFavorite: was };
      return;
    }
    const results = await Promise.all([
      app.setFavorite(it.id, false),
      ...eps.ids.map(id => app.setFavorite(id, false)),
    ]);
    if (results.every(Boolean)) return;
    // Some writes landed and some did not; the server is the only one that knows which, so the heart and
    // the episode list are read back rather than guessed from a partially applied toggle.
    const [again, own] = await Promise.all([askEpisodeFavs(seriesId), window.echoemby.emby.item(it.id)]);
    if (work.value?.id === it.id) {
      // A failed read-back keeps the attempted ids on the heart instead of claiming it dark: a favourite
      // that remains server-side must stay pressable so the work can be turned off again.
      epFavIds.value = again.ok ? again.ids : wasEps;
      it.userData = { ...it.userData, isFavorite: own.ok ? !!own.data?.userData?.isFavorite : was };
    }
  } finally {
    favBusy.value = false;
  }
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
            <img v-reveal v-if="heroArt" :key="heroArt" :src="heroArt" alt="" decoding="async" />
          </Transition>
        </div>
        <div class="wash"></div>
        <div
          class="hero-in"
          :style="{ opacity: Math.max(0, 1 - scroll / 260), transform: `translate3d(0, ${Math.round(scroll * 0.4)}px, 0)` }"
        >
          <div class="copy">
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
      <div class="flow">
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
                <div v-if="r.played > 0" class="frame-prog"><i :style="{ width: r.played + '%' }"></i></div>
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
            <button v-if="r.id" type="button" class="res" :aria-label="`播放资源：${r.title}`" @click="openTech(r, $event)"><i></i><i></i><i></i></button>
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
          <TechCard :item="techInline" :wanted="wantedFor(techInline)" @pick="onTechPick" />
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
          <section class="tp-card" tabindex="-1">
            <header class="tp-head">
              <div>
                <h2>播放资源</h2>
                <p class="tp-title">{{ techPop.title }}</p>
              </div>
              <button type="button" class="tp-x" aria-label="关闭" @click="closeTech">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" /></svg>
              </button>
            </header>
            <TechCard v-if="techPop.item" :item="techPop.item" :wanted="wantedFor(techPop.item)" @pick="onTechPick" />
            <p v-else-if="techPop.dead === 'empty'" class="tp-msg">这台服务器在这一集没有可播的文件。</p>
            <p v-else-if="techPop.dead === 'failed'" class="tp-msg">{{ techPop.note }}</p>
            <div v-else class="tp-load" aria-hidden="true">
              <i class="strip" :style="plate.strip"></i>
              <div class="cols"><i class="video"></i><i class="audio" :style="plate.aud"></i></div>
              <i v-if="plate.band" class="band" :style="plate.wide"></i>
              <div class="foot"><i class="date"></i></div>
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
   had to clear the back disc. It is the title line of the row it decides now, so it rides the page like
   everything else under the hero. */
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
   under it - the two used to sit so far apart they read as two different episodes. It sits above the
   `.frame-prog` pill base.css draws. */
.ethumb .echip {
  position: absolute;
  left: 10px;
  bottom: 22px;
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
/* The sheet's one control of its own, and the first stop of a Tab that starts where the dialog put it. It
   had no ring at all, so a keyboard reader who opened this sheet with Enter had no way to see that focus
   had moved — the audit measured exactly that: focus stayed on the dot behind the backdrop. */
.tp-x:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
/* The card is where focus lands on open, so that the dialog and not the page behind it is what a screen
   reader addresses. It is not a control and wears no ring; the first Tab puts one on the × or on a version
   strip, which is where a ring says something. */
.tp-card:focus { outline: none; }
.tp-msg { margin: 0; padding: 30px 0; font-size: 13px; color: var(--text-dim); text-align: center; }
/* The ask is half a second (measured 2026-10-26: 443-574ms for three episodes of 爱的迫降 opened with a cold
   cache), so the dialog opens on the shape of the answer rather than on a spinner: every block below is one the
   sheet really has. Measured against that sheet at 1360: the strip is 834.7×44 wherever the episode has a
   source — one line, because a lone version has nothing to compare itself against — the two columns come in at
   216 wide over 213.9 beside 602.7 over 83.2 for one audio track and 138.1 for three, the 字幕 card is 88.4 at
   its one label line, and the foot is a date pinned to the right edge at 187.5×20.1.
   Which of those heights the placeholder paints, and what stays a guess, is written at `sheetSeen` above. */
.tp-load { display: flex; flex-direction: column; gap: 16px; }
.tp-load i { display: block; border-radius: var(--radius); background: var(--shimmer); background-size: var(--sk-tile) 100%; animation: sh 1.3s linear infinite; }
.tp-load .strip { height: 44px; }
.tp-load .cols { display: flex; gap: 16px; align-items: flex-start; }
.tp-load .cols .video { flex: 0 0 216px; height: 213.9px; }
.tp-load .cols .audio { flex: 1 1 380px; height: 83.2px; }
.tp-load .band { height: 88.4px; }
.tp-load .foot { display: flex; justify-content: flex-end; gap: 18px; }
.tp-load .foot i { height: 20.1px; border-radius: 6px; }
.tp-load .date { flex: none; width: 187.5px; }
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
/* Two frames of one band, crossing: the old photo lifts past the lens and fades while the new one comes up
   to meet it. Both are `position: absolute; inset: 0` in `.stage`, so they overlap by construction — and
   this is the one place a crossfade is the right answer rather than doubled text, because the two frames
   are the same shape in the same place: the plate the clicked card handed over, then the server's own photo
   under it, and the same pair again whenever a season chip changes which season is being dressed. */
.heroart-enter-active,
.heroart-leave-active {
  transition: opacity var(--arrive-dur) var(--ease), transform var(--arrive-dur) var(--ease);
}
.heroart-enter-from {
  opacity: 0;
  transform: scale(0.97);
}
/* `img` and the element tag are load-bearing, not decoration: the band's frame also carries v-reveal, whose
   global `.rv.on` rule (base.css) pins opacity to 1 at the same specificity a bare scoped class reaches, and
   the loser is the frame that is supposed to leave. Measured 2026-10-25 with the TMDB-first band, which makes
   this hand-off fire on every first load: the outgoing server photo held
   at opacity 1 and its node was never unmounted (still two frames at +14s). */
.stage img.heroart-leave-to {
  opacity: 0;
  transform: scale(1.03);
}
/* Blocks are placed as the page settles, one after another. They mount once per title, because the page is
   built for one title, so this entrance plays once per 详情 opened — including the one a 相似卡 opens. */
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
