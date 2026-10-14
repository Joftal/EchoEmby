<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { NetProbe, Settings } from '../../shared/types';
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
const PROXY_MODES: { value: Settings['proxyMode']; label: string }[] = [
  { value: 'system', label: '系统代理' },
  { value: 'manual', label: '手动代理' },
  { value: 'none', label: '不代理' },
];

const addr = ref('');
watch(() => settings.value?.proxyUrl, v => (addr.value = v || ''), { immediate: true });
const addrHint = computed(() => {
  if (settings.value?.proxyMode !== 'manual') return '选「手动代理」后用这个地址';
  return settings.value.proxyUrl ? '改完按回车或点别处生效' : '填好地址才会切换路线';
});

const probe = ref<NetProbe | null>(null);
const probing = ref(false);
const probeRead = computed(() => {
  const p = probe.value;
  if (!p) return '';
  // A dead server leg is the red line's job - saying 不通 next to the reason would read it twice.
  const parts = p.serverMs != null ? [`服务器 ${p.serverMs}ms`] : [];
  if (p.egressIp) parts.push(`出口 ${p.egressIp}${p.egressRegion ? `（${p.egressRegion}）` : ''}`);
  return parts.join(' · ');
});

onMounted(async () => {
  if (!store.ready) await store.init();
  if (!store.account) router.replace('/login');
});

/** A reading belongs to the route it was taken on, so changing either half of that route retires it -
 *  including one still in flight, which would otherwise land as an answer about a route that no
 *  longer exists (measured: 不代理 showing the 系统代理 exit address). */
let probeSeq = 0;
function retireRoute(): void {
  probeSeq++;
  probing.value = false;
  probe.value = null;
}

/** Changes to the route take effect immediately; everything else just writes through. */
async function set(patch: Partial<Settings>): Promise<void> {
  if (!settings.value) return;
  if (patch.proxyMode !== undefined || patch.proxyUrl !== undefined) retireRoute();
  await store.saveSettings(patch);
}

async function commitAddr(): Promise<void> {
  const v = addr.value.trim();
  if (v === (settings.value?.proxyUrl || '')) return;
  await set({ proxyUrl: v });
}

async function runProbe(): Promise<void> {
  if (probing.value) return;
  const gen = ++probeSeq;
  probing.value = true;
  const r = await window.echoemby.net.probe();
  if (gen !== probeSeq) return;
  probing.value = false;
  if (r.ok && r.data) probe.value = r.data;
  else store.error = r.error || '检测失败';
}
</script>

<template>
  <div class="page">
    <div v-if="settings" class="col">
      <header class="head">
        <h1>设置</h1>
      </header>

      <h2 class="sec">播放</h2>
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

      <h2 class="sec">网络</h2>
      <div class="rows">
        <div class="row">
          <div class="k">
            <b>代理模式</b>
          </div>
          <div class="seg">
            <button
              v-for="o in PROXY_MODES"
              :key="o.value"
              type="button"
              :class="{ on: settings.proxyMode === o.value }"
              @click="set({ proxyMode: o.value })"
            >
              {{ o.label }}
            </button>
          </div>
        </div>

        <div class="row addr">
          <div class="k">
            <b>代理地址</b>
            <i>{{ addrHint }}</i>
          </div>
          <input
            v-model="addr"
            type="text"
            placeholder="127.0.0.1:7897"
            spellcheck="false"
            autocomplete="off"
            @blur="commitAddr"
            @keydown.enter="commitAddr"
          />
        </div>

        <div class="row">
          <div class="k">
            <b>连接测试</b>
            <i v-if="probeRead">{{ probeRead }}</i>
            <i v-if="probe && probe.error" class="bad">{{ probe.error }}</i>
          </div>
          <button class="go" type="button" :disabled="probing" @click="runProbe">
            {{ probing ? '检测中…' : '检测' }}
          </button>
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
.sec {
  margin: 26px 0 12px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 1.3px;
  color: var(--text-dim);
}
.sec:first-of-type {
  margin-top: 0;
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
.k i {
  display: block;
  margin-top: 4px;
  font-size: 13px;
  font-style: normal;
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
}
.k i.bad {
  color: var(--danger);
}
.addr input {
  flex: 1;
  min-width: 220px;
  max-width: 320px;
  padding: 9px 12px;
  border-radius: var(--radius);
  background: #f4f4f7;
  border: 1px solid var(--line);
  outline: none;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  transition: border-color var(--hov) var(--ease), box-shadow var(--hov) var(--ease), background var(--hov) var(--ease);
}
.addr input::placeholder {
  color: var(--text-faint);
}
.addr input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
  background: #fff;
}
.go {
  padding: 8px 18px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  background: var(--bg-elev-2);
  border: 1px solid var(--line);
  transition: color var(--hov) var(--ease), background var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.go:hover {
  background: #e3e3ea;
}
.go:active {
  transform: scale(0.96);
  transition-duration: 0.1s;
}
.go:disabled {
  color: var(--text-faint);
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
