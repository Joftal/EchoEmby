<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import MediaCard from '../components/home/MediaCard.vue';
import type { LibraryItem } from '../../shared/types';
import { usePlayerStore } from '../stores/player';
import { useAppStore } from '../stores/app';
import { fmtDate, fmtRuntime } from '../lib/format';

const props = defineProps<{ id: string }>();
const router = useRouter();
const player = usePlayerStore();
const app = useAppStore();

const posterSrc = ref('');

const item = ref<LibraryItem | null>(null);
const seasons = ref<LibraryItem[]>([]);
const episodes = ref<LibraryItem[]>([]);
const seasonId = ref('');
const loading = ref(true);
const error = ref('');
const playErr = ref('');

const isSeries = computed(() => item.value?.type === 'Series');
const isSeason = computed(() => item.value?.type === 'Season');
// A Series or a Season has no media of its own: PlaybackInfo on either 500s.
const playableId = computed(() => {
  if (!item.value) return '';
  if (isSeries.value || isSeason.value) {
    return episodes.value.find(e => e.userData?.playedPercentage)?.id || episodes.value[0]?.id || '';
  }
  return item.value.id;
});

const genres = computed(() => (item.value?.genres || []).join(' / '));
const premiered = computed(() => fmtDate(item.value?.premiereDate) || String(item.value?.productionYear || ''));
const rating = computed(() => {
  const r = item.value?.communityRating;
  return r && r >= 1 ? r.toFixed(1) : '';
});

async function loadEpisodes(sid: string, seriesId = props.id) {
  seasonId.value = sid;
  episodes.value = [];
  if (!sid) return;
  const r = await window.echoemby.emby.episodes({ seriesId, seasonId: sid });
  if (r.ok) episodes.value = r.data || [];
}

