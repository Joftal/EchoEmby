<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import PanelShell from './PanelShell.vue';
import { usePlayerStore } from '../../stores/player';
import { episodePosition, fmtRuntime, isPositionOnlyName } from '../../lib/format';
import type { LibraryItem } from '../../../shared/types';

const player = usePlayerStore();

const seriesId = computed(() => player.session?.seriesId || '');
const seasonId = computed(() => player.session?.seasonId || '');
const itemId = computed(() => player.session?.itemId || '');

const seasons = ref<LibraryItem[]>([]);
const episodes = ref<LibraryItem[]>([]);
const active = ref('');
const loading = ref(false);

/** The panel opens on the season being played, so the list never starts on 第 1 季 while 第 3 季 is on screen. */
async function loadSeasons(): Promise<void> {
  if (!seriesId.value || seasons.value.length) return;
  const r = await window.echoemby.emby.seasons(seriesId.value);
  if (!r.ok) return;
  seasons.value = r.data || [];
  active.value = seasonId.value && seasons.value.some(s => s.id === seasonId.value) ? seasonId.value : seasons.value[0]?.id || '';
}

async function loadEpisodes(sid: string): Promise<void> {
  if (!seriesId.value || !sid) return;
  active.value = sid;
  const r = await window.echoemby.emby.episodes({ seriesId: seriesId.value, seasonId: sid });
  if (r.ok) episodes.value = r.data || [];
  // A 104-row list that opens on 第 1 集 while 第 104 集 is on screen asks the user to hunt for the row they
  // already know they want, so the list opens where the playhead is. The list's own scroller is moved by hand:
  // scrollIntoView also scrolls every ancestor that can scroll, which dragged the whole overlay 18px up.
  await nextTick();
  const body = document.querySelector('.pl-panel .pl-body');
  const row = body?.querySelector('.pl-row.on');
  if (body && row) {
    const b = body.getBoundingClientRect(), e = row.getBoundingClientRect();
    body.scrollTop += e.top + e.height / 2 - (b.top + b.height / 2);
  }
}

/** immediate: the session is already loaded by the time this drawer mounts, so a watcher that only fires on
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
}, { immediate: true });

async function choose(id: string): Promise<void> {
  if (id === itemId.value) return;
  await player.play(id);
}

const titleOf = (ep: LibraryItem): string => (isPositionOnlyName(ep.name) ? '' : ep.name);
</script>

<template>
  <PanelShell kind="episodes" title="选集">
    <p v-if="!seriesId" class="pl-empty">这不是剧集条目</p>
    <template v-else>
      <div v-if="seasons.length > 1" class="pl-chips">
        <button v-for="s in seasons" :key="s.id" class="pl-chip" :class="{ on: active === s.id }" @click="loadEpisodes(s.id)">
          {{ s.indexNumber != null ? `第 ${s.indexNumber} 季` : s.name }}
        </button>
      </div>

      <p v-if="loading" class="pl-empty">载入中…</p>
      <button v-for="ep in episodes" :key="ep.id" class="pl-row" :class="{ on: ep.id === itemId }" @click="choose(ep.id)">
        <span class="num">{{ ep.indexNumber ?? '' }}</span>
        <span class="label">
          <template v-if="titleOf(ep)">{{ titleOf(ep) }}</template>
          <template v-else>{{ episodePosition(ep.parentIndexNumber, ep.indexNumber) }}</template>
        </span>
        <span class="meta">{{ fmtRuntime(ep.runTimeTicks) }}</span>
      </button>
      <p v-if="!loading && !episodes.length" class="pl-empty">这一季没有返回条目</p>
    </template>
  </PanelShell>
</template>

<style scoped>
.num {
  width: 26px;
  flex: none;
  font-variant-numeric: tabular-nums;
  color: var(--pl-faint);
}
.on .num {
  color: var(--pl-hi);
}
</style>
