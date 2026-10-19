<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import type { Account } from '../../shared/types';
import { accountName } from '../lib/format';
import EmbyMark from './EmbyMark.vue';

const props = defineProps<{
  account: Account;
  active?: boolean;
  editable?: boolean;
  counts?: { movies: number; series: number } | null;
}>();
const emit = defineEmits<{ (e: 'select'): void; (e: 'edit'): void; (e: 'remove'): void }>();

const armed = ref(false);
let armTimer: number | null = null;

const shown = computed(() => accountName(props.account));
// The totals arrive after the card paints, so an empty line keeps its height instead of nudging the row.
const libs = computed(() => {
  const c = props.counts;
  if (!c) return '';
  const parts: string[] = [];
  if (c.movies > 0) parts.push(`电影 ${c.movies} 部`);
  if (c.series > 0) parts.push(`电视剧 ${c.series} 部`);
  return parts.join(' · ');
});
const used = computed(() => {
  const ms = Date.now() - props.account.lastUsed;
  const day = 86_400_000;
  if (ms < 3_600_000) return '刚刚用过';
  if (ms < day) return '今天用过';
  const n = Math.round(ms / day);
  return n === 1 ? '昨天用过' : `${n} 天前用过`;
});

/** A destructive button asks once and forgets itself, so no dialog is needed for one row. */
function onRemove(): void {
  if (!armed.value) {
    armed.value = true;
    armTimer = window.setTimeout(() => (armed.value = false), 4000);
    return;
  }
  if (armTimer !== null) window.clearTimeout(armTimer);
  emit('remove');
}

onBeforeUnmount(() => {
  if (armTimer !== null) window.clearTimeout(armTimer);
});
</script>

<template>
  <div class="card" :class="{ on: active }">
    <button class="main" type="button" @click="emit('select')">
      <span class="av"><EmbyMark :size="21" /></span>
      <span class="who">
        <b>{{ shown }}</b>
        <i>{{ libs }}</i>
      </span>
      <em v-if="active" class="tag">使用中</em>
    </button>

    <div class="foot">
      <span class="used">{{ used }}</span>
      <div v-if="editable" class="acts">
        <button class="mini" type="button" @click="emit('edit')">编辑</button>
        <button class="mini danger" :class="{ armed }" type="button" @click="onRemove">{{ armed ? '确认移除' : '移除' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.card {
  border-radius: var(--r-tile);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
  transition: border-color var(--hov) var(--ease), box-shadow var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.card:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow);
}
.card.on {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.main {
  display: flex;
  align-items: center;
  gap: 13px;
  width: 100%;
  padding: 14px 16px 9px;
  text-align: left;
  color: var(--text);
}
.av {
  flex: none;
  width: 38px;
  height: 38px;
  border-radius: var(--r-row);
  display: grid;
  place-items: center;
  background: var(--brand);
  color: var(--on-ink);
}
.who {
  min-width: 0;
  flex: 1;
  display: block;
}
.who b {
  display: block;
  font-size: 14px;
  font-weight: 620;
  letter-spacing: -0.1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.who i {
  display: block;
  margin-top: 3px;
  /* 13px in a pinned 18px box, like the sidebar's account line: at 12px a CJK glyph loses its topmost
     stroke row. The fixed box also keeps a card whose counts have not arrived the same height as one that has. */
  min-height: 18px;
  line-height: 18px;
  font-style: normal;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag {
  flex: none;
  display: inline-block;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--chip);
  font-size: 13px;
  font-weight: 600;
  font-style: normal;
  color: var(--text);
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 16px 13px;
}
.used {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-dim);
}
.acts {
  display: flex;
  gap: 8px;
}
.mini {
  padding: 7px 13px;
  border-radius: var(--radius);
  background: var(--chip);
  font-size: 13px;
  color: var(--text);
  transition: background var(--hov) var(--ease), color var(--hov) var(--ease);
}
.mini:hover {
  background: var(--chip-hi);
}
.danger {
  color: var(--danger);
}
.danger.armed {
  background: var(--danger);
  color: #fff;
}
</style>
