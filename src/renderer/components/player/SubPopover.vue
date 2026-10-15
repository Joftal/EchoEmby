<script setup lang="ts">
import { usePlayerStore } from '../../stores/player';

/** The second sheet the reference unfolds beside a menu (画面比例 inside 画面, 显示设置 inside 弹幕). It is
 *  positioned against the panel it came from, and flips to the right when the window is too narrow for
 *  it to fit on the left. */
const props = defineProps<{ title: string; flip?: boolean; wide?: number }>();
const player = usePlayerStore();
const style = props.wide ? { '--pl-w': `${props.wide}px` } : undefined;
</script>

<template>
  <div class="pl-sub" :class="{ flip: props.flip }" :style="style" role="dialog" :aria-label="props.title">
    <div class="pl-head">
      <button class="ib" title="返回" @click="player.toggleSub('')">
        <svg viewBox="0 0 24 24" width="16" height="16"><path d="M14.5 5.5L8 12l6.5 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none" /></svg>
      </button>
      <span class="pl-title">{{ props.title }}</span>
    </div>
    <div class="pl-body no-drag">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.ib {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  color: var(--pl-dim);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background var(--hov) var(--ease), color var(--hov) var(--ease);
}
.ib:hover {
  background: var(--pl-glass-hi);
  color: var(--pl-text);
}
</style>
