<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { AppWindow, ChevronRight, Database, Globe, GripVertical, HardDrive, MessageSquareText, Play, Plus, X } from 'lucide-vue-next';
import type { DanmakuSource, MediaCachePrefs, MediaCacheStats, NetProbe, PlayerPrefs, Settings, WindowPrefs } from '../../shared/types';
import { useAppStore } from '../stores/app';
import FilterSelect from '../components/browse/FilterSelect.vue';
import { AUDIO_LANGS, SUB_LANGS } from '../../shared/lang';
import { ANIME4K_LABELS, ANIME4K_LEVELS, ANIME4K_NOTES } from '../../shared/anime4k';

const store = useAppStore();
const router = useRouter();

const settings = computed(() => store.config?.settings);
const player = computed<PlayerPrefs | undefined>(() => settings.value?.player);
const win = computed<WindowPrefs | undefined>(() => settings.value?.window);
/* 弹幕 needs no toggle of its own: the endpoint rows are the switch. No usable row, no request, no layer. */
const mc = computed<MediaCachePrefs | undefined>(() => settings.value?.mediaCache);

/* ---------------------------------------------------------------- 弹幕接口 */

/* The list is stored in the order it is tried, so nothing here sorts. Every edit writes the whole array
   back: a patch that carried one row would otherwise merge into the stored list by index, and deleting a
   row has no index to merge by. */
const sources = computed<DanmakuSource[]>(() => settings.value?.danmaku?.sources || []);

/** 最多 12 条: enough for the official endpoint plus any mirror worth trying, few enough that the walk still
 *  fits inside one lookup budget. */
const MAX_ROWS = 12;

/** 添加接口's row before it has an address. It is deliberately NOT written to the config: a file full of blank
 *  rows was what 「空接口」 looked like, and a row that can ask nothing has no reason to outlive the sheet. It
 *  becomes a stored row the moment its address is complete, and closing the sheet drops it. */
const draft = ref<DanmakuSource | null>(null);
/** What the list draws: stored rows, then the one being typed. Ordering, counting and testing all read this, so
 *  a fresh row behaves like the rest before it is saved. */
const rows = computed<DanmakuSource[]>(() => (draft.value ? [...sources.value, draft.value] : sources.value));
const isDraft = (s: DanmakuSource): boolean => !!draft.value && s.id === draft.value.id;

/** A row the walk can actually use: switched on, and carrying an address instead of the blank 添加接口 leaves
 *  behind. Nothing else ever reaches the network, so an empty list here means 弹幕 is simply not there. */
const usable = computed(() => sources.value.filter(s => s.enabled && /^https?:\/\/[^\s]+$/i.test(s.url)));

/** The one line the settings row prints instead of the list: who answers first, and how many follow. */
const dmSummary = computed(() => {
  if (!sources.value.length) return '没有接口';
  if (!usable.value.length) return '全部关闭';
  const first = usable.value[0].name || usable.value[0].url;
  return usable.value.length > 1 ? `${first} +${usable.value.length - 1}` : first;
});
const dmHint = computed(() =>
  usable.value.length
    ? '按顺序依次尝试，第一个答得上的用来取弹幕'
    : '现在没有可用接口，播放器不会请求弹幕；打开这里的开关或补一条完整地址即可',
);

/* The list, the addresses and the tester live in one sheet: a settings row that grows a line per mirror
   pushes everything under it out of sight, and the row can only ever name what is in force. */
const dmOpen = ref(false);
const dmCard = ref<HTMLElement | null>(null);
const dmList = ref<HTMLElement | null>(null);
/** True while the list still has rows below the fold: the fade at its edge is what says "scroll me". */
const listMore = ref(false);
function syncFade(): void {
  const el = dmList.value;
  listMore.value = !!el && el.scrollTop + el.clientHeight < el.scrollHeight - 2;
}
// A row added or removed changes the height of the list, not its scrollTop, so nothing above fires.
watch(
  () => sources.value.length,
  () => void nextTick(syncFade),
);

/** A note under the list: what the last edit refused, and why. Nothing here is stored, and nothing here
 *  asks an endpoint anything — that is 接口调试's job, on its own page. */
const testNote = ref('');

/** A row out of the sheet is a reactive object, and IPC cannot clone one — it would throw before leaving the
 *  renderer and leave 测试中 stuck forever (measured: first run of this sheet). A plain copy crosses over. */
