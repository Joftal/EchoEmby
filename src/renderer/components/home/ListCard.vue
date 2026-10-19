<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { LibraryItem } from '../../../shared/types';
import { useAppStore } from '../../stores/app';
import { begin } from '../../lib/handoff';
import { episodeName, episodePosition, fmtRuntime, seenLabel } from '../../lib/format';
import { genreLabels } from '../../lib/genres';
import { useTmdb } from '../../lib/scores';

const props = withDefaults(defineProps<{ item: LibraryItem; index?: number; matchedGenres?: string[] }>(), {
  index: 0,
  matchedGenres: () => [],
});

const store = useAppStore();
const router = useRouter();
const root = ref<HTMLElement | null>(null);
const src = ref('');
const loaded = ref(false);
const failed = ref(false);
const tries = ref(0);

/** The gateway 500s on a burst, so a list only asks for the art it can see. */
const near = ref(false);
let io: IntersectionObserver | null = null;
onMounted(() => {
  if (!window.IntersectionObserver || !root.value) {
    near.value = true;
    return;
  }
  io = new IntersectionObserver(
    entries => {
      if (entries.some(e => e.isIntersecting)) {
        near.value = true;
        io?.disconnect();
        io = null;
      }
    },
    { rootMargin: '500px' },
  );
  io.observe(root.value);
});
onBeforeUnmount(() => {
  io?.disconnect();
  io = null;
});

const url = computed(() => (src.value && tries.value ? `${src.value}&_r=${tries.value}` : src.value));

watch(
  () => [props.item.id, near.value] as const,
  async () => {
    if (!near.value) return;
    loaded.value = false;
    tries.value = 0;
    src.value = await store.itemArt(props.item, 190);
    failed.value = !src.value;
  },
  { immediate: true },
);

function onErr(): void {
  if (tries.value >= 2) {
    failed.value = true;
    return;
  }
  tries.value += 1;
}

const target = computed(() => (props.item.type === 'Episode' ? props.item.parentId : props.item.id));
/* Synopsis and age rating come from the same ladder the detail page and the lobby hero use — TMDB in
   Chinese, then TMDB's other line, then the server — and this row was the only surface left out of it. Measured on
   待看: 26 of 48 rows had no overview at all and 32 carried no rating, while the server has an OfficialRating
   for only 13-18 of 25 sampled titles. The ask rides the `near` gate above rather than the row's own mount,
   so a page only reaches for the titles somebody can actually see, and it asks TMDB alone: IMDb, Trakt and
   Bangumi would be six round trips per row for two lines of text this card cannot draw. */
const tmdb = useTmdb(() => (near.value ? props.item : null));
/* Age guidance is a property of the show, so an episode row takes it from the work above it. Its synopsis
   is not: this page's 24 episode rows are one show, and the series paragraph under each of them would be
   the same paragraph twenty-four times — so a row asks for its own episode's line, off the same season
   reply the 在看 cards ride (one ask per show-season however many rows of it are here, 30 days on disk). */
const isWork = computed(() => props.item.type !== 'Episode');
const tmOv = ref('');
const tmName = ref('');
let ovFor = '';
watch(
  () => [near.value, props.item.id] as const,
  async () => {
    const i = props.item;
    if (!near.value || i.type !== 'Episode') return;
    if (i.id !== ovFor) {
      tmOv.value = '';
      tmName.value = '';
    }
    ovFor = i.id;
    const [o, n] = await Promise.all([store.episodeOverview(i), store.episodeTitle(i)]);
    if (props.item.id !== i.id) return;
    tmOv.value = o;
    tmName.value = n;
  },
  { immediate: true },
);
/* The headline is the one place this card can print a release group's label, because it is the server's raw
   `Name`: 「名侦探柯南 - S01E1277」 under a meta line that already reads 名侦探柯南. Same ladder as the
   paragraph, same trimmer, and a floor the other two surfaces do not need — a card whose whole line went
   blank would show nothing at all, so a row nobody can name falls back to its own number. */
const headline = computed(() => {
  const i = props.item;
  if (i.type !== 'Episode') return i.name;
  const at = { episode: i.indexNumber, season: i.parentIndexNumber, seriesName: i.seriesName || '' };
  return episodeName(at, tmName.value, i.name) || episodePosition(i.parentIndexNumber, i.indexNumber) || i.name;
});
const overview = computed(() => {
  if (isWork.value) return tmdb.value.meta?.overviewZh || tmdb.value.meta?.overviewOther || props.item.overview || '';
  return tmOv.value || props.item.overview || '';
});
const cert = computed(() => tmdb.value.meta?.cert || props.item.officialRating || '');
/* One ladder, then the card's own floor. Two numbers for one title is what this used to print: measured on
   70 sampled titles, 12 differ by ≥0.3 and 5 by ≥1.0 — 孤独摇滚! held 8.5 here against the TMDB 8.3 the page
   it opens shows, and 首尔破笑组's 10.0 is server data that no rater agrees with. A score belongs to the work,
   so an episode row takes it from the series above it exactly as the badge beside it does, and a row whose
   answer is still owed prints nothing rather than the number that is about to be replaced. The floor at 6
   went with the card's: a 4.8 is a rating the platform publishes, and this row and that card are one title. */