watch(
  () => props.id,
  async id => {
    loading.value = true;
    error.value = '';
    item.value = null;
    seasons.value = [];
    episodes.value = [];
    const r = await window.echoemby.emby.item(id);
    loading.value = false;
    if (!r.ok || !r.data) {
      error.value = r.error || '打不开这一项';
      return;
    }
    item.value = r.data;
    posterSrc.value = r.data.primaryImageTag ? await app.imageUrl({ id: r.data.id, primaryImageTag: r.data.primaryImageTag }, 460) : '';
    if (r.data.type === 'Series') {
      const s = await window.echoemby.emby.seasons(id);
      seasons.value = s.ok ? s.data || [] : [];
      const first = seasons.value.find(x => x.childCount) || seasons.value[0];
      if (first) await loadEpisodes(first.id);
    } else if (r.data.type === 'Season') {
      await loadEpisodes(r.data.id, r.data.parentId || '');
    }
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
</script>

<template>
  <div class="page">
    <button class="back" @click="router.back()">←</button>
    <p v-if="playErr" class="err banner">{{ playErr }}</p>
    <p v-if="loading" class="muted">加载中…</p>
    <p v-else-if="error" class="err">{{ error }}</p>

    <template v-else-if="item">
      <section class="hero">
        <div class="poster">
          <img v-if="posterSrc" :src="posterSrc" alt="" />
          <div v-else class="nopost">{{ item.name.slice(0, 1) }}</div>
        </div>
        <div class="meta">
          <h1>{{ item.name }}</h1>
          <div class="line">
            <span v-if="item.seriesName">{{ item.seriesName }}</span>
            <span v-if="genres">{{ genres }}</span>
            <span v-if="premiered">{{ premiered }}</span>
            <span>{{ fmtRuntime(item.runTimeTicks) }}</span>
            <span v-if="item.childCount">{{ item.childCount }} 集</span>
          </div>
          <div v-if="rating || item.officialRating || item.studio" class="badges">
            <span v-if="rating" class="b rate">★ {{ rating }}</span>
            <span v-if="item.officialRating" class="b cert">{{ item.officialRating }}</span>
            <span v-if="item.studio" class="b studio">{{ item.studio }}</span>
          </div>
          <p class="overview">{{ item.overview || '暂无简介。' }}</p>
          <div class="actions">
            <button class="play" :disabled="!playableId || player.busy" @click="play()">
              <span class="tri"></span>{{ player.busy ? '准备中…' : item.userData?.playedPercentage ? '继续播放' : '播放' }}
            </button>
            <span v-if="player.busy" class="muted">正在协商播放…</span>
            <span v-else-if="player.state.playMethod" class="pm">{{ player.state.playMethod }}</span>
          </div>
        </div>
      </section>

      <section v-if="seasons.length" class="block">
        <h2>季</h2>
        <div class="seasons">
          <button v-for="s in seasons" :key="s.id" :class="{ on: s.id === seasonId }" class="sbtn" @click="loadEpisodes(s.id)">
            {{ s.name }}
          </button>
        </div>
      </section>

      <section v-if="episodes.length" class="block">
        <h2>{{ seasons.find(s => s.id === seasonId)?.name || '剧集' }}</h2>
        <div class="epi">
          <MediaCard v-for="e in episodes" :key="e.id" :item="e" variant="still" :width="286" @play="play($event.id)" />
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.page {
  height: 100%;
  overflow-y: auto;
  padding: calc(var(--titlebar-h) + 16px) clamp(26px, 3vw, 44px) 48px calc(var(--nav-w) + 26px);
  position: relative;
  transition: padding var(--rail-dur) var(--rail-ease);
}
.back {
  position: absolute;
  top: calc(var(--titlebar-h) + 6px);
  left: calc(var(--nav-w) + 8px);
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
  color: var(--text-dim);
  transition: background var(--hov) var(--ease), color var(--hov) var(--ease), transform var(--hov) var(--ease-out), left var(--rail-dur) var(--rail-ease);
}
.back:hover {
  background: var(--ink);
  color: var(--on-ink);
  transform: translateX(-2px);
}
.hero {
  display: flex;
  gap: 26px;
  margin-top: 18px;
}
.poster {
  width: 232px;
  flex: none;
  aspect-ratio: 2 / 3;
  border-radius: var(--r-tile);
  overflow: hidden;
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
}
.poster img,
.nopost {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.nopost {
  display: grid;
  place-items: center;
  font-size: 62px;
  font-weight: 700;
  /* Same letter, same plate, same opaque token as both card placeholders: an alpha glyph here
     composited to 2.1:1 against its own gradient, and this letter is the only identifier when the
     server has no art for the item. */
  color: var(--text-faint);
  background: linear-gradient(150deg, var(--bg), var(--bg-elev-2));
}
.meta {
  min-width: 0;
  padding-top: 6px;
}
h1 {
  margin: 0 0 8px;
  font-size: 26px;
  font-weight: 650;
  letter-spacing: -0.2px;
  color: var(--text);
}
.line {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-dim);
  margin-bottom: 14px;
  font-variant-numeric: tabular-nums;
}
.badges {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 15px;
}
.b {
  display: inline-flex;
  align-items: center;
  padding: 2px 9px;
  border-radius: 999px;
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
.studio {
  color: var(--text-dim);
  background: var(--chip);
}
.overview {
  color: var(--text-dim);
  font-size: 14px;
  line-height: 1.65;
  max-width: 640px;
  margin: 0 0 20px;
}
.actions {
  display: flex;
  align-items: center;
  gap: 14px;
}
.play {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 11px 22px;
  border-radius: 999px;
  background: var(--ink);
  color: var(--on-ink);
  font-weight: 600;
  box-shadow: 0 10px 26px rgba(18, 18, 34, 0.24);
  transition: transform var(--hov) var(--ease-out), box-shadow var(--hov) var(--ease), opacity var(--hov) var(--ease);
}
.play:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 14px 32px rgba(18, 18, 34, 0.3);
}
.play:active:not(:disabled) {
  transform: scale(0.97);
}
.play:disabled {
  opacity: 0.45;
}
.tri {
  width: 0;
  height: 0;
  border-left: 9px solid var(--on-ink);
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
}
.pm {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-dim);
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  padding: 3px 9px;
  background: var(--bg-elev);
}
.muted {
  color: var(--text-dim);
  font-weight: 500;
  font-size: 13px;
}
.err {
  color: var(--danger);
}
.banner {
  margin: 0 0 12px;
}
.block {
  margin-top: 30px;
}
h2 {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.2px;
  margin: 0 0 13px;
  color: var(--text);
}
.seasons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.sbtn {
  padding: 7px 14px;
  border-radius: 999px;
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
  font-size: 13.5px;
  color: var(--text-dim);
  transition: background var(--hov) var(--ease), color var(--hov) var(--ease),
    border-color var(--hov) var(--ease);
}
.sbtn:hover {
  color: var(--text);
  border-color: var(--line-strong);
}
.sbtn.on {
  background: var(--chip-hi);
  border-color: var(--line-strong);
  color: var(--text);
  font-weight: 600;
}
.epi {
  display: flex;
  gap: 14px;
  overflow-x: auto;
  padding-bottom: 10px;
}
</style>
