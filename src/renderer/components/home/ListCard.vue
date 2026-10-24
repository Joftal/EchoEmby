<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { LibraryItem } from '../../../shared/types';
import { useAppStore } from '../../stores/app';
import { begin } from '../../lib/handoff';
import { episodeName, episodePosition, seenLabel, watchedRatio } from '../../lib/format';
import { mergeGenres } from '../../lib/genres';
import ScoreStrip from '../ScoreStrip.vue';
import { useTmdb } from '../../lib/scores';
import { LOOP_NEED } from '../../lib/looprail';

/* Two densities of the same horizontal card. `row` is the catalogue row 收藏 wants: a poster, the
   paragraph, and the badges a title carries. `queue` is 在看's: a 16:9 frame to read the stop against,
   where the episode sits, and how big the season around it is — no paragraph, because on this
   page one show is one card and the sentence under it is the answer to a question nobody is asking. */
const props = withDefaults(
  defineProps<{
    item: LibraryItem;
    index?: number;
    variant?: 'row' | 'queue';
    /** The season row behind an episode card, which is the only place 本季 N 集 can come from. */
    season?: { total?: number } | null;
  }>(),
  { index: 0, variant: 'row', season: null },
);
const emit = defineEmits<{ (e: 'play', item: LibraryItem): void }>();

const queue = computed(() => props.variant === 'queue');

const store = useAppStore();
const router = useRouter();
const root = ref<HTMLElement | null>(null);
const rungs = ref<string[]>([]);
const dead = ref<Record<string, true>>({});
const loaded = ref(false);
const failed = ref(false);
const tries = ref(0);
/** The best picture this card has not already watched fail.
 *  A portrait frame of a work wears TMDB's poster first, and the server's picture is the stand-in behind it:
 *  measured on the 8 cards this page paints, the gateway holds exactly one Primary each (its Images endpoint
 *  answers three rows, tagged Primary / Logo / Backdrop, with no Language field to rank), and that one picture
 *  disagreed with the page the card opens on 6 of 8 — 5 of them the work's original-language art (3 Japanese,
 *  1 Korean, 1 English). TMDB's poster costs no ask of its own — it rides the same reply the ★ badge reads — and
 *  the ladder below it is unchanged, so a card whose picture will not decode still ends up with one rather
 *  than a letter.
 *  The 在看 frame and an episode row keep the old order: a 16:9 frame cannot wear a portrait poster, and a
 *  row that has this episode's own still should show that rather than the work above it. */
const src = computed(() => {
  const extra = tmdb.value.meta?.poster ? `https://image.tmdb.org/t/p/w500${tmdb.value.meta.poster}` : '';
  const portraitWork = !queue.value && props.item.type !== 'Episode';
  return (portraitWork ? [extra, ...rungs.value] : [...rungs.value, extra]).find(u => u && !dead.value[u]) || '';
});

