<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
import { X } from 'lucide-vue-next';
import ChapterPanel from './ChapterPanel.vue';
import DanmakuPanel from './DanmakuPanel.vue';
import EpisodePanel from './EpisodePanel.vue';
import QualityPanel from './QualityPanel.vue';
import SpeedPanel from './SpeedPanel.vue';
import TrackPanel from './TrackPanel.vue';
import { usePlayerStore, type PanelKind } from '../../stores/player';
import { useSheetGeometry } from './useSheetGeometry';

/** The one card every menu is drawn into.
 *
 *  It exists so the card can travel. Eight sibling components that each owned their own box could only
 *  ever appear and disappear, which is what the bar looked like before: whichever button you pressed, the
 *  same centred bubble blinked out and a new one blinked in - and it blinked in in the middle of the
 *  window, up to 494px from the icon that asked for it (measured at the default window size). With a
 *  single persistent element, changing menus is a position change and a size change, and both animate.
 *
 *  The panels are body-only components now, and each one teleports its own second level into this card
 *  (see SubPopover), so a drill-in stays declared next to the rows that offer it. */
const player = usePlayerStore();
const card = ref<HTMLElement | null>(null);
const bodyEl = ref<HTMLElement | null>(null);

const more = ref(false);
/** The list that is on screen: while a drill-in is open it covers the card, and its own scroller is the
 *  one that can have more below. Scroll events bubble, so the card's listener sees either of them. */
function scroller(): HTMLElement | null {
  return (card.value?.querySelector('.pl-sub .pl-body') as HTMLElement | null) || bodyEl.value;
}
function checkMore(): void {
  const el = scroller();
  more.value = !!el && el.scrollTop + el.clientHeight < el.scrollHeight - 2;
}
function measure(): void {
  checkMore();
  place();
}

const { x, y, arrowX, room, place } = useSheetGeometry(card, computed(() => player.anchor), checkMore);

/** SubPopover needs the element it is teleported into; it is the card rather than the sheet so that the
 *  drill-in is a direct child and the rule that retires the first level can see it. */
provide('pl-sheet-card', card);

const PANELS: Record<PanelKind, { comp: unknown; title: string; props?: Record<string, unknown> }> = {
  quality: { comp: QualityPanel, title: '播放资源' },
  subtitle: { comp: TrackPanel, title: '字幕', props: { kind: 'subtitle' } },
  audio: { comp: TrackPanel, title: '音轨', props: { kind: 'audio' } },
  video: { comp: TrackPanel, title: '画面', props: { kind: 'video' } },
  speed: { comp: SpeedPanel, title: '播放速度' },
  chapters: { comp: ChapterPanel, title: '片段' },
  episodes: { comp: EpisodePanel, title: '选集' },
  danmaku: { comp: DanmakuPanel, title: '弹幕' },
};

const current = computed(() => (player.panel ? PANELS[player.panel] : null));
const title = computed(() => current.value?.title || '');

watch(current, () => void nextTick(measure));

/** The button under the card moves - the window is resized, the video goes fullscreen, a capsule relabels
 *  itself - and the anchor is the one piece of geometry CSS cannot re-derive. */
function onResize(): void {
  player.remeasure();
}
onMounted(() => window.addEventListener('resize', onResize));
onBeforeUnmount(() => window.removeEventListener('resize', onResize));

/** Everything the card can land a cursor on. `offsetParent` is how a hidden one shows itself: while a
 *  drill-in is up the first level is out of the layout, and its rows must not be reachable. */
const ITEMS = '.pl-row, .pl-cell, .pl-card, .pl-chip, .pl-switch, .pl-seg button, .pl-step button, .pl-words';

function items(): HTMLElement[] {
  return Array.from(card.value?.querySelectorAll<HTMLElement>(ITEMS) ?? []).filter(el => el.offsetParent !== null && !el.hasAttribute('disabled'));
}

function focusAt(i: number): void {
  const list = items();
  if (!list.length) return;
  // Wrapping at both ends: a ten-row chapter list that stops at the last row asks for another keypress to
  // get back to the first.
  list[(i % list.length + list.length) % list.length]?.focus();
}

