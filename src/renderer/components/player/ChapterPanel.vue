<script setup lang="ts">
import { computed } from 'vue';
import PanelShell from './PanelShell.vue';
import { usePlayerStore } from '../../stores/player';
import { fmtClock } from '../../lib/format';

const player = usePlayerStore();
const chapters = computed(() => player.media.chapters);

/** The chapter a position falls inside: mpv's own `chapter` property would say the same, but the list is
 *  already here and one comparison is cheaper than another observed property. */
const current = computed(() => {
  const at = player.state.positionMs;
  let i = -1;
  for (let k = 0; k < chapters.value.length; k++) if (chapters.value[k].timeMs <= at) i = k;
  return i;
});
</script>

<template>
  <PanelShell kind="chapters" title="章节">
    <button v-for="(c, i) in chapters" :key="c.index" class="pl-row" :class="{ on: i === current }" @click="player.cmd({ action: 'chapter', value: i })">
      <span class="label">{{ c.title }}</span>
      <span class="meta">{{ fmtClock(c.timeMs) }}</span>
    </button>
    <p v-if="!chapters.length" class="pl-empty">这个文件没有章节信息</p>
  </PanelShell>
</template>
