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
    /** Set for a list whose entries are all the same shape (years, seasons, languages): the options lay
     *  out as a matrix of cells this wide instead of a cloud. A cloud of names of different lengths
     *  (genres, companies) has nothing to line up. */
    cell?: number;
    /** Columns the matrix asks for. It never exceeds the number of options, so a two-option list is two
     *  cells wide rather than a row of cells and a row of slack. */
    cols?: number;
    /** One option to a row. For a list whose entries share nothing but their shape - a season list, where
     *  「第 1 季」 sits next to 「第 4 季 · 最终季」 - a matrix would need a cell wide enough for the longest
     *  and a cloud wraps into uneven columns. */
    rows?: boolean;
  }>(),
  { multi: false, searchable: false, bare: false, neutral: false, cell: 0, cols: 4, rows: false },
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
const grid = computed(() => props.cell > 0);
/** The panel and the list take these two numbers and derive the whole box from them. */
const vars = computed(() => (grid.value ? { '--cell': `${props.cell}px`, '--cols': String(Math.min(props.cols, chipList.value.length)) } : undefined));
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

/** How far the panel may grow, and off which edge of the pill. A control parked near the bottom of the window
 *  would otherwise pour a 322px menu straight out of the screen, so the panel takes the room that is actually
 *  there and turns to the side that has more of it. */
const room = ref(322);
const up = ref(false);
function place(): void {
  const el = root.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const below = innerHeight - r.bottom - 14;
  const above = r.top - 14;
  up.value = below < 200 && above > below;
  room.value = Math.max(0, Math.round(up.value ? above : below));
}

watch(open, async v => {
  if (!v) {
    term.value = '';
    return;
  }
  place();
  // This watcher runs before the patch, so the panel is not in the document yet: measuring here always
  // answered "nothing to scroll" and a list that opened already overflowing - a season column does - showed
  // its last row cut in half with no fade over it. Only the search field needed the wait; the fade does too.
  await nextTick();
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

    <Transition name="bubble">
      <div v-if="open" class="panel" :class="{ more, grid, up }" :style="[vars, { '--room': `${room}px` }]">
        <label v-if="searchable" class="find">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
            <path d="M11 4.6a6.4 6.4 0 1 0 0 12.8 6.4 6.4 0 0 0 0-12.8Z" />
            <path d="M19.4 19.4 15.6 15.6" />
          </svg>
          <input ref="searchEl" v-model="term" type="text" placeholder="搜索" spellcheck="false" />
        </label>

        <div ref="listEl" class="list" :class="{ grid, rows }" @scroll="measure">
          <button
            v-for="o in chipList"
            :key="o.value || '*'"
            class="chip"
            :class="{ picked: isPicked(o.value) }"
            type="button"
            :aria-pressed="multi ? isPicked(o.value) : undefined"
            @click="pick(o.value)"
          >
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
  padding: 0 11px 0 12px;
  /* A rounded rectangle, not a stadium: the panel that pours out of its bottom edge rounds the same
     way, so trigger and menu read as one card rather than a capsule welded to a box. */
  border-radius: var(--radius);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-dim);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
  transition: color var(--hov) var(--ease), background var(--hov) var(--ease), border-color var(--hov) var(--ease), border-radius var(--hov) var(--ease),
    box-shadow var(--hov) var(--ease);
}
.pill:hover {
  border-color: var(--line-strong);
  color: var(--text);
}
/* No press scale on the trigger, unlike every other button in the app: the panel is welded to this box's
   bottom edge (it is positioned off `.sel`, which is never transformed), so a 0.96 squish lifts the edge the
   card hangs on by 0.7px and slides its face 3.3px sideways for ~140ms - which is exactly the moment the card
   is coming out of it or going back in. The pop is the press feedback here. */
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
  /* Four pixels up onto the pill, not one: opening drops the pill's own bottom border and bottom corners
     (`.on .pill`), so the card has to physically cover that edge or a hairline of it stays visible at the seam.
     The slide only ever reduces this overlap - 12px at the first frame, 4px on arrival - and nothing crosses
     the resting line any more, so 4px is the floor for the whole flight. */
  margin-top: -4px;
  display: flex;
  flex-direction: column;
  transform-origin: top left;
  /* The pop's whole vocabulary: 8px out of the pill, 6px back into it. Both are stated in pixels so a
     panel's content cannot change them, and both hang on the hinge below. */
  --pop: -8px;
  --back: -6px;
  max-height: min(322px, var(--room, 322px));
  padding: 6px;
  border-radius: 0 0 var(--radius) var(--radius);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
}
.panel::after {
  content: '';
  position: absolute;
  left: 1px;
  right: 1px;
  bottom: 1px;
  height: 26px;
  border-radius: 0 0 var(--radius) var(--radius);
  background: linear-gradient(to bottom, transparent, var(--bg-elev) 72%);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--hov) var(--ease);
}
.panel.more::after {
  opacity: 1;
}
/* Turned to the other edge: the same card, hinged off the pill's top instead of its bottom, so the seam moves
   with the hinge. The fade below does not. */
.panel.up {
  top: auto;
  bottom: 100%;
  margin: 0 0 -4px;
  transform-origin: bottom left;
  --pop: 8px;
  --back: 6px;
  border-radius: var(--radius) var(--radius) 0 0;
}
/* What the fade marks is the edge the list runs out at, and a list always starts at its first option - so on
   an upward panel the cut is still at the bottom, against the pill. Moving the fade to the top edge, which is
   what the hinge suggests, ghosted the season already picked and left the fourteen below it looking whole. */