function plain(s: DanmakuSource): DanmakuSource {
  return { id: s.id, name: s.name, url: s.url, enabled: s.enabled };
}

/** The whole list goes back every time (a patch carrying one row would merge by index), and every row is
 *  copied out of its reactive wrapper first: an IPC argument that is still a Proxy is refused by the clone step,
 *  which would make 添加接口 and 删除 fail silently — measured, both did. */
const saveSources = (list: DanmakuSource[]): Promise<boolean> => set({ danmaku: { sources: list.map(plain) } });

async function patchSource(id: string, patch: Partial<DanmakuSource>): Promise<void> {
  await saveSources(sources.value.map(s => (s.id === id ? { ...s, ...patch } : s)));
}

/** 添加接口 puts one blank row at the end and leaves the typing to the viewer. Nothing is written yet: the
 *  row becomes real when its address parses (see `promoteDraft`), and a second click just focuses the row that
 *  is already waiting instead of stacking blanks. */
async function addSource(): Promise<void> {
  if (rows.value.length >= MAX_ROWS) {
    testNote.value = `最多 ${MAX_ROWS} 条`;
    return;
  }
  testNote.value = '';
  if (!draft.value) draft.value = { id: `draft-${Date.now().toString(36)}`, name: '', url: '', enabled: true };
  await nextTick();
  // The row just added is the only thing the viewer wants to type in.
  dmCard.value?.querySelector<HTMLInputElement>('.dm-row.draft input.nm')?.focus();
}

/** The blank row is edited locally; it is stored the first time its address is complete. */
function editDraft(field: 'name' | 'url', ev: Event): void {
  if (!draft.value) return;
  draft.value = { ...draft.value, [field]: (ev.target as HTMLInputElement).value };
}

async function promoteDraft(): Promise<void> {
  const d = draft.value;
  if (!d) return;
  const url = d.url.trim().replace(/\/+$/, '');
  if (!url) return;
  if (!/^https?:\/\/[^\s]+$/i.test(url)) {
    testNote.value = '地址要写成 https://api.example.com 这种完整形式';
    return;
  }
  testNote.value = '';
  const row: DanmakuSource = {
    id: `src-${Date.now().toString(36)}`,
    name: d.name.trim().slice(0, 40) || url.replace(/^https?:\/\//i, ''),
    url,
    enabled: d.enabled,
  };
  try {
    await saveSources([...sources.value, row]);
    draft.value = null;
  } catch (e) {
    testNote.value = String((e as Error)?.message || e || '没有存下来');
  }
}

/** The sheet has one door: the section row. Everything else — the list, adding, and the tester —
 *  is inside it, so no two controls on the settings page open the same thing. */
async function openDm(): Promise<void> {
  dmOpen.value = true;
  await nextTick();
  syncFade();
  dmCard.value?.focus();
}

function closeDm(): void {
  dmOpen.value = false;
  // A row that never got an address dies with the sheet: the config only ever holds endpoints that can answer.
  draft.value = null;
  testNote.value = '';
}

/** The order is the fallback order, so it is edited in place: clicking the grip lifts a row one step, dragging
 *  it drops the row where the pointer is. Both end in the same write. */
async function moveRow(from: number, to: number): Promise<void> {
  const list = sources.value.slice();
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return;
  const [row] = list.splice(from, 1);
  list.splice(to, 0, row);
  try {
    await saveSources(list);
  } catch (e) {
    testNote.value = String((e as Error)?.message || e || '没有存下来');
  }
}

const dragFrom = ref(-1);
const dragTo = ref(-1);
function dragStart(i: number, ev: DragEvent): void {
  dragFrom.value = i;
  dragTo.value = i;
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move';
    // Firefox needs a payload before a drag will start; the index is not read back.
    ev.dataTransfer.setData('text/plain', String(i));
  }
}
function dragOver(i: number): void {
  if (dragFrom.value >= 0) dragTo.value = i;
}
function dragEnd(): void {
  dragFrom.value = -1;
  dragTo.value = -1;
}
async function dropAt(i: number): Promise<void> {
  const from = dragFrom.value;
  dragEnd();
  await moveRow(from, i);
}