/** The row already chosen, because that is where the user is. */
function focusHome(): void {
  const list = items();
  const on = list.findIndex(el => el.classList.contains('on'));
  list[on >= 0 ? on : 0]?.focus();
}

/** A text box keeps its own arrows - the caret moves left and right, up and down change lines - so the card
 *  takes nothing off it but Escape, and Escape only takes the cursor back to the list. */
function isTyping(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLElement && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
}

/** The row a drill-in came out of, so backing out returns the cursor there instead of to the top of the list. */
let subFrom: HTMLElement | null = null;

function onKey(e: KeyboardEvent): void {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (isTyping()) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    card.value?.focus();
    return;
  }
  const list = items();
  const at = list.findIndex(el => el === document.activeElement || el.contains(document.activeElement));

  /** Backing out: the second level first, then the card, and the cursor goes back to where it was. */
  const back = (): void => {
    e.preventDefault();
    e.stopPropagation();
    if (player.sub) {
      player.toggleSub('');
      const from = subFrom;
      subFrom = null;
      void nextTick(() => (from?.isConnected ? from.focus({ preventScroll: true }) : focusHome()));
    } else if (e.key === 'Escape') {
      player.closePanel();
    }
  };

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      e.stopPropagation();
      focusAt(at < 0 ? 0 : at + 1);
      return;
    case 'ArrowUp':
      e.preventDefault();
      e.stopPropagation();
      focusAt(at < 0 ? -1 : at - 1);
      return;
    case 'Home':
    case 'End':
      if (!list.length) return;
      e.preventDefault();
      e.stopPropagation();
      focusAt(e.key === 'Home' ? 0 : list.length - 1);
      return;
    case 'ArrowRight': {
      // A row with a chevron is the only thing that goes deeper, so right means the same here as a click.
      const row = at < 0 ? null : list[at].closest('.pl-row');
      if (!row?.querySelector('.go')) return;
      e.preventDefault();
      e.stopPropagation();
      subFrom = list[at];
      (row as HTMLElement).click();
      void nextTick(focusHome);
      return;
    }
    case 'ArrowLeft':
    case 'Escape':
      back();
      return;
    case 'Enter':
    case ' ': {
      // Only the things that are not buttons need help here - a focused button answers Enter on its own.
      const el = document.activeElement;
      if (!(el instanceof HTMLElement) || el.tagName === 'BUTTON' || at < 0) return;
      e.preventDefault();
      e.stopPropagation();
      el.click();
      return;
    }
  }
}

/** Opening a menu with a key is a keyboard action, so the card takes the cursor with it; opening one with
 *  the mouse does not, because the pointer is already where it needs to be and a focus ring would land on
 *  a row the user never touched. The store knows which hand was used - asking `document.activeElement`
 *  here cannot tell them apart, because Chrome focuses a button before its click handler runs. */
watch(
  () => player.panel,
  kind => {
    if (!kind) return;
    void nextTick(() => {
      measure();
      if (player.focusFromKey) card.value?.focus({ preventScroll: true });
    });
  }
);
</script>

<template>
  <Transition name="pl-sheet">
    <div v-show="!!current" class="pl-sheet no-drag" :style="{ transform: `translate3d(${x}px, -${y}px, 0)`, '--ax': `${arrowX}px`, '--room': `${room}px` }">
      <div ref="card" class="pl-panel" :class="{ 'is-more': more }" role="dialog" :aria-label="title" tabindex="-1" @keydown="onKey">
        <div class="pl-head">
          <span class="pl-title">{{ title }}</span>
          <button class="ib" title="关闭" @click="player.closePanel()">
            <X :size="18" />
          </button>
        </div>
        <div ref="bodyEl" class="pl-body" @scroll.passive="measure">
          <component :is="current.comp" v-if="current" v-bind="current.props" />
        </div>
      </div>
      <i class="pl-arrow" aria-hidden="true"></i>
    </div>
  </Transition>
</template>
