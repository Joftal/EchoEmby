<script setup lang="ts">
import { usePlayerStore } from '../../stores/player';

/** A row that unfolds a submenu beside the panel it sits in. It lights up while its own submenu is the
 *  one on screen, the way the reference keeps 画面比例 blue while the ratio list is open. */
const props = defineProps<{ name: string; label: string; value?: string }>();
const player = usePlayerStore();
</script>

<template>
  <button class="pl-row" :class="{ on: player.sub === props.name }" @click="player.toggleSub(props.name)">
    <span class="mark"></span>
    <span class="label">{{ props.label }}</span>
    <span v-if="props.value" class="meta">{{ props.value }}</span>
    <span class="go">
      <svg viewBox="0 0 24 24" width="15" height="15"><path d="M9 5.5L15.5 12 9 18.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none" /></svg>
    </span>
  </button>
</template>