async function removeSource(s: DanmakuSource): Promise<void> {
  if (isDraft(s)) {
    draft.value = null;
    return;
  }
  if (sources.value.length <= 1) {
    testNote.value = '至少留一条，否则弹幕就没处可问';
    return;
  }
  try {
    await saveSources(sources.value.filter(x => x.id !== s.id));
  } catch (e) {
    testNote.value = String((e as Error)?.message || e || '没有存下来');
  }
}

/** Names and addresses are committed on Enter/blur rather than per keystroke: each keystroke would be a
 *  config write, and a half-typed address fails the http(s) check and is dropped on the way in. */
async function commitName(s: DanmakuSource, ev: Event): Promise<void> {
  if (isDraft(s)) {
    editDraft('name', ev);
    await promoteDraft();
    return;
  }
  const v = (ev.target as HTMLInputElement).value.trim().slice(0, 40);
  const name = v || s.url.replace(/^https?:\/\//i, '');
  if (name !== s.name) await patchSource(s.id, { name });
  else (ev.target as HTMLInputElement).value = s.name;
}

async function commitUrl(s: DanmakuSource, ev: Event): Promise<void> {
  const el = ev.target as HTMLInputElement;
  if (isDraft(s)) {
    editDraft('url', ev);
    await promoteDraft();
    // Still blank: the typed text stays where it is, the row is simply not stored yet.
    if (draft.value) el.value = draft.value.url;
    return;
  }
  const url = el.value.trim().replace(/\/+$/, '');
  if (url === s.url) {
    el.value = s.url;
    return;
  }
  if (!/^https?:\/\/[^\s]+$/i.test(url)) {
    testNote.value = '地址要写成 https://api.example.com 这种完整形式';
    el.value = s.url;
    return;
  }
  testNote.value = '';
  await patchSource(s.id, { url });
}


/** A count for the footer: the rows the player would actually walk. */
const enabledCount = computed(() => sources.value.filter(s => s.enabled).length);

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

/* 画质增强: Anime4K's four answers, named the way the player's own 画质 row names them, so the setting and
   the panel cannot disagree about what 「标准」 means. */
const ANIME4K_OPTIONS = ANIME4K_LEVELS.map(v => ({ value: v, label: ANIME4K_LABELS[v] }));

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
  // 弹幕调试 is the one page entered from a sheet this deep in the list, so coming back has to land on
  // that sheet instead of the top of the page. The address carries no section, but the history entry
  // remembers the debug page as the one either behind us (返回) or ahead of us (管理 went forward into
  // 设置) - every other way into this page still starts at 播放. No animation: nothing moved yet.
  const st = window.history.state as { back?: string; forward?: string } | null;
  if (st?.back === '/danmaku' || st?.forward === '/danmaku') {
    await nextTick();
    const pane = scrollEl.value;
    const el = sectionEl('danmaku');
    if (pane && el) {
      active.value = 'danmaku';
      navLock = performance.now() + 900;
      pane.scrollTop = Math.min(pane.scrollHeight - pane.clientHeight, Math.max(0, el.offsetTop));
    }
  }
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
            <div v-if="!settings || !player" class="skel" aria-hidden="true">
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

                <!-- 画质增强 sits with 画面适配 because it is the other half of the same question: that row
                     decides how the frame meets the window, this one decides what is drawn into it. The hint
                     is the chosen level's own line — four sentences stacked under one label would say three
                     things the reader is not choosing. -->
                <div class="row">
                  <div class="k">
                    <b>Anime4K 画质增强</b>
                    <i>{{ ANIME4K_NOTES[player.anime4k] }}</i>
                  </div>
                  <FilterSelect
                    label="Anime4K"
                    :options="ANIME4K_OPTIONS"
                    :model-value="player.anime4k"
                    bare
                    menu
                    neutral
                    @update:model-value="v => set({ player: { anime4k: v as PlayerPrefs['anime4k'] } })"
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
                    <b>弹幕接口</b>
                    <i :class="{ bad: !usable.length }">{{ dmHint }}</i>
                  </div>
                  <button type="button" class="dmbtn" @click="openDm()">
                    <span class="dot" :class="{ off: !usable.length }"></span>
                    <span class="t">{{ dmSummary }}</span>
                    <ChevronRight :size="15" :stroke-width="2" />
                  </button>
                </div>

                <div class="row">
                  <div class="k">
                    <b>接口调试</b>
                    <i>换一套接口之后先在这里试：自动匹配、手动搜索，以及任意一条原始请求</i>
                  </div>
                  <button type="button" class="dmbtn" @click="router.push('/danmaku')">
                    <span class="t">打开调试</span>
                    <ChevronRight :size="15" :stroke-width="2" />
                  </button>
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


    <!-- 弹幕接口: the list and the tester share one sheet. A row per mirror in the settings sheet grew with
         every endpoint a viewer added and pushed the sheets under it off screen; here the section row only
         names what is in force, and everything that can grow lives behind one button. -->
    <Teleport to="body">
      <Transition name="dmfade">
        <div v-if="dmOpen" class="dm-scrim" @click.self="closeDm">
          <div ref="dmCard" class="dm-dlg" role="dialog" aria-modal="true" aria-label="弹幕接口" tabindex="-1" @keydown.esc="closeDm">
            <header class="dm-hd">
              <span class="tic"><MessageSquareText :size="15" :stroke-width="1.7" /></span>
              <div class="dm-ht">
                <b>弹幕接口</b>
                <i>自上而下依次尝试，由第一条可用的接口提供弹幕</i>
              </div>
              <button type="button" class="dm-x" title="关闭" @click="closeDm">
                <X :size="16" :stroke-width="2" />
              </button>
            </header>

            <div class="dm-body">
              <div class="dm-col">
              <div class="dm-scroll">
              <div ref="dmList" class="dm-list" @scroll="syncFade">
                <div
                  v-for="(s, i) in rows"
                  :key="s.id"
                  class="dm-row"
                  :class="{ off: !s.enabled, draft: isDraft(s), drag: dragFrom === i, over: dragFrom >= 0 && dragFrom !== i && dragTo === i }"
                  @dragover.prevent="dragOver(i)"
                  @drop.prevent="dropAt(i)"
                >
                  <span class="dm-ord" :title="'第 ' + (i + 1) + ' 个被尝试'">
                    <i class="dot" />
                    {{ i + 1 }}
                  </span>
                  <button
                    type="button"
                    class="sw"
                    :class="{ on: s.enabled }"
                    :aria-label="s.enabled ? '停用这个接口' : '启用这个接口'"
                    @click.stop="patchSource(s.id, { enabled: !s.enabled })"
                  >
                    <span class="track"><i></i></span>
                  </button>
                  <button
                    type="button"
                    class="grip"
                    :class="{ first: i === 0 }"
                    :disabled="isDraft(s)"
                    :title="isDraft(s) ? '填上地址后即可排序' : '拖动排序，点击上移'"
                    aria-label="拖动排序，点击上移一位"
                    draggable="true"
                    @dragstart.stop="dragStart(i, $event)"
                    @dragend="dragEnd"
                    @click.stop="moveRow(i, i - 1)"
                  >
                    <GripVertical :size="14" :stroke-width="2" />
                  </button>
                  <input
                    class="nm"
                    :value="s.name"
                    maxlength="40"
                    :placeholder="isDraft(s) ? '接口名称' : '名称'"
                    @change="commitName(s, $event)"
                  />
                  <input
                    class="ur"
                    :value="s.url"
                    maxlength="300"
                    spellcheck="false"
                    :placeholder="isDraft(s) ? 'https://接口地址，填好即保存' : 'https://你的接口地址'"
                    @change="commitUrl(s, $event)"
                  />
                  <button type="button" class="kill" :disabled="!isDraft(s) && sources.length <= 1" title="删除这一条" @click.stop="removeSource(s)">
                    <X :size="14" :stroke-width="2" />
                  </button>
                </div>
                <button type="button" class="dm-ghost" :disabled="rows.length >= MAX_ROWS" @click="addSource()">
                  <Plus :size="13" :stroke-width="2.2" />
                  {{ rows.length >= MAX_ROWS ? '已达上限 12 条' : '添加接口' }}
                </button>
              </div>
              <div v-if="listMore" class="dm-fade" aria-hidden="true" />
              </div>
              <p v-if="testNote" class="dm-note">{{ testNote }}</p>
              </div>

            </div>

            <footer class="dm-ft">
              <span>共 {{ sources.length }} 条 · 已启用 {{ enabledCount }} 条 · 改动即时保存</span>
              <button type="button" class="go" @click="closeDm">完成</button>
            </footer>
          </div>
        </div>
      </Transition>
    </Teleport>

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
/* 弹幕: the section prints what is in force, never the list. Anything that grows with the number of
   mirrors lives behind one button — a settings row that grew a line per endpoint pushed every sheet
   under it off screen the moment a second address was added. */
.row > .dmbtn {
  justify-self: end;
}
.dmbtn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 360px;
  height: 40px;
  padding: 0 11px 0 14px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--bg-elev-2);
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  transition: background var(--hov) var(--ease), border-color var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.dmbtn:hover {
  background: #e3e3ea;
}
.dmbtn:active {
  transform: scale(0.97);
  transition-duration: 0.1s;
}
.dmbtn .t {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dmbtn .dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--brand);
}
.dmbtn .dot.off {
  background: var(--text-faint);
}
.dmbtn svg {
  flex: none;
  opacity: 0.6;
}

