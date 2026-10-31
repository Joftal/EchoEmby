<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { X } from 'lucide-vue-next';
import { usePlayerStore } from '../../stores/player';
import { useAppStore } from '../../stores/app';
import { episodeName, seasonTitle } from '../../lib/format';
import { trustSeason } from '../../lib/scores';
import { embyCached } from '../../lib/embycache';
import { createLoopRail, type LoopRail } from '../../lib/looprail';
import { vReveal } from '../../lib/reveal';
import type { LibraryItem, TmdbSeasonRow } from '../../../shared/types';
import { episodeSlot } from '../../../shared/episode-slot';

const player = usePlayerStore();
const app = useAppStore();

const seriesId = computed(() => player.session?.seriesId || '');
const seasonId = computed(() => player.session?.seasonId || '');

const seasons = ref<LibraryItem[]>([]);
const episodes = ref<LibraryItem[]>([]);
const active = ref('');
/* The cell that is the episode on screen. The session's id answers it whenever the row the shelf handed the
   player and the row this season lists are the same row; when the server holds two rows for one episode
   they are not, and the position number settles it — see `episodeSlot`.
   The season is compared by its number, not by id, because the two can name different rows for one season:
   measured 2026-10-28, 骗中播 第 1 季 is `72423` to `/Shows/319444/Seasons` and `319665` to the item the
   shelf opened, and both list the same ten episodes (72430, 72433, 72436 …, IndexNumber 1..10). Gating on
   the id therefore refused the fallback on the very season it was meant for, and the strip stayed unmarked
   while the 上一集/下一集 buttons next to it worked. */
const currentCell = computed(() => {
  const s = player.session;
  if (!s) return '';
  const shown = seasons.value.find(x => x.id === active.value)?.indexNumber;
  const sameSeason = s.seasonNumber != null && s.seasonNumber === shown;
  const i = episodeSlot(episodes.value, { id: s.itemId, indexNumber: s.indexNumber }, sameSeason);
  return i < 0 ? '' : episodes.value[i].id;
});
const loading = ref(false);
const art = ref<Record<string, string[]>>({});
const artDead = ref<Record<string, true>>({});
/* TMDB's title for each episode, off the same per-season reply the frames come from. The chips above the
   strip already name the season, so this only ever adds what the episode is called — and it is what puts a
   Chinese 集名 on a row the server filed as 「ゆるキャン△ - S01E06」. */
const names = ref<Record<string, string>>({});
const strip = ref<HTMLElement | null>(null);
/** The strip is behind 载入中…, so it comes and goes with the fetch and the loop is built with it. */
let rail: LoopRail | null = null;

watch(strip, el => {
  rail?.destroy();
  rail = el ? createLoopRail(el) : null;
});

/** The panel opens on the season being played, so the list never starts on 第 1 季 while 第 3 季 is on screen. */
async function loadSeasons(): Promise<void> {
  if (!seriesId.value || seasons.value.length) return;
  const r = await embyCached('seasons', seriesId.value, () => window.echoemby.emby.seasons(seriesId.value));
  if (!r.ok) return;
  seasons.value = r.data || [];
  active.value = seasonId.value && seasons.value.some(s => s.id === seasonId.value) ? seasonId.value : seasons.value[0]?.id || '';
  void askTmdbNames();
}

/* Several of this library's seasons are filed under nothing but 「第 1 季」 while TMDB carries the name
   somebody actually gave them: 鬼灭's server rows say only the position, where TMDB has 「立志篇」. The pages
   judge that pairing by where a season's files land (`pairedSeason`), and this list cannot: naming these chips
   by episode numbers would cost one file request per season every time the player opens, for a caption on a
   button. So it keeps the count test, and stays a control rather than a claim — naming 季 1 after a season
   that is 800 Meters' 3 would put a lie on the button that switches what plays.
   What the two rules cost here is measured over the 389 season pairs this library and TMDB both name: the
   verdicts split on 51 of them, and only 12 of those 51 are pairs where TMDB gives the season a name beyond
   its number. 11 of those 12 print the same words on both surfaces anyway, because this server names those
   seasons itself (「特别篇」, 「Specials」, 石纪元's 「科学与未来」). The one that differs is 神墓 第 2 季: the
   page reads 「第 2 季 · 学城风云」 and this chip reads 「第 2 季」 — 16 files against TMDB's 27 is the pairing
   the files admit (its first date is TMDB's own for that season) and the counts refuse. So a chip here
   can be plainer than the season name on the page it came from, and never wronger.
   One ask for the whole series, keyed to it, so a session that moves to another show cannot name these
   chips from the last one's table. */