.panel.up::after {
  border-radius: 0;
}
.on.up .pill {
  border-bottom-color: var(--line-strong);
  border-bottom-left-radius: var(--radius);
  border-bottom-right-radius: var(--radius);
  border-top-color: transparent;
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}
/* A matrix panel is exactly as wide as the cells it asked for plus their gaps and padding — nothing
   is left for the columns to drift into. */
.panel.grid {
  width: calc(var(--cols) * var(--cell) + (var(--cols) - 1) * 6px + 14px);
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
  /* No gutter: a scrollbar would eat the last column of a matrix, and the fade at the bottom already
     says there is more below. The wheel and the arrow keys still scroll it. */
  scrollbar-width: none;
}
/* A matrix: every option the same cell, so a year sits in the same slot whether or not it is picked,
   and the columns line up down the panel instead of ending in a ragged right edge. */
.list.grid {
  display: grid;
  grid-template-columns: repeat(var(--cols), var(--cell));
  gap: 7px 6px;
  padding: 3px 1px 1px;
}
/* Stacked: the list stops wrapping and every option takes the row, so the labels share one left edge and
   one right edge instead of ending wherever their text did. A column flex item stretches across the list by
   default, so the rows need no width of their own - the panel stays as wide as its longest season. */
.list.rows {
  flex-direction: column;
  flex-wrap: nowrap;
  gap: 3px;
  padding: 2px 1px 1px;
}
/* The row keeps the chip's height, colour and picked answer, and takes the search field's corner instead of
   the stadium: 8px is the only other radius used inside a panel, and a stack of 30px capsules welded edge to
   edge reads as pills in a box rather than one menu.
   `flex: none` is what keeps that height: a column flex item shrinks by default, so a seventeen-season list
   squeezed every row to its text height (measured 20.15px against the 30px a three-season list renders) and
   the one control showed two geometries depending on the title. Overflowing is the intended answer - the list
   scrolls and the fade says there is more below. */
.rows .chip {
  flex: none;
  border-radius: 8px;
}
.rows .chip .name {
  max-width: none;
}
/* No press scale on a row: 6% is 15px of horizontal travel on a long label and 2px on 「第 1 季」, which is
   the same content-dependence the panel's own pop was corrected for. The background is the press here. */
.rows .chip:active {
  transform: none;
}
/* One vocabulary for every picker: the answer is the dark chip, so a season list and a genre list are
   the same object. Nothing about a chip changes when it is picked — the tick that used to grow into it
   pushed every later option half a slot along, which is what made the list jump under the cursor. */
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
.grid .chip {
  min-width: 0;
  padding: 0 8px;
  justify-content: center;
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
  min-width: 0;
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
.none {
  flex: 1 1 100%;
  margin: 14px 0;
  text-align: center;
  font-size: 13px;
  color: var(--text-dim);
}
.grid .none {
  grid-column: 1 / -1;
}

/* The panel comes out of the edge it hangs on and stops there: 8px of travel, stated in pixels on the hinge
   (`--pop` flips sign for `.up`), in one direction only, with a fade that is done 90ms in. Measured frame by
   frame: -8, -5.4, -3.22, -2.03, -1.23, -0.66, -0.42, -0.2, -0.11, -0.03, -0.01, home at 197ms.

   One direction is the whole point. The card is fully opaque at 90ms, and the curve before this kept going:
   it carried the panel 1.30px past its resting line and then 0.79px back - 2.09px of CSS travel, 2.6 device px
   at this window's 1.25 ratio, so a line of text crossed a whole device pixel going up and another coming
   back - after the card had already looked arrived. Nothing had re-flowed (every row's position inside the
   panel is byte-identical on every frame of the flight), which is why it reads as the content itself shivering
   rather than as motion: the rows tick one pixel and settle again.

   A monotone curve has the opposite failure, and this file used to document it: parked. 8.8px of a 10px round
   trip went by t=70ms, the card then sat at +1.98px for 15ms and crept 1.2px across the following 78ms - a
   panel that stalls, then slides the last pixel. What the two failures leave is a tail that is both monotone
   and sub-pixel: from t=90ms this one has 0.55px CSS (0.69 device) of travel left and no reversal in it.

   No scale anywhere, on the panel or on the pill it hangs from, because a scale is a different animation on
   every title: the scale version tried on the way here grew the 3-season panel 57px wide while the 17-season
   one grew 82px wide and 82px tall, so one control had two energies and the difference was content the user
   never chose. The panels measured now - an 82x112.6px column, a 186.5x322px column, and 132px, 222.8px and
   340px browse panels - all trace the same series to within 0.02px.

   The name matters as much as the curve: `push`, `pop` and `flat` are the router's page-slide names, and
   base.css styles `.content .<name>-enter-active` as a whole window, so a panel named `pop` was pulled to
   `inset: 0` and shoved across the viewport for one page duration before snapping back under its button.

   `will-change` is scoped to the two moving states rather than left on the panel: the layer is only worth
   promoting while something is actually moving on it. */
.bubble-enter-active {
  transition:
    transform 0.2s linear(0, 0.55 14%, 0.8 28%, 0.92 42%, 0.975 58%, 0.996 74%, 1 90%),
    opacity 0.09s ease-out;
  will-change: transform;
}
.bubble-enter-from {
  opacity: 0;
  transform: translate3d(0, var(--pop), 0);
}
/* Both directions are transitions rather than one animation and one transition: a transition starts from the
   value the element actually holds, so pressing the pill mid-pop reverses from wherever the card is instead of
   dropping to its resting line first. That drop was measured as a 3.9px step at t=64ms when the enter was an
   animation, whose fill held a value no transition could see. */
.bubble-leave-active {
  transition: transform 0.11s var(--ease), opacity 0.11s var(--ease);
  will-change: transform;
}
.bubble-leave-to {
  opacity: 0;
  transform: translate3d(0, var(--back), 0);
}
</style>
