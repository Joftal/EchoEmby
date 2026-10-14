<script lang="ts">
/** Which panel is open, across every instance of this control. It has to live outside setup(), or each
 *  control gets its own copy and the shared answer means nothing. */
let opened: { close(): void } | null = null;
</script>

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

/** One panel at a time: a mouse pointer that lands on another pill closes this one on its own, but
 *  Enter on a keyboard fires no pointer, so two controls tabbed in sequence would stack two panels. */
const self = { close: () => (open.value = false) };

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

/** 不限 is a chip like any other, except it answers by emptying the list instead of adding itself. */
const chipList = computed(() => (props.multi ? [{ value: '', label: '不限' }, ...shown.value] : shown.value));
function isPicked(value: string): boolean {
  return value ? chosen.value.includes(value) : chosen.value.length === 0;
}
function pick(value: string): void {
  if (value) toggle(value);
  else clear();
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
    opened?.close();
    opened = self;
    document.addEventListener('pointerdown', onDocPointer, true);
    window.addEventListener('keydown', onKey, true);
  } else {
    if (opened === self) opened = null;
    document.removeEventListener('pointerdown', onDocPointer, true);
    window.removeEventListener('keydown', onKey, true);
  }
});
onBeforeUnmount(() => {
  if (opened === self) opened = null;
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
      <div v-if="open" class="panel" :class="{ wide, multi }">
        <label v-if="searchable" class="find">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
            <path d="M11 4.6a6.4 6.4 0 1 0 0 12.8 6.4 6.4 0 0 0 0-12.8Z" />
            <path d="M19.4 19.4 15.6 15.6" />
          </svg>
          <input ref="searchEl" v-model="term" type="text" placeholder="搜索" spellcheck="false" />
        </label>

        <div class="list" :class="{ chips: multi }">
          <button
            v-for="o in chipList"
            :key="o.value || '*'"
            class="opt"
            :class="[multi ? 'chip' : 'row', { picked: isPicked(o.value) }]"
            type="button"
            :aria-pressed="multi ? isPicked(o.value) : undefined"
            @click="pick(o.value)"
          >
            <svg
              v-if="multi"
              class="chk"
              viewBox="0 0 24 24"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              stroke-width="3.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M5 12.6 9.6 17 19 7" />
            </svg>
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
/* Chips need the extra measure: a wrapped cloud reads its labels in two columns, while the row list
   only ever needed one. */
.panel.multi {
  width: 300px;
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
/* Multi-choice is a chip cloud, not a checklist: the box in front of every name made you align two
   things (box, label) to learn one bit, and a year list of 56 boxes is a wall. A chip is the bit. */
.list.chips {
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 7px;
  padding: 3px 2px 1px;
}
.opt {
  display: flex;
  align-items: center;
  border: 0;
  font-size: 13px;
  text-align: left;
  color: var(--text);
}
.opt:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.row {
  gap: 9px;
  width: 100%;
  padding: 8px 9px;
  border-radius: 9px;
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
.chip {
  height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  font-weight: 600;
  color: var(--text-dim);
  background: var(--chip);
  transition: color var(--hov) var(--ease), background var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.chip:hover {
  color: var(--text);
  background: var(--chip-hi);
}
.chip:active {
  transform: scale(0.94);
  transition-duration: 0.1s;
}
.chip .name {
  /* A genre is short, but a company name typed by nobody's hand is not. */
  max-width: 168px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip.picked {
  color: var(--on-ink);
  background: var(--ink);
}
.chip.picked:hover {
  color: var(--on-ink);
}
/* The tick grows into the chip rather than appearing in a box that was waiting for it, so the label
   slides the 17px it takes and the pill reads as the thing that changed. */
.chk {
  width: 0;
  flex: none;
  opacity: 0;
  transition: width 0.22s var(--ease-out), margin-right 0.22s var(--ease-out), opacity 0.14s var(--ease);
}
.picked .chk {
  width: 12px;
  margin-right: 5px;
  opacity: 1;
}
/* The pill's own chevron turns accent when something is picked, and that rule reaches every svg in
   the subtree — a blue tick on an ink chip is 3:1 and reads as mud, so the tick keeps the chip's own
   text colour. */
.chip.picked .chk {
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
.list.chips .none {
  flex: 1 1 100%;
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