/** The gateway 500s on a burst, so a list only asks for the art it can see. */
const near = ref(false);
let io: IntersectionObserver | null = null;
onMounted(() => {
  // See MediaCard: a copy of this card can be on screen while the card itself is nowhere near it.
  root.value?.addEventListener(LOOP_NEED, () => { near.value = true; }, { once: true });
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

const url = computed(() =>
  src.value && tries.value ? `${src.value}${src.value.includes('?') ? '&' : '?'}_r=${tries.value}` : src.value,
);

watch(
  () => [props.item.id, props.variant, near.value] as const,
  async () => {
    if (!near.value) return;
    loaded.value = false;
    tries.value = 0;
    dead.value = {};
    rungs.value = await store.itemArt(props.item, queue.value ? 360 : 190, queue.value);
    failed.value = !rungs.value.length;
  },
  { immediate: true },
);

/* Two different faults arrive as the same error event: the gateway flaking on a burst, which one more try
   clears, and the gateway minting a URL for a tag it cannot render, which no retry clears and the next rung
   does. So try the picture once more, then step down to the stand-in behind it, and only fall to the letter
   when the ladder has run out. */
function onErr(): void {
  const cur = src.value;
  if (!cur) return;
  if (tries.value === 0) {
    tries.value = 1;
    return;
  }
  dead.value = { ...dead.value, [cur]: true };
  tries.value = 0;
  failed.value = !src.value;
}

const target = computed(() => (props.item.type === 'Episode' ? props.item.parentId : props.item.id));
/* The paragraph and the year come from the same ladder the detail page and the lobby hero use — TMDB in
   Chinese, then TMDB's other line, then the server — and this row was the only surface left out of it. Measured on
   a 48-row list: 26 of its rows had no overview at all and 32 carried no rating, while the server has an OfficialRating
   for only 13-18 of 25 sampled titles. The ask rides the `near` gate above rather than the row's own mount,
   so a page only reaches for the titles somebody can actually see. This getter pulls TMDB alone because it is
   the only source with a paragraph; the marks under it are asked by ScoreStrip, once the row's work resolves. */
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
    // The queue card draws no paragraph, so it does not take one — the season reply is shared either way,
    // and asking for a line this card cannot show is how a dead field survives a redesign.
    const [o, n] = await Promise.all([queue.value ? '' : store.episodeOverview(i), store.episodeTitle(i)]);
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
/* The reference's own line: the year, a gap, then the labels on a Chinese comma, with no middle dot between
   the segments. The gap is two non-breaking spaces because ordinary ones collapse and the gap the reference
   carries is wider than a word space, and the labels hang off one slash each. The series name still leads where the row is one of its episodes, since
   that row's headline is an episode title and answers 「which show」 with nothing. The labels themselves are
   the same ladder the paragraph and the marks ride: TMDB's order, then whatever this server calls a genre that
   TMDB never named. */
const meta = computed(() => {
  const head = [
    props.item.seriesName && props.item.seriesName !== props.item.name ? `${props.item.seriesName} ·` : '',
    String(props.item.productionYear || tmdb.value.meta?.year || ''),
  ]
    .filter(Boolean)
    .join(' ');
  return [head, mergeGenres(tmdb.value.meta?.genres, props.item.genres, 3).join('/')]
    .filter(Boolean)
    .join('\u00a0\u00a0');
});
const seen = computed(() => seenLabel(props.item.userData, props.item.runTimeTicks));
/* The marks are the work's numbers, so an episode row hands the strip the series above it rather than its
   own provider ids, which point at an episode none of these sites has a page for. A BoxSet or a Playlist has
   nothing above it and keeps its own row, where the strip falls back to the server's number. */
const stripItem = computed(() => tmdb.value.work || (isWork.value ? props.item : null));

/* ---- the queue card's own lines -------------------------------------------------------------
   Three, and each answers a different question, because this page folds a show's whole episode run
   into the one card you would resume: what am I watching (title), where did I stop (position + the
   episode's name), how big is the run I am inside (the count line — the stop itself is on the frame). */
const queueTitle = computed(() => {
  const i = props.item;
  if (i.type !== 'Episode') return i.name;
  return i.seriesName || headline.value || episodePosition(i.parentIndexNumber, i.indexNumber) || i.name;
});
const queueWhere = computed(() => {
  const i = props.item;
  if (i.type === 'Episode') {
    const pos = episodePosition(i.parentIndexNumber, i.indexNumber);
    const t = episodeName({ episode: i.indexNumber, season: i.parentIndexNumber, seriesName: i.seriesName || '' }, tmName.value, i.name);
    return `${pos}${t ? ` · ${t}` : ''}` || i.name;
  }
  const year = String(i.productionYear || tmdb.value.meta?.year || '');
  const g = mergeGenres(tmdb.value.meta?.genres, i.genres, 2).join(' / ');
  return [year, g].filter(Boolean).join(' · ');
});
/* The bar is this episode's own stop, drawn on the frame exactly the way the 继续观看 row draws it, because
   that is the only fraction these gateways answer with per row: measured over the 94 cards folded from 200
   在看 rows, an offset lands on 15 of them and a season's total on 57 — and a place in a season is a count of
   rows, not a length. So the frame carries how far into *this* episode the viewer got, and 本季 N 集 below
   stays the one line that describes the season. The runtime left this line for the same reason: 24分钟 under
   本季 3 集 reads as how long a season is, while it is one episode's length — which the 「看到」 plate on the
   frame and the bar above it already say better. */
const barPct = computed(() => Math.round(watchedRatio(props.item.userData, props.item.runTimeTicks) * 100));
const queueCount = computed(() => {
  const bits = [props.season?.total ? `本季 ${props.season.total} 集` : ''].filter(Boolean);
  if (rating.value) bits.push(`★ ${rating.value}`);
  return bits.join(' · ');
});

function open(): void {
  if (!target.value) return;
  begin(root.value?.querySelector<HTMLImageElement>('img.show'), target.value, props.item);
  router.push(`/detail/${target.value}`);
}
</script>

<template>
  <article ref="root" class="lcard" :class="{ queue }" :style="{ '--i': index }" tabindex="0" @click="open" @keydown.enter="open">
    <div class="thumb">
      <Transition name="art-skel">
        <div v-if="!loaded && !failed" class="skeleton"></div>
      </Transition>
      <img v-if="url && !failed" :src="url" alt="" :class="{ show: loaded }" loading="lazy" decoding="async" @load="loaded = true" @error="onErr" />
      <span v-if="failed" class="ph">{{ (item.seriesName || item.name).slice(0, 1) }}</span>

      <!-- The pill the 继续观看 row paints, from the same class in base.css and the same number the 「看到」
           plate prints, so the stop is read against the picture it was stopped on. The plate sits above it. -->
      <div v-if="queue && barPct > 0" class="frame-prog"><i :style="{ width: barPct + '%' }"></i></div>

      <!-- The reference puts the resume control on the frame itself: a play mark and the stop, or the play
           mark alone where this server kept no offset. It is always on screen, which is the point — the
           hover-only disc it replaces was reachable on every card but *visible* on none of them until the
           pointer arrived, and on this page it is the whole reason the page exists. -->
      <button v-if="queue" class="resume" :title="seen ? '从这里继续播放' : '开始播放'" @click.stop="emit('play', item)">
        <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d="M8 5l12 7-12 7z" fill="currentColor" /></svg>
        {{ seen || '播放' }}
      </button>
    </div>

    <div class="body">
      <div class="head">
        <h3>{{ queue ? queueTitle : headline }}</h3>
      </div>

      <p v-if="queue" class="where">{{ queueWhere }}</p>
      <template v-else>
        <p v-if="meta" class="meta">{{ meta }}</p>
        <p class="ov">{{ overview || '暂无简介。' }}</p>
        <div v-if="stripItem || seen" class="badges">
          <ScoreStrip v-if="stripItem" :item="stripItem" card />
          <span v-if="seen" class="b seen">{{ seen }}</span>
        </div>
      </template>

      <div v-if="queue" class="foot">
        <p v-if="queueCount" class="count">{{ queueCount }}</p>
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
/* The row card's flex line would stretch the frame to the copy's height, and a 92×151 box is not the 2:3
   the width declares: measured 0.609, so a 2:3 poster lost its bottom and the detail hand-off refused the
   seed. The queue card keeps its own 16:9 frame, which is deliberately the copy's height. */
.lcard:not(.queue) .thumb {
  align-self: flex-start;
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
  gap: 7px 13px;
  margin-top: 11px;
}
/* The strip is a row of its own, so it takes the slack and wraps its marks before this row wraps. */
.badges :deep(.strip) {
  min-width: 0;
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
/* The one badge in this row that is about *you*, so it is the one that carries the accent. */
.seen {
  color: var(--accent);
  background: var(--accent-soft);
}

/* ---- queue density -------------------------------------------------------------
   Measured off the reference: a 428x106 panel whose frame is 141 wide (a third of it, 16:9), a 16px title
   sharing its baseline row with the right edge, and the count pinned to the bottom of the text
   column rather than stacked under the title. The progress pill is not from the reference — it reads the
   stop inside the frame instead, because the reference's bar counts episodes and this account cannot
   answer that. Scaled to a two-across card here, the frame lands at 178px, the size the art asks for at 360. */
.queue {
  gap: 14px;
}
.queue .thumb {
  /* A third of the panel, the way the reference has it (141 of 428), rather than a fixed plate the text
     column has to work around: at two across this lands on 178px, and at three the frame steps down with
     the card instead of eating the count line. */
  width: clamp(150px, 35%, 178px);
  aspect-ratio: 16 / 9;
}
.queue .body {
  display: flex;
  flex-direction: column;
}
.queue .head h3 {
  font-size: 15.5px;
}
.where {
  margin: 5px 0 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}
.foot {
  margin-top: auto;
}
.count {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}
.resume {
  position: absolute;
  left: 10px;
  bottom: 22px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--r-badge);
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: #fff;
  background: rgba(16, 16, 22, 0.74);
  backdrop-filter: blur(8px);
  cursor: pointer;
  transition: background var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.resume:hover {
  background: var(--ink);
}
.resume:active {
  transform: scale(0.96);
  transition-duration: 0.12s;
}
</style>