/* The sheet. The scrim is fixed to the window, not to the page, because 设置 scrolls underneath it. */
.dm-scrim {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: grid;
  place-items: center;
  padding: 44px 24px;
  background: rgb(18 18 26 / 0.4);
}
.dm-dlg {
  display: flex;
  flex-direction: column;
  width: min(880px, 100%);
  max-height: 100%;
  overflow: hidden;
  border-radius: var(--r-modal);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
  outline: none;
}
.dm-hd {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 16px 18px 14px;
  border-bottom: 1px solid var(--line);
}
.dm-ht {
  min-width: 0;
}
.dm-ht b {
  display: block;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--text);
}
.dm-ht i {
  display: block;
  margin-top: 4px;
  font-size: 12.5px;
  font-style: normal;
  color: var(--text-dim);
}
.dm-x {
  margin-left: auto;
  flex: none;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: var(--text-dim);
  transition: color var(--hov) var(--ease), background var(--hov) var(--ease);
}
.dm-x:hover {
  color: var(--text);
  background: var(--bg-elev-2);
}
/* One column now that the tester lives on its own page: the rows take the whole width of the sheet
   instead of leaving a 366px hole on the right. */
.dm-body {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 16px 18px;
}
.dm-col {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
/* The list scrolls inside its column so the footer never slides away. */
.dm-scroll {
  position: relative;
  flex: 1;
  min-width: 0;
}
.dm-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  overflow-y: auto;
  padding-right: 4px;
}
/* With twelve rows the last visible one is cut by the fold; the fade says "there is more" instead of
   letting the cut read as a broken row. It is only there while something is below. */
