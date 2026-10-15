<script setup lang="ts">
import { ChevronLeft } from 'lucide-vue-next';
import { usePlayerStore } from '../../stores/player';

/** The second level of a sheet (画面比例 inside 画面, 显示设置 inside 弹幕). It drills in over the sheet that
 *  called it, sharing its box and its bottom edge, so a long list simply grows upward instead of running
 *  out of window to the left. */
defineProps<{ title: string }>();
const player = usePlayerStore();
</script>

<template>
  <div class="pl-sub" role="dialog" :aria-label="title">
    <div class="pl-head">
      <button class="ib" title="返回" @click="player.toggleSub('')">
        <ChevronLeft :size="22" />
      </button>
      <span class="pl-title">{{ title }}</span>
    </div>
    <div class="pl-body no-drag">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.ib {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  color: var(--pl-dim);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background var(--hov) var(--ease), color var(--hov) var(--ease);
}
.ib svg {
  display: block;
}
.ib:hover {
  background: var(--pl-glass-hi);
  color: var(--pl-text);
}
</style>
