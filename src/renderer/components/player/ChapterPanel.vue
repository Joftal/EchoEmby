<script setup lang="ts">
import { computed } from 'vue';
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

/** The reference names the span a row covers rather than only where it starts, so a row can be picked by
 *  the part of the film it is in. */
const span = (i: number): string => {
  const from = fmtClock(chapters.value[i].timeMs);
  const to = chapters.value[i + 1] ? fmtClock(chapters.value[i + 1].timeMs) : fmtClock(player.state.durationMs);
  return `${from} – ${to}`;
};
</script>

<template>
  <button v-for="(c, i) in chapters" :key="c.index" class="pl-row" :class="{ on: i === current }" @click="player.cmd({ action: 'chapter', value: i })">
    <span class="mark"></span>
    <span class="label">
      {{ c.title }}
      <span class="sub">{{ span(i) }}</span>
    </span>
    <span class="meta">{{ fmtClock(c.timeMs) }}</span>
  </button>
  <p v-if="!chapters.length" class="pl-empty">这个文件没有章节信息</p>
</template>