const tmdbSeasons = ref<TmdbSeasonRow[]>([]);
let tmdbAskedFor = '';
async function askTmdbNames(): Promise<void> {
  const sid = seriesId.value;
  if (!sid || tmdbAskedFor === sid) return;
  tmdbAskedFor = sid;
  tmdbSeasons.value = [];
  const it = await embyCached('item', sid, () => window.echoemby.emby.item(sid));
  const id = it.ok ? String(it.data?.providers?.tmdb || '') : '';
  if (!/^\d{1,8}$/.test(id)) return;
  const m = await window.echoemby.meta.tmdb({ kind: 'tv', tmdbId: id });
  if (m.ok && m.data && tmdbAskedFor === sid) tmdbSeasons.value = m.data.seasons || [];
}

const chipLabel = (s: LibraryItem): string =>
  seasonTitle(s.indexNumber, s.name, trustSeason(tmdbSeasons.value, s.indexNumber, s.childCount)?.name);

/* The season the episode on screen belongs to, which is not always the season being browsed: the chips are
   tabs, and 「the one that is playing」 is a fact about the session rather than about the click. The strip
   already marks its own cell, so this only has to answer for the row of chips above it. */
const playingSeason = computed<number | null>(() => player.session?.seasonNumber ?? null);

async function loadEpisodes(sid: string): Promise<void> {
  if (!seriesId.value || !sid) return;
  active.value = sid;
  const r = await embyCached('episodes', { seriesId: seriesId.value, seasonId: sid }, () =>
    window.echoemby.emby.episodes({ seriesId: seriesId.value, seasonId: sid }),
  );
  if (r.ok) episodes.value = r.data || [];
  for (const e of episodes.value) {
    if (art.value[e.id] === undefined) void app.itemArt(e, 320, true).then(urls => (art.value[e.id] = urls));
    if (names.value[e.id] === undefined) void app.episodeTitle(e).then(n => (names.value[e.id] = n));
  }
  await centerOnPlaying();
}

/** The frame this cell shows: the best picture the browser has not already watched fail. */
const artOf = (ep: LibraryItem): string => (art.value[ep.id] || []).find(u => !artDead.value[u]) || '';

/* The gateway mints a URL for a tag it cannot always render — measured: an episode's own Primary answers 500
   on this server — and behind that card sit TMDB's still of the episode and the series backdrop. A picture
   that will not decode therefore steps down one rung, and the number is only what is left when the ladder
   has run out. */
function onArtFail(ep: LibraryItem): void {
  const cur = artOf(ep);
  if (!cur) return;
  artDead.value = { ...artDead.value, [cur]: true };
}

/** A hundred episodes that open on 第 1 集 while 第 104 集 is on screen ask the user to hunt for the cell
 *  they already want, so the strip opens where the playhead is. The scroller is moved by hand:
 *  scrollIntoView also scrolls every ancestor, which dragged the whole overlay up.
 *
 *  It has to run once the strip is on screen, which on first open is not when the fetch lands - the list
 *  is behind 载入中…, so the element this was measured against did not exist yet and the strip quietly
 *  stayed at 第 1 集. Callers run it after the loading flag is cleared. */
async function centerOnPlaying(): Promise<void> {
  await nextTick();
  // Among the strip's own cells: a looping strip keeps copies of its first and last episodes at either
  // end, and the one wearing 「on」 has to be the real row, not the picture of it.
  const cells = rail ? rail.originals() : Array.from(strip.value?.children ?? []) as HTMLElement[];
  const cell = cells.find(c => c.classList.contains('on'));
  // A season picked from the chips has nothing wearing 「on」, and the strip still holds the offset of the
  // one just left: it would open on 第 18 集 because that is what used to be in the middle. Start it over.
  if (!cell) {
    // Not glideTo(cells[0]): centring the first card asks for a place inside the leading copies, and the
    // seam walk then adds a whole list-length. `home` is the offset that puts it on the left edge instead.
    if (rail) rail.glideTo(rail.home);
    else strip.value?.scrollTo({ left: 0 });
    return;
  }
  glideTo(cell);
}

