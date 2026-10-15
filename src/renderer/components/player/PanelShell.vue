<script setup lang="ts">
import { usePlayerStore, type PanelKind } from '../../stores/player';

/** The chrome every right drawer shares: a title, a close button, a scrollable body. */
const props = defineProps<{ kind: PanelKind; title: string }>();
const player = usePlayerStore();
void props;
</script>

<template>
  <aside class="pl-panel" role="dialog" :aria-label="title">
    <div class="pl-head">
      <span class="pl-title">{{ title }}</span>
      <button class="ib" title="关闭" @click="player.closePanel()">
        <svg viewBox="0 0 24 24" width="17" height="17"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" fill="none" /></svg>
      </button>
    </div>
    <div class="pl-body no-drag">
      <slot />
    </div>
  </aside>
</template>

<style scoped>
.ib {
  min-width: 34px;
  height: 34px;
  padding: 0 8px;
  border-radius: var(--radius);
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