.dm-fade {
  position: absolute;
  left: 0;
  right: 4px;
  bottom: 0;
  height: 30px;
  background: linear-gradient(to top, var(--bg-elev) 34%, transparent);
  pointer-events: none;
}
/* One line per mirror: order, switch, move up, name, address, remove. The order column is the walk's
   order, which is the only thing the row's position in this list means, so it can be changed here. */
/* The row lifts on hover and the whole line is the pick target: nothing in it is a button the viewer must
   aim at, and the address can grow without pushing the row's two switches off the edge. */
.dm-row {
  display: grid;
  grid-template-columns: 30px 44px 26px 100px minmax(0, 1fr) 26px;
  align-items: center;
  gap: 8px;
  padding: 3px 6px 3px 4px;
  margin: 0 -6px 0 -4px;
  border-radius: 10px;
  transition: background var(--hov) var(--ease), box-shadow var(--hov) var(--ease);
}
.dm-row:hover {
  background: color-mix(in srgb, var(--line) 16%, transparent);
}
/* The grip is the row's handle: dragging it moves the row anywhere in the list, a plain click lifts it one
   step (what the old ↑ button did, kept because a click is easier to discover than a drag). */
.dm-row .grip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--text-dim);
  opacity: 0.45;
  cursor: grab;
  transition: background var(--hov) var(--ease), color var(--hov) var(--ease), opacity var(--hov) var(--ease);
}
.dm-row:hover .grip,
.dm-row.sel .grip,
.dm-row .grip:focus-visible {
  opacity: 1;
}
.dm-row .grip:hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--accent);
}
.dm-row .grip:active {
  cursor: grabbing;
}
.dm-row .grip.first:not(:disabled) {
  opacity: 0.28;
}
.dm-row .grip:disabled {
  opacity: 0.16;
  cursor: default;
}
/* Where the dragged row will land, and the hole it left behind while it is in the air. */
.dm-row.drag {
  opacity: 0.4;
}
.dm-row.over {
  box-shadow: inset 0 2px 0 var(--accent);
}
/* The row 添加接口 just made: dashed border, because it is not stored until its address is complete. */
.dm-row.draft {
  background: color-mix(in srgb, var(--accent) 4%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 26%, transparent);
}
.dm-row.draft input.nm::placeholder,
.dm-row.draft input.ur::placeholder {
  color: color-mix(in srgb, var(--accent) 62%, var(--text-faint));
}
/* A quiet last line that adds a row: with two endpoints the list looked like a dead end whose floor was
   missing, and the header button was the only sign that more rows were allowed. */