/** Walk the strip to a cell, centred, without touching anything outside it. A looping strip keeps copies on
 *  both sides, so the same cell is also a whole list-length away: take the shorter walk, or stepping past
 *  the last episode of a season slides through all of it. */
function glideTo(cell: HTMLElement): void {
  const el = strip.value;
  if (!el) return;
  const b = el.getBoundingClientRect(), c = cell.getBoundingClientRect();
  let to = el.scrollLeft + c.left + c.width / 2 - (b.left + b.width / 2);
  if (rail?.looped && rail.period > 0) {
    const d = to - el.scrollLeft;
    to = el.scrollLeft + d - Math.round(d / rail.period) * rail.period;
  }
  // Asked of the rail, because centring the last cells of a long season asks for a place past its copies.
  if (rail) rail.glideTo(rail.place(to, false));
  else el.scrollTo({ left: to, behavior: 'smooth' });
}

/** Opening the strip on the cell under the playhead is also where a keyboard wants to be: 第 1 集 focused
 *  while 第 16 集 plays means two dozen presses to reach the neighbours of the episode on screen. Only on
 *  the first load - a season the reader asked for has to leave the cursor on the chip they pressed.
 *  `preventScroll` because the centring owns the offset, and a native scroll-into-view also drags every
 *  ancestor, which here is the overlay itself. */
function focusPlaying(): void {
  const cells = rail ? rail.originals() : Array.from(strip.value?.children ?? []) as HTMLElement[];
  cells.find(c => c.classList.contains('on'))?.focus({ preventScroll: true });
}

/** A wheel over the strip pushes it sideways, the way it does over the rails on the detail page. One target
 *  and one follow loop rather than a `scrollBy({ behavior: 'smooth' })` per event: a streamed gesture
 *  restarts that ease-in every ~16 ms, which crawls instead of running. */
let wheelWant = 0;
let wheelRun = false;
let wheelFrame = 0;
function stopWheel(): void {
  wheelRun = false;
  if (wheelFrame) cancelAnimationFrame(wheelFrame);
  wheelFrame = 0;
}
function followWheel(): void {
  wheelFrame = 0;
  const el = strip.value;
  if (!el) {
    wheelRun = false;
    return;
  }
  // A loop moves the row by a whole list-length when it crosses a seam, and the target comes along with it.
  wheelWant += rail?.normalize(true) ?? 0;
  const want = rail ? rail.place(wheelWant, false) : Math.max(0, Math.min(el.scrollWidth - el.clientWidth, wheelWant));
  const before = el.scrollLeft;
  const gap = want - before;
  if (Math.abs(gap) < 0.7) {
    el.scrollLeft = want;
    wheelRun = false;
    return;
  }
  // At least a whole pixel: the offset comes back rounded, so a step that is a fraction of one is written and
  // read as the same number, and the loop stops a few pixels short of every notch it was asked for.
  el.scrollLeft = before + Math.sign(gap) * Math.max(1, Math.abs(gap) * 0.24);
  // A strip that cannot go further, or one whose offset rounds every nudge away, must not spin.
  if (el.scrollLeft === want || el.scrollLeft === before) wheelRun = false;
  else wheelFrame = requestAnimationFrame(followWheel);
}
function onWheel(e: WheelEvent): void {
  const el = strip.value;
  if (!el || e.ctrlKey) return;
  const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  const d = raw * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1);
  if (!d) return;
  // At the end of a season too short to loop, what is left of the gesture belongs to the card around it.
  const max = el.scrollWidth - el.clientWidth;
  if (!rail?.looped && !wheelRun && ((d < 0 && el.scrollLeft <= 0) || (d > 0 && el.scrollLeft >= max - 1))) return;
  e.preventDefault();
  if (!wheelRun) {
    // Wherever a glide left the strip is where the gesture starts, and writing the offset back is also
    // what cancels that glide, so the two hands never pull the strip against each other.
    const live = el.scrollLeft;
    el.scrollLeft = live;
    wheelWant = live;
  }
  wheelWant += d;
  wheelRun = true;
  if (!wheelFrame) wheelFrame = requestAnimationFrame(followWheel);
}

/** Left and right walk along the strip. The card reads those keys as 「back」, which is right for a row of
 *  settings and wrong for a row of episodes - a strip is what a reader points at when they expect the
 *  arrows to move along it. Escape still leaves, and a season short enough not to loop stops at its ends. */