const rating = computed(() => {
  const { meta, ready, fallback } = tmdb.value;
  const v = meta?.voteAverage || (ready ? fallback : 0);
  return v > 0 ? v.toFixed(1) : '';
});
const meta = computed(() =>
  [
    props.item.seriesName && props.item.seriesName !== props.item.name ? props.item.seriesName : '',
    props.item.productionYear ? String(props.item.productionYear) : '',
    genreLabels(props.item.genres, props.matchedGenres).slice(0, 3).join(' / '),
  ]
    .filter(Boolean)
    .join('  ·  '),
);
const runtime = computed(() => fmtRuntime(props.item.runTimeTicks));
const seen = computed(() => seenLabel(props.item.userData, props.item.runTimeTicks));

function open(): void {
  if (!target.value) return;
  begin(root.value?.querySelector<HTMLImageElement>('img.show'), target.value, props.item);
  router.push(`/detail/${target.value}`);
}
</script>

<template>
  <article ref="root" class="lcard" :style="{ '--i': index }" tabindex="0" @click="open" @keydown.enter="open">
    <div class="thumb">
      <Transition name="art-skel">
        <div v-if="!loaded && !failed" class="skeleton"></div>
      </Transition>
      <img v-if="url && !failed" :src="url" alt="" :class="{ show: loaded }" loading="lazy" decoding="async" @load="loaded = true" @error="onErr" />
      <span v-if="failed" class="ph">{{ (item.seriesName || item.name).slice(0, 1) }}</span>
    </div>

    <div class="body">
      <div class="head">
        <h3>{{ headline }}</h3>
        <span v-if="item.studio" class="studio">{{ item.studio }}</span>
      </div>
      <p v-if="meta" class="meta">{{ meta }}</p>
      <p class="ov">{{ overview || '暂无简介。' }}</p>
      <div class="badges">
        <span v-if="seen" class="b seen">{{ seen }}</span>
        <span v-if="rating" class="b rate">★ {{ rating }}</span>
        <span v-if="cert" class="b cert">{{ cert }}</span>
        <span v-if="runtime" class="b time">{{ runtime }}</span>
      </div>
    </div>
  </article>
</template>

<style scoped>
.lcard {
  display: flex;
  gap: 14px;
  padding: 14px;
  border-radius: var(--r-tile);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  text-align: left;
  transition: transform var(--hov) var(--ease-out), box-shadow var(--hov) var(--ease),
    border-color var(--hov) var(--ease);
}
/* The entrance used to be a transition gated on `.in`, but BrowseView writes `in` into the grid's class
   at first render, so the element's very first computed style already *was* its end state and no
   transition could ever run — measured: opacity 1 at the insertion frame. What survived was the
   stagger, hanging off `transform`, which delayed every hover on the list by up to 286ms.
   It is the row's own rise now, and `backwards` rather than `both` on purpose: the resting style stays the
   row's own, so a hover transform is not outranked by a filled keyframe. No scale on a row — it is 1100px
   wide, and 1.5% of that is 16px of horizontal squash that jiggles as it lands. */
.in .lcard {
  animation: row-in var(--arrive-dur) var(--ease-out) backwards;
  animation-delay: calc(var(--i) * 26ms);
}
.lcard:hover {
  transform: translate3d(0, -3px, 0);
  box-shadow: var(--shadow);
  border-color: var(--line-strong);
}
.lcard:active {
  transform: translate3d(0, -1px, 0) scale(0.992);
  transition-duration: 0.12s;
}
.lcard:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.thumb {
  position: relative;
  flex: none;
  width: 92px;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg-elev-2);
}
.thumb img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transition: opacity 0.45s var(--ease);
}
.thumb img.show {
  opacity: 1;
}
.ph {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 30px;
  font-weight: 700;
  /* Opaque, and the same colour as MediaCard's placeholder letter: an alpha glyph composited
     differently over every tile, and this letter is the only identifier when the server has no art. */
  color: var(--text-faint);
  background: linear-gradient(150deg, var(--bg), var(--bg-elev-2));
  animation: fade-in 0.3s var(--ease) both;
}
.skeleton {
  position: absolute;
  inset: 0;
  background: var(--shimmer);
  background-size: var(--sk-tile) 100%;
  animation: sh 1.3s linear infinite;
}

.body {
  min-width: 0;
  flex: 1;
}
.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.1px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.studio {
  flex: none;
  /* 13px: 12px drops the top antialiasing row of a CJK glyph. Free here — the 15px title's line box
     (23.3) still towers over this one's (20.2), so the head row does not grow. */
  font-size: 13px;
  font-weight: 500;
  color: var(--text-dim);
  max-width: 34%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta {
  margin: 5px 0 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.ov {
  margin: 9px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-dim);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.badges {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 11px;
}
.b {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  /* 6px, not a pill: every badge in the app is now the same rectangle, and only its surface changes
     with what sits behind it (bare art / the hero's wash / this light panel). */
  border-radius: var(--r-badge);
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.rate {
  color: #6b4500;
  background: rgba(255, 208, 99, 0.42);
}
.cert {
  color: var(--text-dim);
  border: 1px solid var(--line-strong);
}
.time {
  color: var(--text-dim);
  background: var(--chip);
}
/* The one badge in this row that is about *you*, so it is the one that carries the accent. */
.seen {
  color: var(--accent);
  background: var(--accent-soft);
}
</style>
