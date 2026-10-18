<script setup lang="ts">
import type { ResumeTarget } from '../lib/resume';

/** The one play button every hero draws — the lobby's carousel and the detail page share it so a title
 *  in progress cannot say 「继续播放」 in one place and 「播放」 in the other. */
defineProps<{ target: ResumeTarget | null; busy?: boolean }>();
const emit = defineEmits<{ (e: 'play'): void }>();
</script>

<template>
  <button class="hero-play" :disabled="busy" @click="emit('play')">
    <svg class="tri" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M8 5v14l11-7z" fill="currentColor" stroke="currentColor" stroke-width="3" stroke-linejoin="round" />
    </svg>
    <span class="txt">
      <b>{{ busy ? '准备中…' : target?.resumed ? '继续播放' : '播放' }}</b>
      <i v-if="target?.caption">{{ target.caption }}</i>
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
