<script setup lang="ts">
import { usePlayerStore } from '../../stores/player';

/** The chrome every menu shares: a small label, a scrollable body, and a slot for the submenu that
 *  unfolds beside it. The panel is positioned by the `.pl-menu` wrapper around the icon that opened it,
 *  which is what makes it land above that icon instead of floating wherever the last drawer was. */
const props = defineProps<{ title: string; anchor?: 'left' | 'right'; wide?: number }>();
const player = usePlayerStore();
const style = props.wide ? { '--pl-w': `${props.wide}px` } : undefined;
</script>

<template>
  <aside class="pl-panel" :class="`anchor-${props.anchor || 'right'}`" :style="style" role="dialog" :aria-label="props.title">
    <div class="pl-head">
      <span class="pl-title">{{ props.title }}</span>
      <button class="ib" title="关闭" @click="player.closePanel()">
        <svg viewBox="0 0 24 24" width="15" height="15"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none" /></svg>
      </button>
    </div>
    <div class="pl-body no-drag">
      <slot />
    </div>
    <slot name="sub" />
  </aside>
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
