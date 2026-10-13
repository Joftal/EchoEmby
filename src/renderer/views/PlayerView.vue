<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { usePlayerStore } from '../stores/player';
import { fmtClock } from '../lib/format';
import type { PlayerState } from '../../shared/types';

const player = usePlayerStore();
const s = computed<PlayerState>(() => player.state);

const visible = ref(true);
let timer: ReturnType<typeof setTimeout> | null = null;
const bar = ref<HTMLElement | null>(null);
const dragging = ref(false);
const subOn = ref(true);

function showControls() {
  visible.value = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    if (!dragging.value && !s.value.paused) visible.value = false;
  }, 3200);
}

function scrub(e: PointerEvent) {
  const el = bar.value;
  if (!el || !s.value.durationMs) return;
  const rect = el.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  void player.cmd('seek', Math.round(ratio * s.value.durationMs));
}

function onPointerDown(e: PointerEvent) {
  dragging.value = true;
  bar.value?.setPointerCapture(e.pointerId);
  scrub(e);
}
function onPointerMove(e: PointerEvent) {
  if (dragging.value) scrub(e);
}
function onPointerUp(e: PointerEvent) {
  dragging.value = false;
  bar.value?.releasePointerCapture(e.pointerId);
  showControls();
}

async function toggleSub() {
  subOn.value = !subOn.value;
  await player.cmd('sid', subOn.value ? 'auto' : 'no');
}

const keys: Record<string, () => void> = {
  ' ': () => void player.cmd('toggle'),
  k: () => void player.cmd('toggle'),
  ArrowRight: () => void player.cmd('seekBy', 10000),
  ArrowLeft: () => void player.cmd('seekBy', -10000),
  ArrowUp: () => void player.cmd('volume', Math.min(150, s.value.volume + 5)),
  ArrowDown: () => void player.cmd('volume', Math.max(0, s.value.volume - 5)),
  m: () => void player.cmd('mute', !s.value.muted),
  f: () => void player.setFullscreen(!s.value.fullscreen),
  s: () => void toggleSub(),
  Escape: () => void close(),
};

