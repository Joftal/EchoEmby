<script setup lang="ts">
import { ref } from 'vue';
import { X } from 'lucide-vue-next';
import { usePlayerStore } from '../../stores/player';
import { useSheetOverflow } from './useSheetOverflow';

/** The chrome every sheet shares: a small label, a scrollable body, and a slot for the second level that
 *  takes the card over. The sheet itself is placed by the bar - it is the bar's topmost block, so it rises
 *  from the bottom of the window no matter which entry called it. */
defineProps<{ title: string }>();
const player = usePlayerStore();
const bodyEl = ref<HTMLElement | null>(null);
const { more, measure } = useSheetOverflow(bodyEl);
</script>

<template>
  <aside class="pl-panel" :class="{ 'is-more': more }" role="dialog" :aria-label="title">
    <div class="pl-head">
      <span class="pl-title">{{ title }}</span>
      <button class="ib" title="关闭" @click="player.closePanel()">
        <X :size="18" />
      </button>
    </div>
    <div ref="bodyEl" class="pl-body no-drag" @scroll.passive="measure">
      <slot />
    </div>
    <slot name="sub" />
  </aside>
</template>

<style scoped>
/* The head is a label and a way out, not a title bar: 30px keeps it under the row it sits above so the
   card's first line reads as content rather than as chrome. */
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
