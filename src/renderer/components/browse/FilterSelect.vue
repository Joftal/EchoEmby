<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    label: string;
    options: { value: string; label: string }[];
    modelValue: string | string[];
    multi?: boolean;
    searchable?: boolean;
    /** A company list can hold a hundred names; the panel still only shows what fits. */
    wide?: boolean;
  }>(),
  { multi: false, searchable: false, wide: false },
);
const emit = defineEmits<{ (e: 'update:modelValue', v: string | string[]): void }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);
const term = ref('');

const chosen = computed<string[]>(() => (Array.isArray(props.modelValue) ? props.modelValue : props.modelValue ? [props.modelValue] : []));
const shown = computed(() =>
  term.value.trim() ? props.options.filter(o => o.label.toLowerCase().includes(term.value.trim().toLowerCase())) : props.options,
);

/** The pill says what is picked, not what could be picked: an unfiltered control just names itself. */
const summary = computed(() => {
  if (!chosen.value.length) return '';
  const labels = chosen.value.map(v => props.options.find(o => o.value === v)?.label || v);
  return labels.length <= 2 ? labels.join('、') : `${labels[0]} 等 ${labels.length} 项`;
});

function toggle(value: string): void {
  if (!props.multi) {
    emit('update:modelValue', props.modelValue === value ? '' : value);
    open.value = false;
    return;
  }
  const next = chosen.value.includes(value) ? chosen.value.filter(x => x !== value) : [...chosen.value, value];
  emit('update:modelValue', next);
}

function clear(): void {
  emit('update:modelValue', props.multi ? [] : '');
}

watch(open, async v => {
  if (!v) {
    term.value = '';
    return;
  }
  if (props.searchable) {
    await nextTick();
    searchEl.value?.focus();
  }
});

function onDocPointer(e: PointerEvent): void {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false;
}
function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  // The title bar owns Escape globally; a panel that is open has to take it first and stop it there.
  e.stopPropagation();
  open.value = false;
}
watch(open, v => {
  if (v) {
    document.addEventListener('pointerdown', onDocPointer, true);
    window.addEventListener('keydown', onKey, true);
  } else {
    document.removeEventListener('pointerdown', onDocPointer, true);
    window.removeEventListener('keydown', onKey, true);
  }
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer, true);
  window.removeEventListener('keydown', onKey, true);
});
</script>

<template>
  <div ref="root" class="sel" :class="{ on: open, has: chosen.length }">
    <button class="pill" type="button" :aria-expanded="open" @click="open = !open">
      <span class="txt">{{ summary || label }}</span>
      <span v-if="multi && chosen.length" class="num">{{ chosen.length }}</span>
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 9.5 12 15.5 18 9.5" />
      </svg>
    </button>

    <Transition name="pop">
      <div v-if="open" class="panel" :class="{ wide }">
        <label v-if="searchable" class="find">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
            <path d="M11 4.6a6.4 6.4 0 1 0 0 12.8 6.4 6.4 0 0 0 0-12.8Z" />
            <path d="M19.4 19.4 15.6 15.6" />
          </svg>
          <input ref="searchEl" v-model="term" type="text" placeholder="搜索" spellcheck="false" />
        </label>

        <div class="list">
          <button
            v-for="o in shown"
            :key="o.value"
            class="row"
            :class="{ picked: chosen.includes(o.value) }"
            type="button"
            @click="toggle(o.value)"
          >
            <span v-if="multi" class="box">
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12.6 9.6 17 19 7" />
              </svg>
            </span>
            <span class="name">{{ o.label }}</span>
            <svg
              v-if="!multi && chosen.includes(o.value)"
              class="tick"
              viewBox="0 0 24 24"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              stroke-width="2.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M5 12.6 9.6 17 19 7" />
            </svg>
          </button>
          <p v-if="!shown.length" class="none">没有匹配项</p>
        </div>

        <div v-if="multi && chosen.length" class="foot">
          <span>{{ chosen.length }} 项已选</span>
          <button type="button" @click="clear">清空</button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.sel {
  position: relative;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 12px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-dim);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
  transition: color var(--hov) var(--ease), border-color var(--hov) var(--ease), background var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.pill:hover {
  color: var(--text);
  border-color: var(--line-strong);
}
.pill:active {
  transform: scale(0.96);
  transition-duration: 0.1s;
}
.has .pill {
  color: var(--text);
}
.on .pill {
  color: var(--text);
  border-color: var(--line-strong);
}
.sel.has svg {
  color: var(--accent);
}
.txt {
  max-width: 132px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.num {
  display: grid;
  place-items: center;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 700;
  color: var(--on-ink);
  background: var(--ink);
}
.on .pill svg {
  transform: rotate(180deg);
}
.pill svg {
  transition: transform var(--hov) var(--ease-out);
  flex: none;
}

.panel {
  position: absolute;
  top: calc(100% + 7px);
  left: 0;
  z-index: var(--z-modal);
  width: 216px;
  display: flex;
  flex-direction: column;
  max-height: 322px;
  padding: 6px;
  border-radius: var(--r-row);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
}
.panel.wide {
  width: 268px;
}
.find {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 2px 4px 6px;
  padding: 0 8px;
  height: 30px;
  border-radius: 8px;
  color: var(--text-dim);
  background: var(--chip);
  transition: box-shadow var(--hov) var(--ease);
}
.find:focus-within {
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.find input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: none;
  font-size: 13px;
  color: var(--text);
}
.list {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px 9px;
  border-radius: 9px;
  font-size: 13px;
  text-align: left;
  color: var(--text);
  transition: background var(--hov) var(--ease);
}
.row:hover {
  background: var(--chip);
}
.row .name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row.picked {
  font-weight: 650;
}
.box {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  flex: none;
  border-radius: 5px;
  border: 1.5px solid var(--line-strong);
  color: transparent;
  transition: background var(--hov) var(--ease), border-color var(--hov) var(--ease), color var(--hov) var(--ease);
}
.picked .box {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-ink);
}
.tick {
  color: var(--accent);
  flex: none;
}
.none {
  margin: 14px 0;
  text-align: center;
  font-size: 13px;
  color: var(--text-dim);
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 5px;
  padding: 8px 9px 2px;
  border-top: 1px solid var(--line);
  font-size: 13px;
  color: var(--text-dim);
}
.foot button {
  font-size: 13px;
  font-weight: 650;
  color: var(--accent);
}

.pop-enter-active {
  transition: opacity 0.16s var(--ease), transform 0.22s var(--ease-out);
}
.pop-leave-active {
  transition: opacity 0.13s var(--ease), transform 0.16s var(--ease);
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translate3d(0, -6px, 0) scale(0.97);
}
</style>