function onKey(e: KeyboardEvent) {
  if (e.repeat && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const fn = keys[e.key];
  if (fn) {
    e.preventDefault();
    showControls();
    fn();
  }
}

async function close() {
  await player.close();
}

onMounted(() => {
  player.attach();
  showControls();
  window.addEventListener('mousemove', showControls);
  window.addEventListener('keydown', onKey);
});
onUnmounted(() => {
  window.removeEventListener('mousemove', showControls);
  window.removeEventListener('keydown', onKey);
  if (timer) clearTimeout(timer);
  player.detach();
});

const position = computed(() => `${(s.value.durationMs ? Math.min(1, s.value.positionMs / s.value.durationMs) : 0) * 100}%`);
const buffered = computed(() => `${(s.value.durationMs ? Math.min(1, s.value.bufferedMs / s.value.durationMs) : 0) * 100}%`);
</script>

<template>
  <div class="overlay" :class="{ hidden: !visible }">
    <div class="top drag">
      <div class="topin no-drag">
        <div class="ttl">
          <span class="name">{{ s.title }}</span>
          <span class="badge" :class="{ direct: s.direct }">{{ s.playMethod || '—' }}</span>
          <span v-if="s.videoWidth" class="dim">{{ s.videoWidth }}×{{ s.videoHeight }}</span>
          <span v-if="s.fps" class="dim">{{ s.fps }} fps</span>
        </div>
      </div>
    </div>

    <button v-if="!visible" class="hitzone" @click="showControls" @mousemove="showControls"></button>

    <div class="center" :class="{ gone: visible }">
      <button class="big" @click="player.cmd('toggle')">
        <svg v-if="s.paused" viewBox="0 0 24 24" width="26" height="26"><path d="M8 5l12 7-12 7z" fill="currentColor" /></svg>
        <svg v-else viewBox="0 0 24 24" width="24" height="24"><rect x="6" y="5" width="4" height="14" rx="1.6" fill="currentColor" /><rect x="14" y="5" width="4" height="14" rx="1.6" fill="currentColor" /></svg>
      </button>
    </div>

    <div class="bottom">
      <div class="seek" ref="bar" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp">
        <div class="rail">
          <div class="buf" :style="{ width: buffered }"></div>
          <div class="fill" :style="{ width: position }"></div>
          <div class="thumb" :style="{ left: position }"></div>
        </div>
      </div>

      <div class="row">
        <button class="ib" @click="player.cmd('toggle')">
          <svg v-if="s.paused" viewBox="0 0 24 24" width="19" height="19"><path d="M8 5l12 7-12 7z" fill="currentColor" /></svg>
          <svg v-else viewBox="0 0 24 24" width="18" height="18"><rect x="6" y="5" width="4" height="14" rx="1.5" fill="currentColor" /><rect x="14" y="5" width="4" height="14" rx="1.5" fill="currentColor" /></svg>
        </button>
        <button class="ib skip" @click="player.cmd('seekBy', -10000)">‹10</button>
        <button class="ib skip" @click="player.cmd('seekBy', 10000)">10›</button>

        <div class="time">{{ fmtClock(s.positionMs) }} <span class="dash">/</span> {{ fmtClock(s.durationMs) }}</div>

        <div class="grow"></div>

        <div class="vol">
          <button class="ib" @click="player.cmd('mute', !s.muted)">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M4 9v6h4l5 4V5L8 9H4z" /><path v-if="s.muted" d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="1.8" fill="none" /></svg>
          </button>
          <input type="range" min="0" max="150" :value="s.volume" @input="e => player.cmd('volume', Number((e.target as HTMLInputElement).value))" />
        </div>

        <button class="ib" :class="{ act: subOn }" @click="toggleSub">CC</button>
        <button class="ib" @click="player.setFullscreen(!s.fullscreen)">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path v-if="!s.fullscreen" d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /><path v-else d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>
        </button>
        <button class="ib" @click="close">
          <svg viewBox="0 0 24 24" width="17" height="17"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" fill="none" /></svg>
        </button>
      </div>
    </div>

    <p v-if="s.error" class="err">{{ s.error }}</p>
  </div>
</template>

<style scoped>
.overlay {
  position: absolute;
  inset: 0;
  color: #fff;
}
.top {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  padding: 16px 20px 34px;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.72), transparent);
  opacity: 1;
  transform: translate3d(0, 0, 0);
  transition: opacity 0.28s var(--ease), transform 0.28s var(--ease);
}
.hidden .top {
  opacity: 0;
  transform: translate3d(0, -14px, 0);
}
.topin {
  display: flex;
  align-items: center;
}
.ttl {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.name {
  font-size: 15px;
  font-weight: 600;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8), 0 3px 14px rgba(0, 0, 0, 0.6);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.badge {
  font-size: 13px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(255, 176, 32, 0.18);
  color: #ffb020;
  border: 1px solid rgba(255, 176, 32, 0.3);
}
.badge.direct {
  background: rgba(74, 222, 128, 0.16);
  color: #4ade80;
  border-color: rgba(74, 222, 128, 0.28);
}
.dim {
  font-size: 13px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.92);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.75);
}
.hitzone {
  position: absolute;
  inset: 0;
  cursor: default;
}
.center {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
  transition: opacity 0.25s var(--ease);
}
.center.gone {
  opacity: 0;
}
.big {
  width: 74px;
  height: 74px;
  border-radius: 50%;
  background: rgba(20, 20, 26, 0.62);
  backdrop-filter: blur(12px);
  display: grid;
  place-items: center;
  pointer-events: auto;
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.45);
  transition: transform var(--hov) var(--ease-out), background var(--hov) var(--ease);
}
.big:hover {
  transform: scale(1.07);
  background: rgba(94, 140, 255, 0.85);
}
.big:active {
  transform: scale(0.94);
}
.bottom {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 34px 20px 16px;
  background: linear-gradient(0deg, rgba(0, 0, 0, 0.7), transparent);
  transition: opacity 0.28s var(--ease), transform 0.28s var(--ease);
}
.hidden .bottom {
  opacity: 0;
  transform: translate3d(0, 18px, 0);
  pointer-events: none;
}
.seek {
  padding: 9px 0;
  cursor: pointer;
  touch-action: none;
}
.rail {
  position: relative;
  height: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.22);
  transition: height var(--hov) var(--ease-out);
}
.seek:hover .rail {
  height: 6px;
}
.buf {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.28);
  transition: width 0.3s linear;
}
.fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.22s linear;
}
.thumb {
  position: absolute;
  top: 50%;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.5);
  transform: translate(-50%, -50%) scale(0);
  transition: transform var(--hov) var(--ease-out);
}
.seek:hover .thumb,
.seek:active .thumb {
  transform: translate(-50%, -50%) scale(1);
}
.row {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
}
.ib {
  min-width: 34px;
  height: 34px;
  padding: 0 8px;
  border-radius: var(--radius);
  color: rgba(255, 255, 255, 0.97);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 13px;
  transition: background var(--hov) var(--ease), transform var(--hov) var(--ease-out), color var(--hov) var(--ease);
}
.ib:hover {
  background: rgba(255, 255, 255, 0.14);
}
.ib:active {
  transform: scale(0.92);
}
.ib.act {
  color: var(--accent);
}
.skip {
  letter-spacing: -0.5px;
}
.time {
  font-size: 13px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.95);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
  margin-left: 6px;
  font-variant-numeric: tabular-nums;
}
.dash {
  opacity: 0.6;
  margin: 0 2px;
}
.grow {
  flex: 1;
}
.vol {
  display: flex;
  align-items: center;
  gap: 6px;
}
.vol input[type='range'] {
  width: 84px;
  accent-color: var(--accent);
}
.err {
  position: absolute;
  top: 60px;
  left: 20px;
  color: var(--danger);
  font-size: 13px;
  background: rgba(0, 0, 0, 0.5);
  padding: 6px 10px;
  border-radius: var(--radius);
}
</style>
