<script setup lang="ts">
import { X } from 'lucide-vue-next';
import { usePlayerStore } from '../../stores/player';

/** The chrome every sheet shares: a small label, a scrollable body, and a slot for the second level that
 *  drills in over it. The sheet itself is placed by the bar - it is the bar's topmost block, so it rises
 *  from the bottom of the window no matter which entry called it. */
defineProps<{ title: string }>();
const player = usePlayerStore();
</script>

<template>
  <aside class="pl-panel" role="dialog" :aria-label="title">
    <div class="pl-head">
      <span class="pl-title">{{ title }}</span>
      <button class="ib" title="关闭" @click="player.closePanel()">
        <X :size="20" />
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
