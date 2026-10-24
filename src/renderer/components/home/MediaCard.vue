<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { LibraryItem } from '../../../shared/types';
import { useAppStore } from '../../stores/app';
import { begin } from '../../lib/handoff';
import { episodeName, episodePosition, fmtRuntime, seenLabel, watchedRatio } from '../../lib/format';
import { useTmdb } from '../../lib/scores';
import { LOOP_NEED } from '../../lib/looprail';

const props = withDefaults(
  defineProps<{ item: LibraryItem; variant?: 'poster' | 'still'; width?: number; index?: number }>(),
  { variant: 'poster', width: 200, index: 0 },
);
const emit = defineEmits<{ (e: 'play', item: LibraryItem): void }>();

const store = useAppStore();
const router = useRouter();
const root = ref<HTMLElement | null>(null);
const rungs = ref<string[]>([]);
const dead = ref<Record<string, true>>({});
const loaded = ref(false);
const failed = ref(false);
const tries = ref(0);
/** The best picture this card has not already watched fail. TMDB's own poster is the last rung and costs no
 *  ask of its own — it rides the same reply the ★ badge reads — so a work whose picture will not decode still
 *  ends up with a picture rather than a letter. */
const src = computed(() => {
  const extra = tmdb.value.meta?.poster ? `https://image.tmdb.org/t/p/w500${tmdb.value.meta.poster}` : '';
  return [...rungs.value, extra].find(u => u && !dead.value[u]) || '';
});

/** The gateway 500s on a burst, so a grid only asks for the art it can see. */
const near = ref(false);
let io: IntersectionObserver | null = null;
onMounted(() => {
  /* A looping row keeps copies of its far cards at either end, and a copy is on screen while the card it was
     copied from is nowhere near it. The row says so when the copy is the one the reader can see; until it
     does, this card withholds the picture the copy is standing in for. */
  root.value?.addEventListener(LOOP_NEED, () => { near.value = true; }, { once: true });
  if (!window.IntersectionObserver || !root.value) {
    near.value = true;
    return;
  }
  io = new IntersectionObserver(
    (entries) => {
      if (entries.some(e => e.isIntersecting)) {
        near.value = true;
        io?.disconnect();
        io = null;
      }
    },
    { rootMargin: '600px' },
  );
  io.observe(root.value);
});
onBeforeUnmount(() => {
  io?.disconnect();
  io = null;
});

/** Gateway image replies flake under a burst, so art is fetched per slide and retried. An episode's own
 *  TMDB still has no query string, and appending `&_r=` to it would land in the path and 404. */
const url = computed(() =>
  src.value && tries.value ? `${src.value}${src.value.includes('?') ? '&' : '?'}_r=${tries.value}` : src.value,
);

