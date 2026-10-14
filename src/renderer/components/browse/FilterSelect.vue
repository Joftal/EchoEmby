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
    /** For a control whose value already names itself (a season), the label only fills the empty pill. */
    bare?: boolean;
    /** A mode always carries a value — the sort key, the season — so it must never read as a filter being on. */
    neutral?: boolean;
  }>(),
  { multi: false, searchable: false, bare: false, neutral: false },
);
const emit = defineEmits<{ (e: 'update:modelValue', v: string | string[]): void }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
const term = ref('');
const more = ref(false);

/** One panel at a time: a mouse pointer that lands on another pill closes this one on its own, but
 *  Enter on a keyboard fires no pointer, so two controls tabbed in sequence would stack two panels. */
const self = { close: () => (open.value = false) };

const chosen = computed<string[]>(() => (Array.isArray(props.modelValue) ? props.modelValue : props.modelValue ? [props.modelValue] : []));
const shown = computed(() =>
  term.value.trim() ? props.options.filter(o => o.label.toLowerCase().includes(term.value.trim().toLowerCase())) : props.options,
);

/** The pill carries the answer, not a count of it: whatever is picked, spelled out on one line. */
const valueText = computed(() => chosen.value.map(v => props.options.find(o => o.value === v)?.label || v).join(' · '));
const engaged = computed(() => chosen.value.length > 0 && !props.neutral);

/** 不限 is a chip like any other, except it answers by emptying the list instead of adding itself. */
const chipList = computed(() => (props.multi ? [{ value: '', label: '不限' }, ...shown.value] : shown.value));
function isPicked(value: string): boolean {
  return value ? chosen.value.includes(value) : chosen.value.length === 0;
}

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

function pick(value: string): void {
  if (value) toggle(value);
  else clear();
}

/** A list that runs out mid-chip looks broken; the fade below only appears while there is more below. */
function measure(): void {
  const el = listEl.value;
  if (el) more.value = el.scrollHeight - el.clientHeight - el.scrollTop > 4;
}

watch(open, async v => {
  if (!v) {
    term.value = '';
    return;
  }
  if (props.searchable) await nextTick();
  searchEl.value?.focus();
  measure();
});
watch([term, () => props.options], async () => {
  await nextTick();
  measure();
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
  <div ref="root" class="sel" :class="{ on: open, has: engaged }">
    <button class="pill" type="button" :aria-expanded="open" @click="open = !open">
      <span v-if="!bare || !chosen.length" class="lab">{{ label }}</span>
      <span v-if="valueText" class="val" :key="valueText">{{ valueText }}</span>
      <svg class="chev" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 9.5 12 15.5 18 9.5" />
      </svg>
    </button>

    <Transition name="pop">
      <div v-if="open" class="panel" :class="{ more }">
        <label v-if="searchable" class="find">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
            <path d="M11 4.6a6.4 6.4 0 1 0 0 12.8 6.4 6.4 0 0 0 0-12.8Z" />
            <path d="M19.4 19.4 15.6 15.6" />
          </svg>
          <input ref="searchEl" v-model="term" type="text" placeholder="搜索" spellcheck="false" />
        </label>

        <div ref="listEl" class="list" @scroll="measure">
          <button
            v-for="o in chipList"
            :key="o.value || '*'"
            class="chip"
            :class="{ picked: isPicked(o.value) }"
            type="button"
            :aria-pressed="multi ? isPicked(o.value) : undefined"
            @click="pick(o.value)"
          >
            <svg class="chk" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 12.6 9.6 17 19 7" />
            </svg>
            <span class="name">{{ o.label }}</span>
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

/* ---------- the pill: label, then whatever is picked, on one line that ellipses ---------- */
.pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 34px;
  max-width: 330px;
  padding: 0 11px 0 13px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-dim);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
  transition: color var(--hov) var(--ease), background var(--hov) var(--ease), border-color var(--hov) var(--ease), border-radius var(--hov) var(--ease),
    box-shadow var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.pill:hover {
  border-color: var(--line-strong);
  color: var(--text);
}
.pill:active {
  transform: scale(0.96);
  transition-duration: 0.1s;
}
.has .pill {
  background: var(--chip);
  border-color: transparent;
}
.on .pill {
  color: var(--text);
  background: var(--bg-elev);
  border-color: var(--line-strong);
  /* The panel hangs off this edge, so the two stop being separate shapes while it is open. */
  border-bottom-color: transparent;
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}
.lab {
  flex: none;
}
.val {
  min-width: 0;
  max-width: 214px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  animation: say 0.22s var(--ease-out);
}
@keyframes say {
  from {
    opacity: 0;
    transform: translate3d(0, 3px, 0);
  }
}
.chev {
  flex: none;
  transition: transform var(--hov) var(--ease-out), color var(--hov) var(--ease);
}
.sel.has .chev {
  color: var(--accent);
}
.on .chev {
  transform: rotate(180deg);
}

/* ---------- the panel: it shares the pill's bottom edge and unfolds out of it ---------- */
.panel {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: var(--z-modal);
  /* Hug the options, but never narrower than the pill: a panel that stops short of the pill's right
     corner would leave that squared-off corner hanging over nothing. The pill caps at 330px, so the
     panel's 340 cap still covers it at its widest. */
  width: max-content;
  min-width: 100%;
  max-width: 340px;
  margin-top: -1px;
  display: flex;
  flex-direction: column;
  max-height: 322px;
  padding: 6px;
  border-radius: 0 0 var(--r-row) var(--r-row);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
  transform-origin: top center;
}
.panel::after {
  content: '';
  position: absolute;
  left: 1px;
  right: 1px;
  bottom: 1px;
  height: 26px;
  border-radius: 0 0 var(--r-row) var(--r-row);
  background: linear-gradient(to bottom, transparent, var(--bg-elev) 72%);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--hov) var(--ease);
}
.panel.more::after {
  opacity: 1;
}
.find {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: none;
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
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 7px;
  padding: 3px 2px 1px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
/* One vocabulary for every picker: the answer is the dark chip, so a season list and a genre list are
   the same object. The box in front of each name only made you align two things to learn one bit. */
.chip {
  display: flex;
  align-items: center;
  height: 30px;
  padding: 0 12px;
  border: 0;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  text-align: left;
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
.chip:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.chip .name {
  max-width: 232px;
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
   slides the 17px it takes and the chip reads as the thing that changed. */
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
.none {
  flex: 1 1 100%;
  margin: 14px 0;
  text-align: center;
  font-size: 13px;
  color: var(--text-dim);
}

.pop-enter-active {
  transition: transform 0.26s var(--ease-out), opacity 0.14s var(--ease);
}
.pop-leave-active {
  transition: transform 0.16s var(--ease), opacity 0.12s var(--ease);
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: scaleY(0.6);
}
</style>
