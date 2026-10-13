<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import type { Settings } from '../../shared/types';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const router = useRouter();

const settings = computed(() => store.config?.settings);

const DECODERS: { value: Settings['hwdec']; label: string }[] = [
  { value: 'd3d11va', label: 'D3D11' },
  { value: 'cuda', label: 'CUDA' },
  { value: 'auto', label: '自动' },
  { value: 'no', label: '软解' },
];
/** Megabits, offered as presets because the cap is what decides whether the server transcodes. */
const BITRATES: { value: number; label: string }[] = [10, 25, 60, 140, 200].map(m => ({
  value: m * 1_000_000,
  label: `${m}M`,
}));

onMounted(async () => {
  if (!store.ready) await store.init();
  if (!store.account) router.replace('/login');
});

async function set(patch: Partial<Settings>): Promise<void> {
  if (!settings.value) return;
  await store.saveSettings(patch);
}
</script>

<template>
  <div class="page">
    <div v-if="settings" class="col">
      <header class="head">
        <h1>设置</h1>
      </header>

      <div class="rows">
        <div class="row">
          <div class="k">
            <b>硬件解码</b>
          </div>
          <div class="seg">
            <button
              v-for="o in DECODERS"
              :key="o.value"
              type="button"
              :class="{ on: settings.hwdec === o.value }"
              @click="set({ hwdec: o.value })"
            >
              {{ o.label }}
            </button>
          </div>
        </div>

        <div class="row">
          <div class="k">
            <b>码率上限</b>
          </div>
          <div class="seg">
            <button
              v-for="o in BITRATES"
              :key="o.value"
              type="button"
              :class="{ on: settings.maxStreamingBitrate === o.value }"
              @click="set({ maxStreamingBitrate: o.value })"
            >
              {{ o.label }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <Transition name="toast">
      <div v-if="store.error" class="toast">{{ store.error }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.page {
  --side: clamp(10px, 1.8vw, 26px);
  --gutter: calc(var(--nav-w) + var(--side));
  position: relative;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  padding: calc(var(--titlebar-h) + 22px) var(--side) 46px var(--gutter);
  transition: padding var(--rail-dur) var(--rail-ease);
}
.col {
  max-width: 720px;
  margin: 0 auto;
}
.head {
  margin-bottom: 20px;
}
h1 {
  margin: 0;
  font-size: clamp(22px, 2.6vw, 30px);
  font-weight: 700;
  letter-spacing: -0.3px;
  color: var(--text);
}
.rows {
  display: grid;
  gap: 12px;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px 18px;
  padding: 15px 18px;
  border-radius: var(--r-tile);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
}
.k b {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.seg {
  display: inline-flex;
  gap: 2px;
  padding: 4px;
  border-radius: 999px;
  background: var(--bg-elev-2);
}
.seg button {
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 13px;
  color: var(--text-dim);
  transition: color var(--hov) var(--ease), background var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.seg button:hover {
  color: var(--text);
}
.seg button.on {
  color: var(--text);
  font-weight: 600;
  background: var(--bg-elev);
  box-shadow: var(--shadow-sm);
}
.seg button:active {
  transform: scale(0.96);
  transition-duration: 0.1s;
}
.toast {
  position: fixed;
  left: 50%;
  bottom: 26px;
  z-index: var(--z-toast);
  transform: translateX(-50%);
  padding: 9px 18px;
  border-radius: 999px;
  font-size: 13px;
  color: var(--text);
  background: rgba(255, 255, 255, 0.86);
  border: 1px solid var(--line);
  backdrop-filter: blur(14px) saturate(180%);
  box-shadow: var(--shadow);
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.28s var(--ease), transform 0.34s var(--ease-out);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate3d(-50%, 14px, 0);
}
</style>
