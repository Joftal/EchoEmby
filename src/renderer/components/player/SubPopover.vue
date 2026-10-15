<script setup lang="ts">
import { ref } from 'vue';
import { ChevronLeft } from 'lucide-vue-next';
import { usePlayerStore } from '../../stores/player';
import { useSheetOverflow } from './useSheetOverflow';

/** The second level of a sheet (画面比例 inside 画面, 显示设置 inside 弹幕). It replaces the sheet that called
 *  it rather than unfolding beside it, where it used to run out of window, so the card is sized by this
 *  list and a long one scrolls inside it. */
defineProps<{ title: string }>();
const player = usePlayerStore();
const bodyEl = ref<HTMLElement | null>(null);
const { more, measure } = useSheetOverflow(bodyEl);
</script>

<template>
  <div class="pl-sub" :class="{ 'is-more': more }" role="dialog" :aria-label="title">
    <div class="pl-head">
      <button class="ib" title="返回" @click="player.toggleSub('')">
        <ChevronLeft :size="18" />
      </button>
      <span class="pl-title">{{ title }}</span>
    </div>
    <div ref="bodyEl" class="pl-body no-drag" @scroll.passive="measure">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.ib {
  width: 30px;
  height: 30px;
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
