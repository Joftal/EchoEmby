<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next';
import { usePlayerStore } from '../../stores/player';

/** A row that drills into a second-level sheet. It lights up while its own sheet is the one on screen,
 *  the way the reference keeps 画面比例 blue while the ratio list is open. */
const props = defineProps<{ name: string; label: string; value?: string }>();
const player = usePlayerStore();
</script>

<template>
  <button class="pl-row" :class="{ on: player.sub === props.name }" @click="player.toggleSub(props.name)">
    <span class="mark"></span>
    <span class="label">{{ props.label }}</span>
    <span v-if="props.value" class="meta">{{ props.value }}</span>
    <span class="go">
      <ChevronRight :size="18" />
    </span>
  </button>
</template>
