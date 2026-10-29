<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { AppWindow, Database, Globe, HardDrive, MessageSquareText, Play } from 'lucide-vue-next';
import type { DanmakuSettings, MediaCachePrefs, MediaCacheStats, NetProbe, PlayerPrefs, Settings, WindowPrefs } from '../../shared/types';
import { useAppStore } from '../stores/app';
import FilterSelect from '../components/browse/FilterSelect.vue';
import { AUDIO_LANGS, SUB_LANGS } from '../../shared/lang';

const store = useAppStore();
const router = useRouter();

const settings = computed(() => store.config?.settings);
const player = computed<PlayerPrefs | undefined>(() => settings.value?.player);
const win = computed<WindowPrefs | undefined>(() => settings.value?.window);
const dm = computed<DanmakuSettings | undefined>(() => settings.value?.danmaku);
const mc = computed<MediaCachePrefs | undefined>(() => settings.value?.mediaCache);

/* The ceilings the sheet offers: one episode (1.34 GB measured for a 1080p episode 2026-10-28), a couple,
   half a season, most of a season - and 不限制 last, which is `0` through the whole chain and reads as a
   word everywhere it is printed. The numbers are round because the eviction is coarse (whole videos). */
const LIMITS = [1, 2, 5, 10, 0];

/** 不限制 is 0 in the config; the ladder must never print 「0 GB」. */
const limitLabel = (g: number): string => (g > 0 ? g + ' GB' : '不限制');

/* A config written before this ladder existed can hold a ceiling the ladder no longer offers (the old
   default was 20). It gets a plate of its own, in place, instead of landing on no plate at all - the row
   would otherwise say 20 GB 上限 while nothing in the ladder looked picked. */
const limitChoices = computed<number[]>(() => {
  const cur = mc.value?.limitGB;
  if (cur === undefined || LIMITS.includes(cur)) return LIMITS;
  const below = LIMITS.filter(g => g > 0 && g < cur);
  const above = LIMITS.filter(g => g > 0 && g > cur);
  return [...below, cur, ...above, 0];
});

/** What is on disk right now. Read from the main process's own index, because a `dir` walk here would
 *  see a folder the renderer cannot address anyway (it lives under userData, outside the app bundle). */
const stats = ref<MediaCacheStats | null>(null);
const cacheBusy = ref(false);