function onStripKey(e: KeyboardEvent): void {
  if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.ctrlKey || e.metaKey || e.altKey) return;
  const el = strip.value;
  const here = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.pl-cell');
  if (!el || !here) return;
  const cells = rail ? rail.originals() : (Array.from(el.children) as HTMLElement[]);
  const i = cells.indexOf(here);
  if (i < 0) return;
  e.preventDefault();
  e.stopPropagation();
  const step = e.key === 'ArrowRight' ? 1 : -1;
  const n = rail?.looped ? (i + step + cells.length) % cells.length : Math.max(0, Math.min(cells.length - 1, i + step));
  cells[n].focus({ preventScroll: true });
  glideTo(cells[n]);
}

onBeforeUnmount(stopWheel);

/** immediate: the session is already loaded by the time this menu mounts, so a watcher that only fires on
 *  a change never runs and the panel sits empty with 104 episodes on the server. 载入中… covers both round
 *  trips: with the flag set only around the second one, the panel had a window where nothing had arrived yet
 *  and 这一季没有返回条目 was already on screen as a lie. */
let opened = false;
watch([seriesId, seasonId], async () => {
  if (!seriesId.value) return;
  loading.value = true;
  try {
    await loadSeasons();
    if (active.value) await loadEpisodes(active.value);
  } finally {
    loading.value = false;
  }
  await centerOnPlaying();
  // The panel is remounted for every open, so this is the first list of one visit: the cursor starts on the
  // episode on screen. A later change of season is a click on a chip, and that chip keeps the cursor.
  if (!opened) {
    opened = true;
    focusPlaying();
  }
}, { immediate: true });

/** Picking an episode is the end of the question the strip asked, so the card gets out of the way: it
 *  floats over the bottom of the frame it was opened to cover, and leaving it up hides the episode the
 *  click just started. A failed play leaves it open, since that pick is still the user's next attempt. */
async function choose(id: string): Promise<void> {
  if (id === currentCell.value) return;
  if (await player.play(id)) player.closePanel();
}

/* The cell is the picture: the number rides in its corner and everything else is what the frame shows. The
   episode's name is still worth having, so it is the cell's tooltip rather than a second line under it. */
const titleOf = (ep: LibraryItem): string =>
  episodeName({ episode: ep.indexNumber, season: ep.parentIndexNumber, seriesName: ep.seriesName }, names.value[ep.id], ep.name);
</script>

<template>
  <p v-if="!seriesId" class="pl-empty">这不是剧集条目</p>
  <template v-else>
    <!-- The card has no header of its own: the season words and the close button share the one line the
         covers need above them, and that line carries no title and no count - the pictures say both. -->
    <div class="ep-top">
      <div v-if="seasons.length > 1" class="ep-seasons">
        <button
          v-for="s in seasons"
          :key="s.id"
          class="ep-season"
          :class="{ on: active === s.id, playing: s.indexNumber === playingSeason }"
          :aria-pressed="active === s.id"
          :title="s.indexNumber === playingSeason ? '正在播放这一季' : chipLabel(s)"
          @click="loadEpisodes(s.id)"
        >
          {{ chipLabel(s) }}
        </button>
      </div>
      <button class="ep-x" title="关闭" @click="player.closePanel()">
        <X :size="16" />
      </button>
    </div>

    <p v-if="loading" class="pl-empty">载入中…</p>
    <div v-else ref="strip" class="pl-strip" @wheel="onWheel" @keydown="onStripKey">
      <button
        v-for="ep in episodes"
        :key="ep.id"
        class="pl-cell"
        :class="{ on: ep.id === currentCell }"
        :title="titleOf(ep)"
        @click="choose(ep.id)"
      >
        <span class="art">
          <img v-reveal v-if="artOf(ep)" :src="artOf(ep)" :alt="ep.name" loading="lazy" @error="onArtFail(ep)" />
          <template v-else>{{ ep.indexNumber ?? '' }}</template>
          <span v-if="artOf(ep)" class="no">{{ ep.indexNumber }}</span>
        </span>
        <span class="cap">{{ titleOf(ep) || `第 ${ep.indexNumber} 集` }}</span>
      </button>
    </div>
    <p v-if="!loading && !episodes.length" class="pl-empty">这一季没有返回条目</p>
  </template>
</template>
