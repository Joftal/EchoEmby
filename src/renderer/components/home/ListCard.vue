<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { LibraryItem } from '../../../shared/types';
import { useAppStore } from '../../stores/app';
import { fmtRuntime } from '../../lib/format';
import { genreLabels } from '../../lib/genres';

const props = withDefaults(defineProps<{ item: LibraryItem; index?: number }>(), { index: 0 });

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
    if (!props.item.primaryImageTag) {
      src.value = '';
      failed.value = true;
      return;
    }
    failed.value = false;
    src.value = await store.imageUrl(props.item, 190);
    if (!src.value) failed.value = true;
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
const rating = computed(() => {
  const r = props.item.communityRating;
  return r && r >= 6 ? r.toFixed(1) : '';
});
const meta = computed(() =>
  [
    props.item.seriesName && props.item.seriesName !== props.item.name ? props.item.seriesName : '',
    props.item.productionYear ? String(props.item.productionYear) : '',
    genreLabels(props.item.genres).join(' / '),
  ]
    .filter(Boolean)
    .join('  ·  '),
);
const runtime = computed(() => fmtRuntime(props.item.runTimeTicks));

function open(): void {
  if (target.value) router.push(`/detail/${target.value}`);
}
</script>

<template>
  <article ref="root" class="lcard" :style="{ '--i': index }" tabindex="0" @click="open" @keydown.enter="open">
    <div class="thumb">
      <div v-if="!loaded && !failed" class="skeleton"></div>
      <img v-if="url && !failed" :src="url" alt="" :class="{ show: loaded }" loading="lazy" decoding="async" @load="loaded = true" @error="onErr" />
      <span v-if="failed" class="ph">{{ (item.seriesName || item.name).slice(0, 1) }}</span>
    </div>

    <div class="body">
      <div class="head">
        <h3>{{ item.name }}</h3>
        <span v-if="item.studio" class="studio">{{ item.studio }}</span>
      </div>
      <p v-if="meta" class="meta">{{ meta }}</p>
      <p class="ov">{{ item.overview || '暂无简介。' }}</p>
      <div class="badges">
        <span v-if="rating" class="b rate">★ {{ rating }}</span>
        <span v-if="item.officialRating" class="b cert">{{ item.officialRating }}</span>
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
/* The rise used to be a transition gated on `.in`, but BrowseView writes `in` into the grid's class
   at first render, so the element's very first computed style already *was* its end state and no
   transition could ever run — measured: opacity 1 at the insertion frame. What survived was the
   stagger, hanging off `transform`, which delayed every hover on the list by up to 286ms. An
   animation does run on insertion, so the entrance now actually plays and the hover path keeps
   nothing but --hov. `backwards` holds the hidden frame through the delay and then lets go, so the
   resting style is the card's own and a hover transform is no longer outranked by a filled keyframe. */
@keyframes rise {
  from {
    opacity: 0;
    transform: translate3d(0, 18px, 0);
  }
}
.in .lcard {
  animation: rise 0.56s var(--ease-out) backwards;
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
}
.skeleton {
  position: absolute;
  inset: 0;
  background: var(--shimmer);
  background-size: 220% 100%;
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
</style>