function sizeRead(n: number): string {
  if (!(n > 0)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (i <= 1 || v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
}

const usedRead = computed(() => (stats.value ? sizeRead(stats.value.bytes) + ' · ' + stats.value.items + ' 个视频' : '统计中…'));

async function readCache(): Promise<void> {
  const r = await window.echoemby.mediaCache.stats();
  if (r.ok) stats.value = r.data ?? null;
}

async function clearCache(): Promise<void> {
  if (cacheBusy.value) return;
  cacheBusy.value = true;
  const r = await window.echoemby.mediaCache.clear();
  cacheBusy.value = false;
  if (r.ok) stats.value = r.data ?? null;
  else store.error = r.error || '清理失败';
}

const DECODERS: { value: PlayerPrefs['hwdec']; label: string }[] = [
  { value: 'd3d11va', label: 'D3D11' },
  { value: 'cuda', label: 'CUDA' },
  { value: 'auto', label: '自动' },
  { value: 'no', label: '软解' },
];

const STEPS = [5000, 10000, 15000, 30000];

/* The same three words the player's own 画面适配 row offers, in the same order: one question asked in two
   places must not be answered with two vocabularies. */
const FITS: { value: PlayerPrefs['fit']; label: string }[] = [
  { value: 'fit', label: '适应屏幕' },
  { value: 'fill', label: '填满屏幕' },
  { value: 'stretch', label: '拉伸填满' },
];

const PROXY_MODES: { value: Settings['proxyMode']; label: string }[] = [
  { value: 'system', label: '系统代理' },
  { value: 'manual', label: '手动代理' },
  { value: 'none', label: '不代理' },
];

/* 关闭按钮的两种处理：退出程序 / 隐藏至菜单栏。判定在主进程 src/main/index.ts 的 w.on('close') 里，
 * 每次按压现读设置，所以改完立刻生效；隐藏时播放器不动（它会跑在托盘里看不见的地方），退出则把它连位置
 * 一起收掉 —— 那条 stopped 上报才决定下次从哪儿接着看。 */
const CLOSE_ACTIONS: { value: WindowPrefs['closeAction']; label: string }[] = [
  { value: 'quit', label: '退出程序' },
  { value: 'tray', label: '隐藏至菜单栏' },
];

const SOURCES: { value: DanmakuSettings['source']['type']; label: string }[] = [
  { value: 'bilibili', label: 'Bilibili' },
  { value: 'dandan', label: '弹弹 play' },
];

const SECTIONS = [
  { id: 'play', label: '播放', icon: Play },
  { id: 'cache', label: '缓存', icon: HardDrive },
  { id: 'window', label: '窗口', icon: AppWindow },
  { id: 'danmaku', label: '弹幕', icon: MessageSquareText },
  { id: 'meta', label: '元数据', icon: Database },
  { id: 'network', label: '网络', icon: Globe },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

const scrollEl = ref<HTMLElement | null>(null);
const active = ref<SectionId>('play');
/** A jump owns the indicator until its glide ends: the last sections are too short to reach the top
 *  line, so the scroll position alone would light 网络 after a click on 元数据. */
let navLock = 0;

function unlock(): void {
  navLock = 0;
}

/** The anchors are data markers rather than # links: the window's whole address is the router's hash, so
 *  an <a href="#play"> would send the app to a route that does not exist. */
function sectionEl(id: SectionId): HTMLElement | null {
  return scrollEl.value?.querySelector<HTMLElement>(`[data-sec="${id}"]`) ?? null;
}

/** The title and the section index sit outside the scroll pane, so a sheet's own top is the line a jump
 *  stops on: the pane's top edge is already below both navigations. */
function go(id: SectionId): void {
  const pane = scrollEl.value;
  const el = sectionEl(id);
  if (!pane || !el) return;
  active.value = id;
  navLock = performance.now() + 900;
  const top = Math.min(pane.scrollHeight - pane.clientHeight, Math.max(0, el.offsetTop));
  pane.scrollTo({ top, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

/** A wheel over the fixed title or index still drives the sheets: the page itself has nothing left to
 *  scroll, so without this the 152px beside the sheets would be a dead strip. */
function onWheel(e: WheelEvent): void {
  unlock();
  const pane = scrollEl.value;
  if (!pane) return;
  if ((e.target as Element | null)?.closest?.('.scroll')) return;
  const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  pane.scrollBy({ top: step });
}

/** The last sheet whose top has passed the pane's first line is the one being read. The final sheet can
 *  never reach that line at the bottom, so it is chosen outright. */
function onScroll(): void {
  const pane = scrollEl.value;
  if (!pane) return;
  if (performance.now() < navLock) return;
  if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2) {
    active.value = SECTIONS[SECTIONS.length - 1].id;
    return;
  }
  const line = pane.scrollTop + 8;
  let current: SectionId = SECTIONS[0].id;
  for (const s of SECTIONS) {
    const el = sectionEl(s.id);
    if (el && el.offsetTop <= line) current = s.id;
  }
  active.value = current;
}

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

/* These keys live on their own channel because they are not settings the player reads — they are
   credentials the meta modules sign their requests with, and they are masked across the bridge the same
   way the danmaku token is. */
const tmdbKey = ref('');
const tmdbTyped = ref(false);
const tmdbSaved = computed(() => store.config?.meta?.tmdbV4Token === '<set>');
watch(tmdbKey, v => { if (v.trim()) tmdbTyped.value = true; });

const traktKey = ref('');
const traktTyped = ref(false);
const traktSaved = computed(() => store.config?.meta?.traktClientId === '<set>');
watch(traktKey, v => { if (v.trim()) traktTyped.value = true; });

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

async function commitTrakt(explicit = false): Promise<void> {
  const v = traktKey.value.trim();
  if (v === '<set>') return;
  if (!v && !explicit && !traktTyped.value) return;
  const r = await window.echoemby.meta.setKeys({ traktClientId: v });
  if (!r.ok) return;
  if (store.config) store.config.meta = r.data;
  traktKey.value = '';
  traktTyped.value = false;
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
  // The player panel writes 画面适配 and 硬件解码 on its own, and a write in another window is not pushed
  // into this store: reopening the sheet re-reads the block instead of printing the launch-time reading.
  if (!store.ready) await store.init();
  else await store.refreshSettings();
  if (!store.account) router.replace('/login');
  void readCache();
});

/** The reading is taken again whenever the sheet is opened on 缓存, because the number moves while the
 *  page is elsewhere: a viewing in the player is filling it. */
watch(active, id => {
  if (id === 'cache') void readCache();
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
  const ok = await store.saveSettings(patch);
  // 上限 is applied by the cache when it is read, not when it is written, so this page has to ask again or it
  // keeps showing the number from before the change (measured: picking 5 GB left 已用 at the value read when
  // the page opened, 179 MB, and only a fresh stats() brought it to 199 MB).
  if (ok && patch.mediaCache) void readCache();
  return ok;
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
  <div class="page" @wheel.passive="onWheel" @pointerdown="unlock" @keydown="unlock">
    <div class="col">
      <header class="head">
        <h1>设置</h1>
      </header>

      <div class="layout">
        <nav class="srail" aria-label="设置分组">
          <button
            v-for="s in SECTIONS"
            :key="s.id"
            type="button"
            :class="{ on: active === s.id }"
            :aria-current="active === s.id ? 'true' : undefined"
            @click="go(s.id)"
          >
            <component :is="s.icon" :size="17" :stroke-width="1.7" />
            <span>{{ s.label }}</span>
          </button>
        </nav>

        <div class="main">
          <nav class="stabs" aria-label="设置分组">
            <button
              v-for="s in SECTIONS"
              :key="s.id"
              type="button"
              :class="{ on: active === s.id }"
              :aria-current="active === s.id ? 'true' : undefined"
              @click="go(s.id)"
            >
              {{ s.label }}
            </button>
          </nav>

          <div ref="scrollEl" class="scroll" @scroll.passive="onScroll">
            <div v-if="!settings || !player || !dm" class="skel" aria-hidden="true">
            <section class="group">
              <div class="pane">
                <header class="ph">
                  <span class="tic"><Play :size="15" :stroke-width="1.7" /></span>
                  <h2>播放</h2>
                </header>
                <div v-for="n in 4" :key="n" class="row">
                  <div class="k">
                    <span class="sk skk"></span>
                    <span v-if="n === 3 || n === 4" class="sk skhint"></span>
                  </div>
                  <i class="sk skg"></i>
                </div>
              </div>
            </section>
            <section class="group">
              <div class="pane">
                <header class="ph">
                  <span class="tic"><AppWindow :size="15" :stroke-width="1.7" /></span>
                  <h2>窗口</h2>
                </header>
                <div class="row">
                  <div class="k">
                    <span class="sk skk"></span>
                    <span class="sk skhint"></span>
                  </div>
                  <i class="sk skg"></i>
                </div>
              </div>
            </section>
            <section class="group">
              <div class="pane">
                <header class="ph">
                  <span class="tic"><MessageSquareText :size="15" :stroke-width="1.7" /></span>
                  <h2>弹幕</h2>
                </header>
                <div v-for="n in 2" :key="n" class="row">
                  <div class="k">
                    <span class="sk skk"></span>
                    <span v-if="n === 1" class="sk skhint"></span>
                  </div>
                  <i class="sk skg"></i>
                </div>
              </div>
            </section>
          </div>

          <template v-else>
            <section class="group" data-sec="play">
              <div class="pane">
                <header class="ph">
                  <span class="tic"><Play :size="15" :stroke-width="1.7" /></span>
                  <h2>播放</h2>
                </header>

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
                    <b>快进步长</b>
                  </div>
                  <div class="seg">
                    <button v-for="s in STEPS" :key="s" type="button" :class="{ on: player.seekStepMs === s }" @click="set({ player: { seekStepMs: s } })">
                      {{ s / 1000 }} 秒
                    </button>
                  </div>
                </div>

                <!-- 首选语言 sits above the switches because it decides what opens, not how the picture ends:
                     a file with several tracks is the ordinary case in this library, and until these two rows
                     existed the only thing that had ever answered 「which one」 was the file's own default. The
                     hints say what the picker prefers, because 「首选」 alone would leave a reader wondering why
                     a 5.1 mix won over a 2.0 one that happens to come first in the container. -->
                <div class="row">
                  <div class="k">
                    <b>字幕首选语言</b>
                    <i>有多条字幕时先选这一种；同为中文时优先完整译制、文字字幕</i>
                  </div>
                  <FilterSelect
                    label="字幕"
                    :options="SUB_LANGS"
                    :model-value="player.subLang"
                    menu
                    neutral
                    @update:model-value="v => set({ player: { subLang: String(v) } })"
                  />
                </div>

                <div class="row">
                  <div class="k">
                    <b>音频首选语言</b>
                    <i>多轨时优先无损、多声道、高码率</i>
                  </div>
                  <FilterSelect
                    label="音频"
                    :options="AUDIO_LANGS"
                    :model-value="player.audioLang"
                    menu
                    neutral
                    @update:model-value="v => set({ player: { audioLang: String(v) } })"
                  />
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

                <!-- Picture fit sits with the two switches rather than with the track rows: it does not
                     decide what opens, only how the frame meets the window. The player's own 画面适配 row
                     writes this same setting, so a change made while watching is the change stored here. -->
                <div class="row">
                  <div class="k">
                    <b>画面适配</b>
                    <i>适应屏幕：画面完整、四周留黑边 · 填满屏幕：放大到无黑边、裁掉溢出 · 拉伸填满：拉满窗口，不管比例</i>
                  </div>
                  <FilterSelect
                    label="画面"
                    :options="FITS"
                    :model-value="player.fit"
                    bare
                    menu
                    neutral
                    @update:model-value="v => set({ player: { fit: v as PlayerPrefs['fit'] } })"
                  />
                </div>

                <!-- The switch below drives Windows' own HDR setting, not an mpv flag: the row is on and a
                     HDR file plays, the app puts the display into HDR and takes it back out afterwards. -->
                <div class="row">
                  <div class="k">
                    <b>HDR</b>
                    <i>播放 HDR 片源时打开 Windows 的 HDR，看完还原；SDR 片源不动显示器</i>
                  </div>
                  <button type="button" class="sw" :class="{ on: player.hdr }" @click="set({ player: { hdr: !player.hdr } })">
                    <span class="track"><i></i></span>
                  </button>
                </div>

                <div class="row">
                  <div class="k">
                    <b>进度条预览图</b>
                    <i>鼠标停在进度条上显示那一刻的画面；为抓帧要多开一个解码进程，约占 600 MB 内存</i>
                  </div>
                  <button type="button" class="sw" :class="{ on: player.thumbPreview }" @click="set({ player: { thumbPreview: !player.thumbPreview } })">
                    <span class="track"><i></i></span>
                  </button>
                </div>
              </div>
            </section>

            <section class="group" data-sec="cache">
              <div class="pane">
                <header class="ph">
                  <span class="tic"><HardDrive :size="15" :stroke-width="1.7" /></span>
                  <h2>缓存</h2>
                </header>

                <div class="row">
                  <div class="k">
                    <b>媒体缓存</b>
                    <i>看过的片段留在本地，重看与回拖都不再走网络；关掉后每次播放都重新拉取</i>
                  </div>
                  <button type="button" class="sw" :class="{ on: mc?.enabled }" @click="set({ mediaCache: { enabled: !mc?.enabled } })">
                    <span class="track"><i></i></span>
                  </button>
                </div>

                <div class="row">
                  <div class="k">
                    <b>缓存上限</b>
                    <i>超出后按最久没看的整条删掉，不会把一部片切成碎片</i>
                  </div>
                  <div class="seg">
                    <button v-for="g in limitChoices" :key="g" type="button" :class="{ on: mc?.limitGB === g }" @click="set({ mediaCache: { limitGB: g } })">
                      {{ limitLabel(g) }}
                    </button>
                  </div>
                </div>

                <div class="row">
                  <div class="k">
                    <b>追剧时预取下一集</b>
                    <i>这一集播放时先把下一集的开头十分钟拉到本地，切集几乎不用等</i>
                  </div>
                  <button type="button" class="sw" :class="{ on: mc?.prefetchNext }" @click="set({ mediaCache: { prefetchNext: !mc?.prefetchNext } })">
                    <span class="track"><i></i></span>
                  </button>
                </div>

                <div class="row">
                  <div class="k">
                    <b>退出程序时清理缓存</b>
                    <i>退出前把整个缓存目录删掉，下次打开从空开始</i>
                  </div>
                  <button type="button" class="sw" :class="{ on: mc?.clearOnExit }" @click="set({ mediaCache: { clearOnExit: !mc?.clearOnExit } })">
                    <span class="track"><i></i></span>
                  </button>
                </div>

                <div class="row">
                  <div class="k">
                    <b>已用 {{ usedRead }}</b>
                    <i>{{ mc?.limitGB ? mc.limitGB + ' GB 上限 · 改小后多出来的部分会立刻清掉' : '不限制 · 缓存会一直长到磁盘写满为止' }}</i>
                  </div>
                  <button class="go" type="button" :disabled="cacheBusy || !stats || stats.bytes === 0" @click="clearCache">
                    {{ cacheBusy ? '清理中…' : '清理全部缓存' }}
                  </button>
                </div>
              </div>
            </section>
            <section class="group" data-sec="window">
              <div class="pane">
                <header class="ph">
                  <span class="tic"><AppWindow :size="15" :stroke-width="1.7" /></span>
                  <h2>窗口</h2>
                </header>

                <div class="row">
                  <div class="k">
                    <b>点关闭按钮时</b>
                    <i>{{ win?.closeAction === 'tray' ? '标题栏的 × 与 Alt+F4 只把界面藏进托盘，程序与播放都不停；托盘图标上可以再打开或退出' : '标题栏的 × 与 Alt+F4 直接退出，会一起关掉播放器，看到哪里会写回服务器' }}</i>
                  </div>
                  <div class="seg">
                    <button v-for="o in CLOSE_ACTIONS" :key="o.value" type="button" :class="{ on: win?.closeAction === o.value }" @click="set({ window: { closeAction: o.value } })">
                      {{ o.label }}
                    </button>
                  </div>
                </div>

                <div class="row">
                  <div class="k">
                    <b>播放时隐藏主程序</b>
                    <i>画面出来的那一刻把主界面收进托盘，关掉播放器后自己回来</i>
                  </div>
                  <button type="button" class="sw" :class="{ on: win?.hideOnPlay }" @click="set({ window: { hideOnPlay: !win?.hideOnPlay } })">
                    <span class="track"><i></i></span>
                  </button>
                </div>
              </div>
            </section>

            <section class="group" data-sec="danmaku">
              <div class="pane">
                <header class="ph">
                  <span class="tic"><MessageSquareText :size="15" :stroke-width="1.7" /></span>
                  <h2>弹幕</h2>
                </header>

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
            </section>

            <section class="group" data-sec="meta">
              <div class="pane">
                <header class="ph">
                  <span class="tic"><Database :size="15" :stroke-width="1.7" /></span>
                  <h2>元数据</h2>
                </header>

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
                <div class="row addr">
                  <div class="k">
                    <b>Trakt Client ID</b>
                    <i>{{ traktSaved ? '已保存，重新输入可替换，清空后回车可删除' : 'trakt.tv/app 免费申请，填上后评分条多一格 Trakt 分数' }}</i>
                  </div>
                  <input
                    v-model="traktKey"
                    type="password"
                    :placeholder="traktSaved ? '••••••••' : '可留空'"
                    spellcheck="false"
                    autocomplete="off"
                    @blur="commitTrakt()"
                    @keydown.enter="commitTrakt(true)"
                  />
                </div>
              </div>
            </section>

            <section class="group" data-sec="network">
              <div class="pane">
                <header class="ph">
                  <span class="tic"><Globe :size="15" :stroke-width="1.7" /></span>
                  <h2>网络</h2>
                </header>

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
            </section>
          </template>
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
  overflow: hidden;
  padding: 0 var(--side) 0 var(--gutter);
  transition: padding var(--rail-dur) var(--rail-ease);
}
/* The title, the index and the tab bar are the frame, and only the sheet column inside it moves: the
   page itself never scrolls, so neither navigation can slide away. The sheet is 860 wide at the default
   window, so the col reserves the rail (152) and its gap (32) on top of it. */
.col {
  display: flex;
  flex-direction: column;
  height: 100%;
  max-width: 1044px;
  margin: 0 auto;
  padding-top: calc(var(--titlebar-h) + 24px);
}
.head {
  flex: none;
  margin-bottom: 26px;
  min-height: 42px;
  display: flex;
  align-items: center;
}
h1 {
  margin: 0;
  font-size: clamp(22px, 2.6vw, 30px);
  font-weight: 700;
  letter-spacing: -0.3px;
  color: var(--text);
}
.layout {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: stretch;
}
.main {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* The index is a sibling of the sheets, not a bar over them: the section names stay on screen for the
   whole page while the sheets scroll in the second column. */
.srail {
  display: none;
}
.srail button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 40px;
  padding: 0 12px;
  border-radius: var(--r-row);
  color: var(--text-dim);
  font-size: 13px;
  text-align: left;
  transition: color var(--hov) var(--ease), background var(--hov) var(--ease);
}
.srail button svg {
  flex: none;
  opacity: 0.72;
}
.srail button:hover {
  color: var(--text);
  background: var(--chip);
}
/* The picked section is near-black on the tint, like the app's own nav: accent-coloured 13px type on
   accent-soft measured 3.75:1, and the colour here is what has to be read, not the tile. */
.srail button.on {
  color: var(--text);
  background: var(--accent-soft);
  font-weight: 600;
}
.srail button.on svg {
  opacity: 1;
}
/* Below the rail's breakpoint the same four anchors sit in one row above the scroll pane. Text and a
   2px underline rather than the pill track used by a value picker: these change what is on screen,
   they do not pick a value. */
.stabs {
  flex: none;
  display: flex;
  align-items: flex-end;
  gap: 28px;
  height: 42px;
  margin: 0 0 18px;
  padding: 0 2px;
  background: var(--glass);
  backdrop-filter: blur(14px) saturate(160%);
  border-bottom: 1px solid var(--line);
}
.stabs button {
  position: relative;
  display: flex;
  align-items: center;
  height: 41px;
  font-size: 13px;
  color: var(--text-dim);
  white-space: nowrap;
  transition: color var(--hov) var(--ease);
}
.stabs button::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  border-radius: 999px;
  background: transparent;
  transition: background var(--hov) var(--ease);
}
.stabs button:hover {
  color: var(--text);
}
.stabs button.on {
  color: var(--text);
}
.stabs button.on::after {
  background: var(--accent);
}
/* The only moving part. Its edges are below the title and the tab bar, and beside the rail, so the
   sheets scroll without carrying either navigation with them. */
.scroll {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding-bottom: 46px;
}
@media (min-width: 1280px) {
  .layout {
    grid-template-columns: 152px minmax(0, 860px);
    gap: 32px;
  }
  .srail {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: 8px;
  }
  .stabs {
    display: none;
  }
}
.group + .group {
  margin-top: 22px;
}
/* One surface per section, its title inside it: four sheets read as four chapters, and the icon tile
   gives each chapter a fixed mark both in the rail and at its top. */
.pane {
  overflow: hidden;
  border-radius: 16px;
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
}
.ph {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 22px 14px;
  border-bottom: 1px solid var(--line);
}
.ph h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--text);
}
.tic {
  display: grid;
  place-items: center;
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: var(--radius);
  color: var(--accent);
  background: var(--accent-soft);
}
/* Label on the left, control on the right. The control column is sized by its widest picker and every
   control ends on the sheet's right edge, so a switch and a seven-rung ladder share one line even
   though they are nowhere near the same width. */
.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px 24px;
  padding: 15px 22px;
}
.row + .row {
  border-top: 1px solid var(--line);
}
.row > .k {
  min-width: 0;
}
.row > .seg,
.row > .sw,
.row > input,
.row > .go,
.row > .skg {
  justify-self: end;
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
/* A fixed 330 rather than a share of the row: all four fields then start and end on the same two lines
   instead of each one stretching to whatever its label left over. */
.addr input {
  width: 330px;
  height: 40px;
  padding: 0 12px;
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
  height: 40px;
  padding: 0 18px;
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
/* The ladder never wraps: at the minimum window it is the label that gives up width, not the control.
   The picked plate changes colour and fill, never weight or width. */
.seg {
  display: inline-flex;
  flex-wrap: nowrap;
  gap: 2px;
  padding: 4px;
  border-radius: 999px;
  background: var(--bg-elev-2);
}
.seg button {
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 13px;
  white-space: nowrap;
  color: var(--text-dim);
  transition: color var(--hov) var(--ease), background var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.seg button:hover {
  color: var(--text);
}
.seg button.on {
  color: var(--text);
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
.srail button:focus-visible,
.stabs button:focus-visible,
.seg button:focus-visible,
.sw:focus-visible,
.go:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
/* The page is drawn only once all three blocks have come back from the config read. The real title,
   rail and chapter headers stay on screen throughout; the bars are the first two chapters' own boxes
   with their contents pressed in, seven rows and the four hint lines among them. */
.sk {
  display: block;
  background: var(--shimmer);
  background-size: var(--sk-tile) 100%;
  animation: sh 1.3s linear infinite;
}
/* A title line is 21.7px tall and a hint line 20.15, with 4 between them. The bars keep those line
   boxes so a hint row lands at the same height as its finished copy. Adjacent margins collapse, hence
   the larger top margin on the hint bar. */
.skk {
  width: 44%;
  height: 15px;
  margin: 3.35px 0;
  border-radius: var(--r-badge);
}
.skhint {
  width: 72%;
  height: 13px;
  margin: 10.925px 0 3.575px;
  border-radius: var(--r-badge);
}
.skg {
  width: 300px;
  height: 40.2px;
  border-radius: 999px;
}
</style>
