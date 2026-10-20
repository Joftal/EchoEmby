<script setup lang="ts">
import { computed } from 'vue';
import type { ResumeTarget } from '../lib/resume';

/** The one play button every hero draws — the lobby's carousel and the detail page share it so a title
 *  in progress cannot say 「继续播放」 in one place and 「播放」 in the other, and both say whose file it
 *  opens.
 *
 *  `none` is the other answer: this server holds nothing that can be opened here, so the plate says that
 *  and stops being a button. Only ever set once the page knows — a season whose episode list is still on
 *  its way keeps saying 播放, because a promise taken back one frame later is the same lie in reverse. */
const props = defineProps<{ target: ResumeTarget | null; busy?: boolean; server?: string; none?: boolean }>();
const emit = defineEmits<{ (e: 'play'): void }>();

const verb = computed(() => (props.target?.resumed ? '继续播放' : '播放'));
const named = computed(() => !props.busy && !props.none && !!props.server);

function go(): void {
  if (props.none || props.busy) return;
  emit('play');
}
</script>

<template>
  <button class="hero-play" :class="{ empty: none }" :disabled="busy || none" @click="go">
    <svg class="tri" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M8 5v14l11-7z" fill="currentColor" stroke="currentColor" stroke-width="3" stroke-linejoin="round" />
    </svg>
    <span class="txt">
      <b :class="{ named }">
        <template v-if="none">当前服务器无资源</template>
        <template v-else-if="busy">准备中…</template>
        <template v-else-if="named">在&nbsp;<span class="nm">{{ server }}</span>&nbsp;{{ verb }}</template>
        <template v-else>{{ verb }}</template>
      </b>
      <i v-if="target?.caption && !none">{{ target.caption }}</i>
    </span>
  </button>
</template>

<style scoped>
.hero-play {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 8px 22px;
  border-radius: 999px;
  /* A single flat colour reads as a sticker dropped on the poster: the art behind it ranges from near-black
     to blown-out highlight across the button's own height, so a uniform plate has no relationship to any of
     it. This one carries its own light — the top edge stays white, the bottom drops one step — with a
     hairline of brighter white along the top and a tight contact shadow under the soft one. */
  background: linear-gradient(180deg, #fff, #e9ebf1);
  color: var(--ink);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.9),
    0 1px 2px rgba(6, 8, 14, 0.32),
    0 9px 24px rgba(6, 8, 14, 0.38);
  transition: transform var(--hov) var(--ease-out), box-shadow var(--hov) var(--ease), opacity var(--hov) var(--ease);
}
/* The hover brighten is a layer, not a `background` swap: gradients do not interpolate, so transitioning
   between two of them snaps the plate in one frame. Both children sit above it (z-index) so it can only
   wash the plate, never the type. */
.hero-play::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: #fff;
  opacity: 0;
  transition: opacity var(--hov) var(--ease);
}
.hero-play > * {
  position: relative;
  z-index: 1;
}
.hero-play:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow:
    inset 0 1px 0 #fff,
    0 2px 3px rgba(6, 8, 14, 0.3),
    0 13px 30px rgba(6, 8, 14, 0.44);
}
.hero-play:hover:not(:disabled)::after {
  opacity: 0.55;
}
.hero-play:active:not(:disabled) {
  transform: scale(0.97);
}
.hero-play:disabled {
  opacity: 0.5;
  cursor: default;
}
/* 「当前服务器无资源」 is a fact the page is certain of, not a button that is temporarily unavailable,
   so it must not wear the 0.5 fade — that is the same face as 「准备中」 and reads as *not yet* rather
   than *not here*. One step down on the plate and a solid `#4b4b52` for the glyph and the label together:
   measured off the screenshots at both viewports — 7.13:1 at 1360×816 and the same 7.13:1 at 1236×660,
   against 16.8:1 for the normal plate. After `:disabled` because both selectors weight the same and this
   one has to win on source order. */
.hero-play.empty {
  opacity: 1;
  color: #4b4b52;
  background: linear-gradient(180deg, #eef0f4, #e2e5ec);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.75),
    0 1px 2px rgba(6, 8, 14, 0.26),
    0 9px 24px rgba(6, 8, 14, 0.32);
}
/* Was a border-drawn wedge: four hard corners and a flat black mass that matched no other glyph in the app.
   The stroke-width/2 round join gives it the same softened triangle as the hero's other icons. */
.tri {
  flex: none;
}
.txt {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  line-height: 1.15;
  /* The caption is the line that says how far the title has got, and it lands a round trip after the
     button is on screen. With nothing reserved the pill grew a line taller when it arrived and moved the
     hero's other controls with it, so both lines always have room. Reserving alone was not enough: a
     one-line label then sat at the top of the two-line box, 7.5px above the button's own middle while the
     glyph next to it stayed centred. `justify-content` puts it back. */
  min-height: calc(15px * 1.15 + 13px * 1.15);
}
.txt b {
  font-size: 15px;
  font-weight: 650;
}
/* The name is the only part of 「在 OkEmby 播放」 that can be long, and the button's width comes out of the
   hero's text column, so the name is what gives. The `&nbsp;` around it is load-bearing: in a flex row the
   plain spaces between text and element collapse, and the label came out 「在OkEmby播放」.
   `nowrap` is what makes the name the only giver: without it the CJK word 「播放」 can break between any two
   glyphs, so it shrinks before the clamped name does and the label turns into two lines that push the
   button taller. */
.txt b.named {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
}
.txt b .nm {
  min-width: 0;
  max-width: 9em;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* A solid step down rather than `opacity: 0.72`: the caption is the number the button is there to say,
   so it keeps its own colour and stays above 7:1 on the darkest part of the plate instead of fading with
   it. */
.txt i {
  animation: fade-in 0.24s var(--ease) both;
  font-size: 13px;
  font-weight: 500;
  font-style: normal;
  color: #4b4b52;
}
</style>
