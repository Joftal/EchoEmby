<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { DanmakuSettings, NetProbe, PlayerPrefs, Settings } from '../../shared/types';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const router = useRouter();

const settings = computed(() => store.config?.settings);
const player = computed<PlayerPrefs | undefined>(() => settings.value?.player);
const dm = computed<DanmakuSettings | undefined>(() => settings.value?.danmaku);

const DECODERS: { value: PlayerPrefs['hwdec']; label: string }[] = [
  { value: 'd3d11va', label: 'D3D11' },
  { value: 'cuda', label: 'CUDA' },
  { value: 'auto', label: '自动' },
  { value: 'no', label: '软解' },
];

/** The same ladder the player's 画质 drawer lists, so a rung picked here is a rung the panel can show. */
const TIERS: { value: number; label: string }[] = [
  { value: 0, label: '原片' },
  ...[10, 25, 60, 100, 140, 200].map(m => ({ value: m * 1_000_000, label: `${m}M` })),
];

const STEPS = [5000, 10000, 15000, 30000];
const HOLDS = [2000, 3200, 5000, 8000];

const PROXY_MODES: { value: Settings['proxyMode']; label: string }[] = [
  { value: 'system', label: '系统代理' },
  { value: 'manual', label: '手动代理' },
  { value: 'none', label: '不代理' },
];

const SOURCES: { value: DanmakuSettings['source']['type']; label: string }[] = [
  { value: 'bilibili', label: 'Bilibili' },
  { value: 'dandan', label: '弹弹 play' },
];

const addr = ref('');
watch(() => settings.value?.proxyUrl, v => (addr.value = v || ''), { immediate: true });
const addrHint = computed(() => {
  if (settings.value?.proxyMode !== 'manual') return '选「手动代理」后用这个地址';
  return settings.value.proxyUrl ? '改完按回车或点别处生效' : '填好地址才会切换路线';
});

/** The token crosses the bridge masked, so this row can only say whether one is on file; it never echoes
 *  a stored value back into an input. */
const token = ref('');
const tokenSaved = computed(() => dm.value?.source?.token === '<set>');
/** Deleting a stored key has to be possible from an empty field, but a field that was only clicked into
 *  and then left must not be read as a delete - that would erase the key on the next blur. */
const tokenTyped = ref(false);
watch(token, v => { if (v.trim()) tokenTyped.value = true; });

const dmUrl = ref('');
watch(() => dm.value?.source?.url, v => (dmUrl.value = v || ''), { immediate: true });

/* The TMDB key lives on its own channel because it is not a setting the player reads — it is a
   credential the meta modules sign their requests with, and it is masked across the bridge the same
   way the danmaku token is. */
const tmdbKey = ref('');
const tmdbTyped = ref(false);
const tmdbSaved = computed(() => store.config?.meta?.tmdbV4Token === '<set>');
watch(tmdbKey, v => { if (v.trim()) tmdbTyped.value = true; });

async function commitTmdb(explicit = false): Promise<void> {
  const v = tmdbKey.value.trim();
  if (v === '<set>') return;
  if (!v && !explicit && !tmdbTyped.value) return;
  const r = await window.echoemby.meta.setKeys({ tmdbV4Token: v });
  if (!r.ok) return;
  if (store.config) store.config.meta = r.data;
  tmdbKey.value = '';
  tmdbTyped.value = false;
}

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

/** Route changes are applied by the main process before the file is written, so a rejected address never
 *  lands. Everything else is a write-through. */
async function set(patch: Parameters<typeof store.saveSettings>[0]): Promise<boolean> {
  if (!settings.value) return false;
  if (patch.proxyMode !== undefined || patch.proxyUrl !== undefined) retireRoute();
  return store.saveSettings(patch);
}

async function commitAddr(): Promise<void> {
  const v = addr.value.trim();
  if (v === (settings.value?.proxyUrl || '')) return;
  await set({ proxyUrl: v });
}

async function commitDmUrl(): Promise<void> {
  const v = dmUrl.value.trim();
  if (v === (dm.value?.source?.url || '')) return;
  await set({ danmaku: { source: { url: v } } });
}

/** Deleting a stored key is the explicit gesture the row promises: 回车 on an empty field. A blur away from
 *  a field that was never typed into is only a click past it, and must not erase what is on file. */