.dm-ghost {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 34px;
  margin-top: 2px;
  border: 1px dashed color-mix(in srgb, var(--line) 92%, transparent);
  border-radius: 10px;
  background: none;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--text-dim);
  cursor: pointer;
  transition: color var(--hov) var(--ease), border-color var(--hov) var(--ease), background var(--hov) var(--ease);
}
.dm-ghost:hover:not(:disabled) {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  background: color-mix(in srgb, var(--accent) 5%, transparent);
}
.dm-ghost:disabled {
  color: var(--text-faint);
  cursor: default;
}
/* Order and the row's own verdict share one cell: the number is the walk's position, the lamp is what the
   last test said about this endpoint. Always reserved, so a fresh verdict never shifts the name column. */
.dm-ord {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: var(--text-faint);
  text-align: center;
}
.dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--line);
  transition: background var(--hov) var(--ease), box-shadow var(--hov) var(--ease);
}
.dm-row[data-state='ok'] .dot,
.dm-rh .dot,
.dm-tname .dot.ok {
  background: #2f9e6a;
  box-shadow: 0 0 0 2px color-mix(in srgb, #2f9e6a 20%, transparent);
}
.dm-row[data-state='bad'] .dot,
.dm-res.bad .dm-rh .dot,
.dm-tname .dot.bad {
  background: var(--danger);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--danger) 18%, transparent);
}
.dm-row[data-state='busy'] .dot,
.dm-tname .dot.busy {
  background: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent);
  animation: dmpulse 1.1s ease-in-out infinite;
}
@keyframes dmpulse {
  50% {
    opacity: 0.3;
  }
}
/* White fields on a white sheet, not grey ones: a filled address in a grey box reads as an empty box with
   something written in it. The name is the louder of the two, the address is reference material. */
.dm-row input,
.dm-kw {
  height: 34px;
  min-width: 0;
  padding: 0 9px;
  border-radius: 9px;
  background: #fff;
  border: 1px solid var(--line);
  outline: none;
  color: var(--text);
  font-size: 12.5px;
  transition: border-color var(--hov) var(--ease), box-shadow var(--hov) var(--ease), background var(--hov) var(--ease);
}
.dm-row input.nm {
  font-weight: 600;
}
.dm-row input.ur {
  font-size: 12px;
  color: var(--text-dim);
}
.dm-row input::placeholder,
.dm-kw::placeholder {
  color: var(--text-faint);
}
.dm-row input:hover,
.dm-kw:hover {
  border-color: color-mix(in srgb, var(--text) 26%, transparent);
}
.dm-row input:focus,
.dm-kw:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
  background: #fff;
}
/* A row that is switched off stays readable but obviously out of the walk. */
/* A ring, drawn inside the row: an outline offset outward is clipped by the list's own scroll box, so the
   selection used to show up as a stray line under the first row. */
