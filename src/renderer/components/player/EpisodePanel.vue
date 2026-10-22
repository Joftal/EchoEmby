<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { usePlayerStore } from '../../stores/player';
import { useAppStore } from '../../stores/app';
import { episodeName, episodePosition, fmtRuntime, seasonTitle } from '../../lib/format';
import { trustSeason } from '../../lib/scores';
import { embyCached } from '../../lib/embycache';
import { vReveal } from '../../lib/reveal';
import type { LibraryItem, TmdbSeasonRow } from '../../../shared/types';

const player = usePlayerStore();
const app = useAppStore();

const seriesId = computed(() => player.session?.seriesId || '');
const seasonId = computed(() => player.session?.seasonId || '');
const itemId = computed(() => player.session?.itemId || '');

const seasons = ref<LibraryItem[]>([]);
const episodes = ref<LibraryItem[]>([]);
const active = ref('');
const loading = ref(false);
const art = ref<Record<string, string[]>>({});
const artDead = ref<Record<string, true>>({});
/* TMDB's title for each episode, off the same per-season reply the frames come from. The chips above the
   strip already name the season, so this only ever adds what the episode is called — and it is what puts a
   Chinese 集名 on a row the server filed as 「ゆるキャン△ - S01E06」. */
const names = ref<Record<string, string>>({});
const strip = ref<HTMLElement | null>(null);

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
   somebody actually gave them: 鬼灭's server rows say only the position, where TMDB has 「立志篇」. The same
   threshold the detail page uses is applied here rather than reinvented, because this list is a control —
   naming 季 1 after a season that is 800 Meters' 3 would put a lie on the button that switches what plays.
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
  const el = strip.value;
  const cell = el?.querySelector('.pl-cell.on');
  if (!el || !cell) return;
  const b = el.getBoundingClientRect(), c = cell.getBoundingClientRect();
  // A jump of eight screens' worth of cells read as the panel being replaced rather than scrolled; this is
  // the same move a wheel over the strip makes.
  el.scrollTo({ left: el.scrollLeft + c.left + c.width / 2 - (b.left + b.width / 2), behavior: 'smooth' });
}

/** immediate: the session is already loaded by the time this menu mounts, so a watcher that only fires on
 *  a change never runs and the panel sits empty with 104 episodes on the server. 载入中… covers both round
 *  trips: with the flag set only around the second one, the panel had a window where nothing had arrived yet
 *  and 这一季没有返回条目 was already on screen as a lie. */
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
}, { immediate: true });

async function choose(id: string): Promise<void> {
  if (id === itemId.value) return;
  await player.play(id);
}

const titleOf = (ep: LibraryItem): string =>
  episodeName({ episode: ep.indexNumber, season: ep.parentIndexNumber, seriesName: ep.seriesName }, names.value[ep.id], ep.name);
</script>

<template>
  <p v-if="!seriesId" class="pl-empty">这不是剧集条目</p>
  <template v-else>
    <div v-if="seasons.length > 1" class="pl-chips">
      <button v-for="s in seasons" :key="s.id" class="pl-chip" :class="{ on: active === s.id }" @click="loadEpisodes(s.id)">
        {{ chipLabel(s) }}
      </button>
    </div>

    <p v-if="loading" class="pl-empty">载入中…</p>
    <div v-else ref="strip" class="pl-strip">
      <button v-for="ep in episodes" :key="ep.id" class="pl-cell" :class="{ on: ep.id === itemId }" @click="choose(ep.id)">
        <span class="art">
          <img v-reveal v-if="artOf(ep)" :src="artOf(ep)" :alt="ep.name" loading="lazy" @error="onArtFail(ep)" />
          <template v-else>{{ ep.indexNumber ?? '' }}</template>
        </span>
        <span class="cap">
          <b>{{ episodePosition(ep.parentIndexNumber, ep.indexNumber) }}</b>
          <span>{{ titleOf(ep) || fmtRuntime(ep.runTimeTicks) }}</span>
        </span>
      </button>
    </div>
    <p v-if="!loading && !episodes.length" class="pl-empty">这一季没有返回条目</p>
  </template>
</template>
