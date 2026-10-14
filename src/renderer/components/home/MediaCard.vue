<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { LibraryItem } from '../../../shared/types';
import { useAppStore } from '../../stores/app';
import { fmtClock, fmtRuntime, ticksToMs } from '../../lib/format';

const props = withDefaults(
  defineProps<{ item: LibraryItem; variant?: 'poster' | 'still'; width?: number; index?: number }>(),
  { variant: 'poster', width: 200, index: 0 },
);
const emit = defineEmits<{ (e: 'play', item: LibraryItem): void }>();

const store = useAppStore();
const router = useRouter();
const root = ref<HTMLElement | null>(null);
const src = ref('');
const loaded = ref(false);
const failed = ref(false);
const tries = ref(0);

/** The gateway 500s on a burst, so a grid only asks for the art it can see. */
const near = ref(false);
let io: IntersectionObserver | null = null;
onMounted(() => {
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
    const still = props.variant === 'still';
    src.value = await store.itemArt(props.item, still ? 520 : props.width * 2, still);
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
const played = computed(() => Math.min(100, props.item.userData?.playedPercentage || 0));
const rating = computed(() => {
  const r = props.item.communityRating;
  return r && r >= 6 ? r.toFixed(1) : '';
});
const sub = computed(() => {
  const i = props.item;
  if (i.latestEpisode) return `第 ${i.latestEpisode.season ?? 1} 季 · 第 ${i.latestEpisode.episode} 集`;
  if (i.parentIndexNumber != null && i.indexNumber != null) return `第 ${i.parentIndexNumber} 季 · 第 ${i.indexNumber} 集`;
  if (i.indexNumber != null) return `第 ${i.indexNumber} 集`;
  if (i.childCount) return `${i.childCount} 季`;
  return '';
});
/** Reference caption: how far in you got, not how far is left. */
const watchedLabel = computed(() => {
  const ms = (ticksToMs(props.item.runTimeTicks) * played.value) / 100;
  return played.value > 0 && ms > 0 ? `看到 ${fmtClock(ms)}` : '';
});
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
    const year = i.latestEpisode ? undefined : i.productionYear;
    return [sub.value, year].filter(Boolean).join(' · ');
  }
  if (i.seriesName && i.parentIndexNumber != null && i.indexNumber != null) {
    // Half the episodes on this server have no title of their own and come named 「第 2 集」, which the
    // position in front of it already says; the tail only carries a name that adds something.
    const t = i.name.trim();
    const positionOnly = /^第\s*[\d一二三四五六七八九十百千]+\s*[集话話]\s*$/.test(t) || /^\d+$/.test(t) || /^episode\s*\d+$/i.test(t);
    return `第 ${i.parentIndexNumber} 季 · 第 ${i.indexNumber} 集${t && !positionOnly ? ` · ${t}` : ''}`;
  }
  return fmtRuntime(i.runTimeTicks);
});

function open(): void {
  // Episode cards inside their own series page resolve back to this route.
  if (!target.value || target.value === router.currentRoute.value.params.id) return;
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
      <div v-if="!loaded && !failed" class="skeleton"></div>
      <img v-if="url && !failed" :src="url" alt="" :class="{ show: loaded }" loading="lazy" decoding="async" @load="loaded = true" @error="onErr" />
      <span v-if="failed" class="ph">{{ (item.seriesName || item.name).slice(0, 1) }}</span>

      <span v-if="rating" class="rate">★ {{ rating }}</span>

      <template v-if="variant === 'still'">
        <span v-if="watchedLabel" class="chip">{{ watchedLabel }}</span>
        <div v-if="played > 0" class="prog"><i :style="{ width: played + '%' }"></i></div>
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
  scroll-snap-align: start;
  opacity: 0;
  transform: translate3d(0, 22px, 0) scale(0.97);
  transition:
    opacity 0.5s var(--ease-out) calc(var(--i) * 34ms),
    transform 0.6s var(--ease-out) calc(var(--i) * 34ms);
}
.in .card {
  opacity: 1;
  transform: none;
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
}

.skeleton {
  position: absolute;
  inset: 0;
  background: var(--shimmer);
  background-size: 220% 100%;
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

/* Bottom-edge hairline: the reference marks progress on the still itself. */
.prog {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgba(255, 255, 255, 0.32);
  overflow: hidden;
}
.prog i {
  display: block;
  height: 100%;
  background: #fff;
  box-shadow: 0 0 0 1px rgba(18, 18, 26, 0.08);
  transform-origin: left;
  transition: width 0.9s var(--ease-out);
}

.chip {
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