watch(
  () => [props.item.id, props.variant, props.width, near.value] as const,
  async () => {
    if (!near.value) return;
    loaded.value = false;
    tries.value = 0;
    dead.value = {};
    const still = props.variant === 'still';
    rungs.value = await store.itemArt(props.item, still ? 520 : props.width * 2, still);
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

/* TMDB's name for this episode, asked on the same `near` gate the art already rides and out of the same
   per-season reply — a card that took its frame from TMDB pays nothing extra, and one that had its own
   picture is the only one that asks. It is the synopsis's ladder applied to the title: 中文 > TMDB 的另一种
   语言 > 服务器, which is what stops a 在看 card wearing 「ゆるキャン△ - S01E06」 when TMDB has 「肉与红叶与谜之湖」. */
const tmName = ref('');
let namedFor = '';
watch(
  () => [near.value, props.item.id, props.variant] as const,
  async () => {
    const i = props.item;
    if (!near.value || props.variant !== 'still' || i.type !== 'Episode') return;
    if (i.id !== namedFor) tmName.value = '';
    namedFor = i.id;
    const n = await store.episodeTitle(i);
    if (props.item.id === i.id) tmName.value = n;
  },
  { immediate: true },
);

const target = computed(() => (props.item.type === 'Episode' ? props.item.parentId : props.item.id));
const played = computed(() => Math.round(watchedRatio(props.item.userData, props.item.runTimeTicks) * 100));
/* The number on this card has to be the number on the page it opens, or one title wears two of them: TMDB
   first, the server only once TMDB has answered and has nothing to say, and neither while the answer is
   still owed. That third state is the whole point — printing the server's 8.9 and then switching to TMDB's
   7.7 is still two numbers, one of them wrong, and a badge that simply arrives a frame later is one.
   One ask per title per session (episode rows fold into their series), gated by the same `near` the art
   already rides, and the answer sits on disk for 30 days.
   The floor at 6 is gone: it hid a rating the platform publishes, and the season band on the page this card
   opens already printed anything above 0, so one title could read 7.4 here and 5.9 there. */
const tmdb = useTmdb(() => (near.value ? props.item : null));
const rating = computed(() => {
  const { meta, ready, fallback } = tmdb.value;
  const v = meta?.voteAverage || (ready ? fallback : 0);
  return v > 0 ? v.toFixed(1) : '';
});
const sub = computed(() => {
  const i = props.item;
  // A row that does not say which season its latest episode sits in prints the episode alone: guessing 1
  // would put a position on the card the server never claimed.
  if (i.latestEpisode) return episodePosition(i.latestEpisode.season, i.latestEpisode.episode);
  if (i.indexNumber != null) return episodePosition(i.parentIndexNumber, i.indexNumber);
  /* A Series row's ChildCount is that one row's season count, and this library files 81 of its 1569 works as
     several Series rows, 141 of those rows billing a single season (measured) — so the card read 「1 季」 about
     a title whose page lists more. The year beside it says the same thing about the same subject with nothing
     to contradict it. A collection's 部 count is its own answer, so it stays. */
  if (i.childCount && i.type === 'BoxSet') return `${i.childCount} 部`;
  return '';
});
/** How far in you got, not how far is left — the same read-out every other surface now uses. */
const watchedLabel = computed(() => seenLabel(props.item.userData, props.item.runTimeTicks));
/** A folded card is the show, so the show's name carries the line; the episode it points at drops to
 *  the tail, where a long 集名 can be cut without hiding what the card is. */
const titleLine = computed(() => (props.variant === 'still' && props.item.seriesName ? props.item.seriesName : props.item.name));
/** The gateway never answers UserData.LastPlayed, so the caption carries the length instead: the
    server name it used to print is already in the rail's account row, once per card was one copy too
    many, and 「看到 15:00」 on the frame is the position this line has to be read against. */
const metaLine = computed(() => {
  const i = props.item;
  if (props.variant !== 'still') {
    // An episode position is the useful half of a series caption; the premiere year pushes it into ellipsis.
    const year = i.latestEpisode ? undefined : i.productionYear || tmdb.value.meta?.year;
    return [sub.value, year].filter(Boolean).join(' · ');
  }
  if (i.seriesName && i.indexNumber != null) {
    // The tail carries only what the episode says beyond the position printed in front of it, off the
    // TMDB-first ladder; 「ゆるキャン△ - S01E06」 is that position restated and says nothing after the cut.
    const t = episodeName(
      { episode: i.indexNumber, season: i.parentIndexNumber, seriesName: i.seriesName },
      tmName.value,
      i.name,
    );
    const pos = episodePosition(i.parentIndexNumber, i.indexNumber);
    return `${pos}${t ? ` · ${t}` : ''}`;
  }
  return fmtRuntime(i.runTimeTicks);
});

function open(): void {
  // Episode cards inside their own series page resolve back to this route.
  if (!target.value || target.value === router.currentRoute.value.params.id) return;
  begin(root.value?.querySelector<HTMLImageElement>('img.show'), target.value, props.item);
  router.push(`/detail/${target.value}`);
}
</script>

<template>
  <button
    ref="root"
    class="card"
    :class="variant"
    :style="{ width: width + 'px', '--i': index }"
    @click="open"
  >
    <div class="frame">
      <Transition name="art-skel">
        <div v-if="!loaded && !failed" class="skeleton"></div>
      </Transition>
      <img v-if="url && !failed" :src="url" alt="" :class="{ show: loaded }" loading="lazy" decoding="async" @load="loaded = true" @error="onErr" />
      <span v-if="failed" class="ph">{{ (item.seriesName || item.name).slice(0, 1) }}</span>

      <span v-if="rating" class="rate">★ {{ rating }}</span>

      <!-- The progress read-out belongs to the item, not to one card shape: 在看, 首页行, 资源库 and 收藏
           all answer the same question — how far did I get. -->
      <span v-if="watchedLabel" class="chip">{{ watchedLabel }}</span>
      <div v-if="played > 0" class="frame-prog"><i :style="{ width: played + '%' }"></i></div>

      <template v-if="variant === 'still'">
        <span class="disc" role="presentation" @click.stop="emit('play', item)">
          <svg viewBox="0 0 24 24" width="20" height="20"><path d="M8 5l12 7-12 7z" fill="currentColor" /></svg>
        </span>
      </template>
    </div>

    <div class="label">
      <div class="line">{{ titleLine }}</div>
      <div v-if="metaLine" class="tail">{{ metaLine }}</div>
    </div>
  </button>
</template>

<style scoped>
.card {
  position: relative;
  flex: none;
  text-align: left;
  cursor: pointer;
  padding: 0;
  /* The frame before its row has been revealed. The reveal is a keyframe, not a transition — the note
     in ListCard has the measurement: BrowseView writes `in` into the grid's class at first render, so
     the card's very first computed style already *was* its end state and nothing could animate into it.
     The stagger used to hang off a transform transition, which is what held a late card's hover 374ms
     after the pointer; here it only delays the entrance. */
  opacity: 0;
}
/* A poster is placed rather than switched on: it rises 14px and gives up 1.5% of its size, on a curve
   that covers most of that distance in the first third and glides the rest. The stagger is the row's own
   cascade (RowScroller puts `in` on the row when it scrolls into view), and `backwards` rather than `both`
   because a filled keyframe would outrank the card's hover transform for as long as the element lives. */
.in .card {
  opacity: 1;
  animation: card-in var(--arrive-dur) var(--ease-out) backwards;
  animation-delay: calc(var(--i) * 34ms);
}

.frame {
  position: relative;
  overflow: hidden;
  background: var(--bg-elev-2);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
  transition: transform var(--hov) var(--ease-out), box-shadow var(--hov) var(--ease);
}
.poster .frame {
  aspect-ratio: 2 / 3;
  border-radius: var(--radius);
}
.still .frame {
  aspect-ratio: 16 / 9;
  border-radius: var(--radius);
}
.card:hover .frame {
  transform: translate3d(0, -5px, 0);
  box-shadow: var(--shadow);
}
.card:active .frame {
  transform: translate3d(0, -1px, 0) scale(0.988);
  transition-duration: 0.12s;
}
.card:focus-visible .frame {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}

img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transform: scale(1.04);
  transition: opacity 0.45s var(--ease), transform 0.7s var(--ease);
}
img.show {
  opacity: 1;
  transform: none;
}
.card:hover img.show {
  transform: scale(1.055);
  transition-duration: 0.75s;
}

.ph {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 42px;
  font-weight: 700;
  /* Opaque, and the same on both card kinds: this letter is the only identifier on art the server
     has no image for (measured: 48 of 60 在看 items), and an alpha glyph composited differently over
     every tile. --text-faint on this plate is 6.4:1. */
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

.rate {
  position: absolute;
  top: 8px;
  left: 8px;
  padding: 2px 7px;
  /* Same plate as the .chip below it: this badge sits on the top-left of bare art, where the hero's
     amber-on-wash pair cannot work (a 20% tint over a white poster is unreadable) and a near-white
     plate over the poster is the 「白块压画」 treatment that has been rejected repeatedly. */
  border-radius: var(--r-badge);
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: #fff;
  background: rgba(16, 16, 22, 0.74);
  backdrop-filter: blur(8px);
  opacity: 0;
  transform: translate3d(0, -4px, 0);
  transition: opacity var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.card:hover .rate {
  opacity: 1;
  transform: none;
}

.chip {
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

.disc {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  margin: -23px 0 0 -23px;
  border-radius: 50%;
  color: #fff;
  background: rgba(16, 16, 22, 0.58);
  border: 1px solid rgba(255, 255, 255, 0.3);
  backdrop-filter: blur(10px);
  opacity: 0;
  transform: scale(0.72);
  transition: opacity var(--hov) var(--ease), transform var(--hov) var(--ease-out), background var(--hov) var(--ease);
}
.card:hover .disc {
  opacity: 1;
  transform: none;
}
.disc:hover {
  background: var(--ink);
  border-color: transparent;
}
.disc:active {
  transform: scale(0.9);
}

.label {
  padding: 9px 0 0;
}
.line {
  font-size: 13.5px;
  line-height: 1.4;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tail {
  display: block;
  margin-top: 2px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}
</style>