.dm-row.sel {
  background: color-mix(in srgb, var(--accent) 7%, transparent);
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--accent) 42%, transparent);
}
.dm-row.sel:hover {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.dm-row.sel .dm-ord {
  color: var(--accent);
  font-weight: 700;
}
.dm-row.off input {
  color: var(--text-faint);
  background: var(--bg-elev-2);
}
.dm-row.off input.ur {
  color: var(--text-faint);
}
.go.tiny {
  height: 34px;
  padding: 0 12px;
  font-size: 12.5px;
}
.kill {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: var(--text-dim);
  transition: color var(--hov) var(--ease), background var(--hov) var(--ease);
}
.dm-row .kill {
  opacity: 0.55;
}
.dm-row:hover .kill,
.dm-row .kill:focus-visible {
  opacity: 1;
}
.kill:hover:not(:disabled) {
  color: var(--danger);
  background: var(--bg-elev-2);
}
.kill:disabled {
  color: var(--text-faint);
}
.dm-note {
  margin: 2px 0 0;
  font-size: 12.5px;
  color: var(--danger);
}
/* The tester: pick a row, ask it, read four answers. One primary 开始测试 asks the picked row; the walk
   above the list asks every enabled row in turn, because with five mirrors that was five picks and five waits. */
.dm-test {
  padding-left: 18px;
  border-left: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
@media (max-width: 820px) {
  .dm-test {
    padding-left: 0;
    padding-top: 14px;
    border-left: 0;
    border-top: 1px solid var(--line);
  }
}
.dm-thead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
/* It sits in the heading, not beside 开始测试: two buttons side by side would look like two halves of one
   question, and this one asks a different question of a different set of rows. */
.dm-all {
  border: 0;
  padding: 0;
  background: none;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  cursor: pointer;
  transition: color var(--hov) var(--ease);
}
.dm-all:hover:not(:disabled) {
  color: color-mix(in srgb, var(--accent) 78%, #000);
  text-decoration: underline;
}
.dm-all:disabled {
  color: var(--text-faint);
  cursor: default;
}
/* Which row, where it points, and the question: one card, because these three belong together and a stack
   of label/value lines read like a form the viewer should fill in. */
.dm-tcard {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 12px 13px 13px;
  border-radius: 14px;
  background: var(--bg-elev-2);
}
.dm-tname {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.dm-tname b {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}
.dm-tname em {
  flex: none;
  margin-left: auto;
  padding: 1px 7px;
  border-radius: 999px;
  font-style: normal;
  font-size: 11px;
  color: var(--text-dim);
  background: color-mix(in srgb, var(--text) 7%, transparent);
}
.dm-turl {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--text-dim);
}
.dm-go {
  display: flex;
  gap: 8px;
}
.dm-kw {
  flex: 1;
  min-width: 0;
}
.go.primary {
  flex: none;
  height: 34px;
  padding: 0 15px;
  border-color: transparent;
  background: var(--accent);
  color: #fff;
  font-size: 12.5px;
}
.go.primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 86%, #000);
}
.go.primary:disabled {
  border-color: var(--line);
  background: var(--bg-elev-2);
  color: var(--text-faint);
}
.dm-idle {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 12px 13px;
  border: 1px dashed color-mix(in srgb, var(--line) 72%, transparent);
  border-radius: 14px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-faint);
}
.dm-idle b {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
}
.dm-ft {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 18px;
  border-top: 1px solid var(--line);
  background: var(--bg-elev-2);
}
.dm-ft span {
  font-size: 12.5px;
  color: var(--text-dim);
}
.dm-ft .go {
  height: 34px;
  padding: 0 18px;
}
.dmfade-enter-active,
.dmfade-leave-active {
  transition: opacity 0.18s var(--ease);
}
.dmfade-enter-from,
.dmfade-leave-to {
  opacity: 0;
}
/* The verdict, stamped: one word and a lamp at the top, then the four questions in the order a viewer
   would ask them. Each step carries its own timing, because 「立刻 403」 and 「等了 8 秒才超时」 are
   different problems and the answer card should not make anyone guess which one they have. */
.dm-res {
  display: flex;
  flex-direction: column;
  padding: 11px 13px 12px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: #fff;
}
.dm-res.bad {
  border-color: color-mix(in srgb, var(--danger) 32%, var(--line));
  background: color-mix(in srgb, var(--danger) 3%, #fff);
}
.dm-rh {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 6px;
}
.dm-rh b {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.dm-res.bad .dm-rh b {
  color: var(--danger);
}
.dm-rh em {
  margin-left: auto;
  font-style: normal;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: var(--text-faint);
}
.dm-step {
  display: grid;
  grid-template-columns: 13px 74px minmax(0, 1fr);
  gap: 6px;
  padding: 2.5px 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-dim);
}
.dm-step .mk {
  color: #2f9e6a;
  font-weight: 700;
  text-align: center;
}
.dm-step .lb {
  color: var(--text);
}
.dm-step .dt {
  font-size: 11.5px;
}
.dm-step.bad .mk,
.dm-step.bad .dt {
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