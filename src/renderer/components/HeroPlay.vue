<script setup lang="ts">
import type { ResumeTarget } from '../lib/resume';

/** The one play button every hero draws — the lobby's carousel and the detail page share it so a title
 *  in progress cannot say 「继续播放」 in one place and 「播放」 in the other. */
defineProps<{ target: ResumeTarget | null; busy?: boolean }>();
const emit = defineEmits<{ (e: 'play'): void }>();
</script>

<template>
  <button class="hero-play" :disabled="busy" @click="emit('play')">
    <span class="tri"></span>
    <span class="txt">
      <b>{{ busy ? '准备中…' : target ? '继续播放' : '播放' }}</b>
      <i v-if="target">{{ target.caption }}</i>
    </span>
  </button>
</template>

<style scoped>
.hero-play {
  display: inline-flex;
  align-items: center;
  gap: 11px;
  padding: 11px 26px;
  border-radius: 999px;
  background: #f4f4f7;
  color: var(--ink);
  box-shadow: 0 10px 26px rgba(6, 8, 14, 0.4);
  transition: transform var(--hov) var(--ease-out), box-shadow var(--hov) var(--ease), background var(--hov) var(--ease), opacity var(--hov) var(--ease);
}
.hero-play:hover:not(:disabled) {
  background: #fff;
  transform: translateY(-1px);
  box-shadow: 0 14px 32px rgba(6, 8, 14, 0.46);
}
.hero-play:active:not(:disabled) {
  transform: scale(0.97);
}
.hero-play:disabled {
  opacity: 0.5;
  cursor: default;
}
.tri {
  width: 0;
  height: 0;
  flex: none;
  border-left: 11px solid var(--ink);
  border-top: 7px solid transparent;
  border-bottom: 7px solid transparent;
}
.txt {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  line-height: 1.15;
}
.txt b {
  font-size: 15px;
  font-weight: 650;
}
/* A solid step down rather than `opacity: 0.72`: the caption is the number the button is there to say,
   so it keeps its own colour and stays at 7.6:1 on the plate instead of fading with it. */
.txt i {
  font-size: 13px;
  font-weight: 500;
  font-style: normal;
  color: #4b4b52;
}
</style>