async function commitToken(explicit = false): Promise<void> {
  const v = token.value.trim();
  if (v === '<set>') return;
  if (!v && !explicit && !tokenTyped.value) return;
  if (!(await set({ danmaku: { source: { token: v } } }))) return;
  token.value = '';
  tokenTyped.value = false;
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
    <div v-if="!settings || !player || !dm" class="col">
      <header class="head"><i class="sk skh"></i></header>
      <div class="rows">
        <div v-for="n in 5" :key="n" class="row">
          <i class="sk skk"></i>
          <i class="sk skg"></i>
        </div>
      </div>
    </div>
    <div v-else class="col">
      <header class="head">
        <h1>设置</h1>
      </header>

      <h2 class="sec">播放</h2>
      <div class="rows">
        <div class="row">
          <div class="k">
            <b>清晰度上限</b>
            <i>原片禁止转码；其余档位由服务器决定是直连还是切片段</i>
          </div>
          <div class="seg">
            <button v-for="o in TIERS" :key="o.value" type="button" :class="{ on: player.tier === o.value }" @click="set({ player: { tier: o.value } })">
              {{ o.label }}
            </button>
          </div>
        </div>

        <div class="row">
          <div class="k">
            <b>硬件解码</b>
          </div>
          <div class="seg">
            <button v-for="o in DECODERS" :key="o.value" type="button" :class="{ on: player.hwdec === o.value }" @click="set({ player: { hwdec: o.value } })">
              {{ o.label }}
            </button>
          </div>
        </div>

        <div class="row">
          <div class="k">
            <b>渲染</b>
            <i>清晰优先会换一个新的播放器进程</i>
          </div>
          <div class="seg">
            <button type="button" :class="{ on: player.render !== 'hq' }" @click="set({ player: { render: 'smooth' } })">流畅优先</button>
            <button type="button" :class="{ on: player.render === 'hq' }" @click="set({ player: { render: 'hq' } })">清晰优先</button>
          </div>
        </div>

        <div class="row">
          <div class="k">
            <b>快进步长</b>
          </div>
          <div class="seg">
            <button v-for="s in STEPS" :key="s" type="button" :class="{ on: player.seekStepMs === s }" @click="set({ player: { seekStepMs: s } })">
              {{ s / 1000 }} 秒
            </button>
          </div>
        </div>

        <div class="row">
          <div class="k">
            <b>控制条停留</b>
          </div>
          <div class="seg">
            <button v-for="h in HOLDS" :key="h" type="button" :class="{ on: player.controlsTimeoutMs === h }" @click="set({ player: { controlsTimeoutMs: h } })">
              {{ h / 1000 }} 秒
            </button>
          </div>
        </div>

        <div class="row">
          <div class="k">
            <b>自动连播</b>
            <i>一集播完接着放下一集</i>
          </div>
          <button type="button" class="sw" :class="{ on: player.autoNext }" @click="set({ player: { autoNext: !player.autoNext } })">
            <span class="track"><i></i></span>
          </button>
        </div>

        <div class="row">
          <div class="k">
            <b>HDR 直通</b>
            <i>屏幕不支持 HDR 时画面会发灰；下一次播放生效</i>
          </div>
          <button type="button" class="sw" :class="{ on: player.hdrHint }" @click="set({ player: { hdrHint: !player.hdrHint } })">
            <span class="track"><i></i></span>
          </button>
        </div>
      </div>

      <h2 class="sec">弹幕</h2>
      <div class="rows">
        <div class="row">
          <div class="k">
            <b>显示弹幕</b>
            <i>关闭时不会向任何弹幕源请求你看的内容</i>
          </div>
          <button type="button" class="sw" :class="{ on: dm.enabled }" @click="set({ danmaku: { enabled: !dm.enabled } })">
            <span class="track"><i></i></span>
          </button>
        </div>

        <div class="row">
          <div class="k">
            <b>来源</b>
          </div>
          <div class="seg">
            <button v-for="o in SOURCES" :key="o.value" type="button" :class="{ on: dm.source.type === o.value }" @click="set({ danmaku: { source: { type: o.value } } })">
              {{ o.label }}
            </button>
          </div>
        </div>

        <div class="row addr">
          <div class="k">
            <b>API 地址</b>
            <i>{{ dm.source.type === 'dandan' ? '自建或公共弹弹 play 兼容服务，例如 http://127.0.0.1:6666' : 'Bilibili 无需地址' }}</i>
          </div>
          <input v-model="dmUrl" type="text" :disabled="dm.source.type !== 'dandan'" placeholder="http://127.0.0.1:6666" spellcheck="false" autocomplete="off" @blur="commitDmUrl" @keydown.enter="commitDmUrl" />
        </div>

        <div class="row addr">
          <div class="k">
            <b>密钥</b>
            <i>{{ tokenSaved ? '已保存，重新输入可替换，清空后回车可删除' : '弹弹 play 的 X-Session-Token，只存在本机' }}</i>
          </div>
          <input
            v-model="token"
            type="password"
            :disabled="dm.source.type !== 'dandan'"
            :placeholder="tokenSaved ? '••••••••' : '可留空'"
            spellcheck="false"
            autocomplete="off"
            @blur="commitToken()"
            @keydown.enter="commitToken(true)"
          />
        </div>

        <div class="row">
          <div class="k">
            <b>标题匹配</b>
            <i>库里的名字常常和弹幕源不一样</i>
          </div>
          <div class="seg">
            <button type="button" :class="{ on: dm.matchMode !== 1 }" @click="set({ danmaku: { matchMode: 0 } })">近似</button>
            <button type="button" :class="{ on: dm.matchMode === 1 }" @click="set({ danmaku: { matchMode: 1 } })">完全一致</button>
          </div>
        </div>
      </div>

      <h2 class="sec">元数据</h2>
      <div class="rows">
        <div class="row addr">
          <div class="k">
            <b>TMDB Key</b>
            <i>{{ tmdbSaved ? '已保存，重新输入可替换，清空后回车可删除' : 'v3 API Key 或 v4 Token 均可，用于艺术字标题、中文简介与评分补强' }}</i>
          </div>
          <input
            v-model="tmdbKey"
            type="password"
            :placeholder="tmdbSaved ? '••••••••' : '可留空'"
            spellcheck="false"
            autocomplete="off"
            @blur="commitTmdb()"
            @keydown.enter="commitTmdb(true)"
          />
        </div>
      </div>

      <h2 class="sec">网络</h2>
      <div class="rows">
        <div class="row">
          <div class="k">
            <b>代理模式</b>
          </div>
          <div class="seg">
            <button v-for="o in PROXY_MODES" :key="o.value" type="button" :class="{ on: settings.proxyMode === o.value }" @click="set({ proxyMode: o.value })">
              {{ o.label }}
            </button>
          </div>
        </div>

        <div class="row addr">
          <div class="k">
            <b>代理地址</b>
            <i>{{ addrHint }}</i>
          </div>
          <input v-model="addr" type="text" placeholder="127.0.0.1:7897" spellcheck="false" autocomplete="off" @blur="commitAddr" @keydown.enter="commitAddr" />
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
/* The page is only drawn once all three blocks have come back from the config read, and a wipe that
   uncovers a bare column reads as a page that failed rather than one that is thinking. These are the real
   cards with their contents pressed in, at the height the rows have. */
.sk {
  display: block;
  background: var(--shimmer);
  background-size: 220% 100%;
  animation: sh 1.3s linear infinite;
}
.skh {
  width: 118px;
  height: 30px;
  border-radius: 8px;
}
.skk {
  width: 44%;
  height: 15px;
}
.skg {
  width: 132px;
  height: 30px;
  border-radius: 999px;
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
.addr input:disabled {
  color: var(--text-faint);
  background: var(--bg-elev-2);
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
  flex-wrap: wrap;
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
.sw {
  width: 44px;
  height: 26px;
  border-radius: 999px;
  background: var(--chip-hi);
  position: relative;
  transition: background var(--hov) var(--ease);
}
.sw .track {
  position: absolute;
  inset: 0;
}
.sw .track i {
  position: absolute;
  top: 4px;
  left: 4px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  box-shadow: var(--shadow-sm);
  transition: transform var(--hov) var(--ease-out);
}
.sw.on {
  background: var(--accent);
}
.sw.on .track i {
  transform: translate3d(18px, 0, 0);
}
</style>
