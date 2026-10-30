<script setup lang="ts">
/**
 * 弹幕调试 —— 弹幕接口的独立调试页，从 设置 → 弹幕 → 接口调试 进来。
 *
 * Two jobs on one page, because they answer the same question in two registers: 弹幕测试 walks the ladder a
 * viewer actually cares about (a filename, or a title they typed) and ends with the comments themselves —
 * count, spread, colour and text — while 接口调试 lets anyone put a path on the wire and read the answer
 * verbatim. Everything goes through the main process (danmaku:debug), so requests carry the same headers,
 * the same proxy and the same timeouts the player uses; nothing here is cached, so a test never lies about
 * what the endpoint would say at playback time.
 *
 * The lists are the point of the page: an endpoint that answers 「2 部」 is not yet an endpoint that can be
 * played, and the six numbers under the title (how many, over what span, where they bunch, how many are
 * coloured) are what tells a working row from a row that returns 40 comments for a 24-minute episode.
 */
import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { DanmakuDebugReply, DanmakuSource } from '../../shared/types';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const router = useRouter();

/* ------------------------------------------------------------------ 接口 */

const sources = computed<DanmakuSource[]>(() =>
  (store.config?.settings?.danmaku?.sources || []).filter(s => /^https?:\/\/[^\s]+$/i.test(s.url)),
);
const baseId = ref('');

/* The config arrives after the first render, so the pick cannot be made once on mount: a page opened by
 *  reloading straight onto #/danmaku found an empty list, kept an empty id, and every button on it stayed
 *  disabled for as long as it was open (measured). Watching the list also handles the row being deleted or
 *  switched while the page is in front of the viewer. */
watch(
  sources,
  list => {
    if (baseId.value && list.some(s => s.id === baseId.value)) return;
    const first = list.find(s => s.enabled) || list[0];
    baseId.value = first ? first.id : '';
  },
  { immediate: true },
);

const base = computed(() => sources.value.find(s => s.id === baseId.value)?.url || '');

interface Reply {
  status: number;
  ms: number;
  bytes: number;
  text: string;
  error?: string;
  json: unknown;
}

/** One request, decoded as far as JSON goes. json stays null for anything that is not JSON. */
async function ask(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<Reply> {
  const empty: Reply = { status: 0, ms: 0, bytes: 0, text: '', json: null };
  if (!base.value) return { ...empty, error: '还没有可用的接口地址' };
  const r = await window.echoemby.danmaku.debug({ base: base.value, path, method, body });
  if (!r.ok || !r.data) return { ...empty, error: r.error || '主进程没有回话' };
  const d: DanmakuDebugReply = r.data;
  let json: unknown = null;
  try {
    json = JSON.parse(d.text);
  } catch {
    json = null;
  }
  return { status: d.status, ms: d.ms, bytes: d.bytes, text: d.text, ...(d.error ? { error: d.error } : {}), json };
}

/* ------------------------------------------------------------------ 小工具 */

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const pad2 = (n: number): string => (n < 10 ? '0' + n : String(n));

const mmss = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? h + ':' + pad2(m) + ':' + pad2(r) : m + ':' + pad2(r);
};
const sizeOf = (bytes: number): string =>
  bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : bytes >= 1024 ? Math.round(bytes / 1024) + ' KB' : bytes + ' B';
const hex = (n: number): string => '#' + (n & 0xffffff).toString(16).padStart(6, '0');
const MODE_NAME: Record<number, string> = { 1: '滚动', 4: '底部', 5: '顶部' };
const modeName = (m: number): string => MODE_NAME[m] || '其它';
const modeClass = (m: number): string => 'm' + m;

/** 2023-09-29T00:00:00 → 2023 */
const yearOf = (d: string): string => (/^\d{4}/.test(d) ? d.slice(0, 4) : '');

/* ------------------------------------------------------------------ 弹幕数据 */

interface Dm {
  time: number;
  mode: number;
  color: number;
  text: string;
}

interface Loaded {
  id: string;
  title: string;
  episode: string;
  poster: string;
  rows: Dm[];
  duration: number;
  ms: number;
  bytes: number;
}

/** Each test keeps its own screen: the file name or keyword that was typed, the episode that came back,
 *  the list filter, how many rows are on show. Sharing one set of refs meant switching subtabs walked into
 *  whatever the other test had asked for last, and an answer for 手动 appeared under 自动's heading. */
interface Pane {
  loaded: Loaded | null;
  busy: boolean;
  note: string;
  q: string;
  mode: number;
  limit: number;
}

const emptyPane = (): Pane => ({ loaded: null, busy: false, note: '', q: '', mode: 0, limit: 300 });
const autoPane = reactive<Pane>(emptyPane());
const manualPane = reactive<Pane>(emptyPane());

/** Which subtab is in front. Declared here because the pane, the disabled states and the result panel all
 *  read it; the buttons that set it are further down. */
const sub = ref<'auto' | 'manual'>('auto');
const pane = computed<Pane>(() => (sub.value === 'auto' ? autoPane : manualPane));

const parseRow = (p: string, m: string): Dm | null => {
  const f = p.split(',');
  const time = Number(f[0]);
  if (!Number.isFinite(time) || !m) return null;
  return { time, mode: Number(f[1]) || 1, color: Number(f[2]) || 16777215, text: m };
};

async function loadEpisode(p: Pane, id: string, title: string, episode: string, poster = ''): Promise<void> {
  p.busy = true;
  p.note = '';
  const r = await ask('/api/v2/comment/' + encodeURIComponent(id) + '?format=json&duration=true');
  p.busy = false;
  if (!r.status) {
    p.note = r.error || '请求失败';
    return;
  }
  const rows = list(obj(r.json).comments);
  if (r.status < 200 || r.status >= 300 || !rows.length) {
    p.note = r.status >= 300 ? '接口返回 HTTP ' + r.status : '这一集没有弹幕';
    p.loaded = null;
    return;
  }
  const parsed: Dm[] = [];
  for (const row of rows) {
    const one = parseRow(str(obj(row).p), str(obj(row).m));
    if (one) parsed.push(one);
  }
  parsed.sort((a, b) => a.time - b.time);
  p.loaded = {
    id,
    title,
    episode,
    poster,
    rows: parsed,
    duration: num(obj(r.json).videoDuration),
    ms: r.ms,
    bytes: r.bytes,
  };
}

const span = computed(() => {
  const L = pane.value.loaded;
  if (!L) return 0;
  if (L.duration > 0) return L.duration;
  return L.rows.length ? L.rows[L.rows.length - 1].time + 3 : 0;
});

const counts = computed(() => {
  const c = { all: 0, scroll: 0, bottom: 0, top: 0, color: 0 };
  for (const r of pane.value.loaded?.rows || []) {
    c.all += 1;
    if (r.mode === 1) c.scroll += 1;
    else if (r.mode === 4) c.bottom += 1;
    else if (r.mode === 5) c.top += 1;
    if (r.color !== 16777215) c.color += 1;
  }
  return c;
});

/** The busiest 30 seconds — the reference's 高能时刻, and the quickest read of whether the comments are
 *  spread over the episode or dumped at the opening titles. */
const peak = computed((): { at: number; n: number } => {
  const rows = pane.value.loaded?.rows || [];
  let best = { at: 0, n: 0 };
  let j = 0;
  for (let i = 0; i < rows.length; i += 1) {
    while (j < rows.length && rows[j].time - rows[i].time <= 30) j += 1;
    if (j - i > best.n) best = { at: rows[i].time, n: j - i };
  }
  return best;
});

const density = computed(() => (span.value > 0 ? counts.value.all / (span.value / 60) : 0));
const colorPct = computed(() => (counts.value.all ? (counts.value.color / counts.value.all) * 100 : 0));

/** 72 columns over the episode, each a stack of the three positions. Fixed count rather than one per
 *  minute: a 24-minute episode and a 3-hour film have to read the same shape. */
const BARS = 72;
const bars = computed(() => {
  const rows = pane.value.loaded?.rows || [];
  const n = span.value || 1;
  const out = Array.from({ length: BARS }, () => ({ s: 0, t: 0, b: 0, n: 0 }));
  for (const r of rows) {
    const i = Math.min(BARS - 1, Math.max(0, Math.floor((r.time / n) * BARS)));
    if (r.mode === 4) out[i].b += 1;
    else if (r.mode === 5) out[i].t += 1;
    else out[i].s += 1;
    out[i].n += 1;
  }
  const top = Math.max(1, ...out.map(b => b.n));
  return out.map(b => ({ ...b, h: b.n / top }));
});

const barH = (h: number): string => Math.max(2, h * 100) + '%';

/* ------------------------------------------------------------------ 列表 */

/** A fresh load clears the filter for the test that loaded it — not for the other one, which is sitting on
 *  its own rows and its own search box. */
for (const p of [autoPane, manualPane]) {
  watch(
    () => p.loaded,
    () => {
      p.q = '';
      p.mode = 0;
      p.limit = 300;
    },
  );
}

const filtered = computed(() => {
  const p = pane.value;
  const rows = p.loaded?.rows || [];
  const term = p.q.trim();
  return rows.filter(r => (!p.mode || r.mode === p.mode) && (!term || r.text.includes(term)));
});
const shown = computed(() => filtered.value.slice(0, pane.value.limit));

/* ------------------------------------------------------------------ 自动匹配 */

const fileName = ref('');
const matches = ref<{ id: string; title: string; episode: string; type: string; image: string }[]>([]);

async function runAuto(): Promise<void> {
  const p = autoPane;
  const name = fileName.value.trim();
  if (!name) {
    p.note = '先填一个文件名';
    return;
  }
  p.busy = true;
  p.note = '';
  matches.value = [];
  const r = await ask('/api/v2/match', 'POST', {
    fileName: name,
    fileHash: '0'.repeat(32),
    fileSize: 1,
    videoDuration: 0,
    matchMode: 'hashAndFileName',
  });
  p.busy = false;
  if (!r.status) {
    p.note = r.error || '请求失败';
    return;
  }
  const rows = list(obj(r.json).matches);
  matches.value = rows.map(row => {
    const o = obj(row);
    return {
      id: String(num(o.episodeId)),
      title: str(o.animeTitle),
      episode: str(o.episodeTitle),
      type: str(o.typeDescription) || str(o.type),
      image: str(o.imageUrl),
    };
  });
  if (!matches.value.length) {
    p.note = 'HTTP ' + r.status + ' · 这个文件名没有匹配到作品';
    return;
  }
  const first = matches.value[0];
  await loadEpisode(p, first.id, first.title, first.episode, first.image);
}

/* ------------------------------------------------------------------ 手动匹配 */

interface AnimeRow {
  id: string;
  title: string;
  type: string;
  year: string;
  episodes: number;
  image: string;
}

const keyword = ref('');
const animes = ref<AnimeRow[]>([]);
const anime = ref<AnimeRow | null>(null);
const episodes = ref<{ id: string; no: string; title: string }[]>([]);
const jump = ref('');

async function runSearch(): Promise<void> {
  const p = manualPane;
  const word = keyword.value.trim();
  if (!word) {
    p.note = '先填一个关键词';
    return;
  }
  p.busy = true;
  p.note = '';
  animes.value = [];
  episodes.value = [];
  anime.value = null;
  const r = await ask('/api/v2/search/anime?keyword=' + encodeURIComponent(word));
  p.busy = false;
  if (!r.status) {
    p.note = r.error || '请求失败';
    return;
  }
  animes.value = list(obj(r.json).animes).map(row => {
    const o = obj(row);
    return {
      id: String(num(o.animeId)),
      title: str(o.animeTitle),
      type: str(o.typeDescription) || str(o.type),
      year: yearOf(str(o.startDate)),
      episodes: num(o.episodeCount),
      image: str(o.imageUrl),
    };
  });
  if (!animes.value.length) p.note = 'HTTP ' + r.status + ' · 没有搜到作品';
}

async function openAnime(a: AnimeRow): Promise<void> {
  const p = manualPane;
  p.busy = true;
  p.note = '';
  anime.value = a;
  episodes.value = [];
  const r = await ask('/api/v2/bangumi/' + encodeURIComponent(a.id));
  p.busy = false;
  if (!r.status) {
    p.note = r.error || '请求失败';
    return;
  }
  const rows = list(obj(obj(r.json).bangumi).episodes);
  episodes.value = rows.map(row => {
    const o = obj(row);
    // The number and the name stay apart: a danmu_api title already says 「【dandan】 第1话 冒险结束」, and
    // gluing 「第1话」 onto its front printed the same words twice on one row.
    return { id: String(num(o.episodeId)), no: str(o.episodeNumber), title: str(o.episodeTitle) };
  });
  jump.value = '';
}

/** What the header calls the episode once loaded: the number, then the name it came with. */
const epLabel = (e: { no: string; title: string }): string => (e.no ? '第 ' + e.no + ' 集 · ' : '') + e.title;

function jumpTo(): void {
  const n = Number(jump.value);
  if (!Number.isFinite(n) || n < 1) return;
  const hit = episodes.value[n - 1];
  if (hit && anime.value) void loadEpisode(manualPane, hit.id, anime.value.title, hit.title, anime.value.image);
}

/* ------------------------------------------------------------------ 接口调试 */

const PRESETS: { label: string; method: 'GET' | 'POST'; path: string; body?: string }[] = [
  { label: '搜作品', method: 'GET', path: '/api/v2/search/anime?keyword=芙莉莲' },
  { label: '搜剧集', method: 'GET', path: '/api/v2/search/episodes?anime=芙莉莲&episode=1' },
  { label: '作品详情', method: 'GET', path: '/api/v2/bangumi/17617' },
  { label: '取弹幕', method: 'GET', path: '/api/v2/comment/10027?format=json&duration=true' },
  { label: '按文件名匹配', method: 'POST', path: '/api/v2/match', body: '{\n  "fileName": "Frieren.S01E05.1080p.mkv"\n}' },
];

const rawMethod = ref<'GET' | 'POST'>('GET');
const rawPath = ref('/api/v2/search/anime?keyword=芙莉莲');
const rawBody = ref('{\n  "fileName": "Frieren.S01E05.1080p.mkv"\n}');
const raw = ref<Reply | null>(null);
const rawBusy = ref(false);

/** A preset only fills the form: nothing is asked until 发送 is pressed, so the path and the body can be
 *  read (and corrected) before the request leaves. The answer on screen belonged to the previous question,
 *  so it goes away rather than sitting under a form that now says something else. */
function usePreset(p: { label: string; method: 'GET' | 'POST'; path: string; body?: string }): void {
  rawMethod.value = p.method;
  rawPath.value = p.path;
  rawBody.value = p.body ? p.body : rawBody.value;
  raw.value = null;
}

async function send(): Promise<void> {
  rawBusy.value = true;
  raw.value = null;
  let body: unknown;
  if (rawMethod.value === 'POST') {
    try {
      body = rawBody.value.trim() ? JSON.parse(rawBody.value) : undefined;
    } catch {
      raw.value = { status: 0, ms: 0, bytes: 0, text: '', json: null, error: '请求体不是 JSON' };
      rawBusy.value = false;
      return;
    }
  }
  raw.value = await ask(rawPath.value.trim(), rawMethod.value, body);
  rawBusy.value = false;
}

const pretty = computed(() => {
  const r = raw.value;
  if (!r) return '';
  if (!r.text) return r.error || '（没有回话）';
  try {
    return JSON.stringify(JSON.parse(r.text), null, 2);
  } catch {
    return r.text;
  }
});

const tab = ref<'test' | 'raw'>('test');

/** 返回 walks back through the app's own history so the sheet slides back out the way it came in. A page
 *  reached by a reload or a pasted address has nothing behind it, and back() would step onto the blank
 *  entry the window started on - that case goes forward to 设置 instead, which also animates as a pop
 *  because 设置 ranks one step shallower. */
function goBack(): void {
  if ((window.history.state as { back?: string } | null)?.back) router.back();
  else void router.push('/settings');
}
</script>

<template>
  <div class="page">
    <div class="col">
      <header class="head">
        <button class="back" type="button" title="返回" @click="goBack">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 5 8 12l7 7" />
          </svg>
        </button>
        <h1>弹幕调试</h1>
        <div class="src">
          <span class="lb">接口</span>
          <select v-model="baseId" class="sel">
            <option v-for="s in sources" :key="s.id" :value="s.id">{{ s.name }}{{ s.enabled ? '' : '（已关闭）' }}</option>
          </select>
          <button class="link" type="button" @click="router.push('/settings')">管理</button>
        </div>
      </header>

      <nav class="tabs">
        <button type="button" :class="{ on: tab === 'test' }" @click="tab = 'test'">弹幕测试</button>
        <button type="button" :class="{ on: tab === 'raw' }" @click="tab = 'raw'">接口调试</button>
      </nav>

      <div class="body">
        <p v-if="!sources.length" class="warn">
          还没有可用的接口地址。<button class="link" type="button" @click="router.push('/settings')">去设置里添加</button>
        </p>

        <template v-if="tab === 'test'">
          <div class="subtabs">
            <button type="button" :class="{ on: sub === 'auto' }" @click="sub = 'auto'">自动匹配测试</button>
            <button type="button" :class="{ on: sub === 'manual' }" @click="sub = 'manual'">手动匹配测试</button>
          </div>

          <section v-if="sub === 'auto'" class="card">
            <p class="hint">模拟播放器自动匹配流程：输入文件名 → 匹配剧集 → 获取弹幕</p>
            <div class="line">
              <input v-model="fileName" type="text" placeholder="例如 Frieren.S01E05.1080p.mkv / 葬送的芙莉莲.S01E03.mkv" spellcheck="false" @keydown.enter="runAuto" />
              <button class="go" type="button" :disabled="pane.busy || !base" @click="runAuto">{{ pane.busy ? '请求中…' : '开始匹配' }}</button>
            </div>
            <div v-if="matches.length" class="match">
              <span class="mlab">匹配到 {{ matches.length }} 条</span>
              <button v-for="m in matches.slice(0, 6)" :key="m.id" type="button" class="mrow" @click="loadEpisode(autoPane, m.id, m.title, m.episode, m.image)">
                <b>{{ m.title || m.id }}</b>
                <i>{{ m.episode || '（没有集名）' }}</i>
              </button>
            </div>
          </section>

          <section v-else-if="sub === 'manual'" class="card">
            <p class="hint">模拟播放器手动搜索流程：搜索动漫 → 选择番剧 → 选择剧集 → 获取弹幕</p>
            <div class="line">
              <input v-model="keyword" type="text" placeholder="搜索关键词，例如 芙莉莲" spellcheck="false" @keydown.enter="runSearch" />
              <button class="go" type="button" :disabled="pane.busy || !base" @click="runSearch">{{ pane.busy ? '搜索中…' : '搜索' }}</button>
            </div>

            <div v-if="animes.length && !anime" class="animes">
              <button v-for="a in animes" :key="a.id" type="button" class="anime" @click="openAnime(a)">
                <span class="poster">
                  <img v-if="a.image" :src="a.image" alt="" loading="lazy" referrerpolicy="no-referrer" />
                </span>
                <b>{{ a.title }}</b>
                <i>{{ a.year || '年份未知' }}<template v-if="a.type"> · {{ a.type }}</template><template v-if="a.episodes"> · 共 {{ a.episodes }} 集</template></i>
              </button>
            </div>

            <div v-if="anime" class="eps">
              <div class="ephead">
                <button class="link" type="button" @click="anime = null">← 返回搜索结果</button>
                <b>{{ anime.title }}</b>
              </div>
              <div class="jump">
                <span>跳转到第</span>
                <input v-model="jump" type="text" inputmode="numeric" placeholder="集数" @keydown.enter="jumpTo" />
                <span>集</span>
                <button class="mini" type="button" @click="jumpTo">跳转</button>
                <span class="dim">共 {{ episodes.length }} 集</span>
              </div>
              <div class="eplist">
                <button v-for="e in episodes" :key="e.id" type="button" class="eprow" @click="loadEpisode(manualPane, e.id, anime.title, epLabel(e), anime.image)">
                  <span v-if="e.no" class="epno">第 {{ e.no }} 集</span>
                  <span class="epname">{{ e.title }}</span>
                  <span class="epgo" :class="{ on: manualPane.loaded?.id === e.id }">{{ manualPane.loaded?.id === e.id ? '已加载' : '获取弹幕' }}</span>
                </button>
              </div>
            </div>
          </section>

          <p v-if="pane.note" class="note">{{ pane.note }}</p>

          <section v-if="pane.loaded" class="result">
            <header class="rhead">
              <div class="rt">
                <b>{{ pane.loaded.title || pane.loaded.id }}</b>
                <i>{{ pane.loaded.episode }}</i>
              </div>
            </header>

            <div class="stats">
              <div class="stat"><b>{{ counts.all }}</b><i>弹幕数</i></div>
              <div class="stat"><b>{{ mmss(span) }}</b><i>时长</i></div>
              <div class="stat"><b>{{ mmss(peak.at) }} - {{ mmss(Math.min(span, peak.at + 30)) }}</b><i>高能时刻</i></div>
              <div class="stat"><b>{{ density.toFixed(1) }} 条/分</b><i>平均密度</i></div>
              <div class="stat"><b>{{ (pane.loaded.ms / 1000).toFixed(2) }}s</b><i>请求耗时</i></div>
              <div class="stat"><b>{{ colorPct.toFixed(1) }}%</b><i>彩色占比</i></div>
            </div>

            <div class="panel">
              <div class="ptitle">弹幕热力图</div>
              <div class="heat">
                <div v-for="(b, i) in bars" :key="i" class="bar" :style="{ height: barH(b.h) }">
                  <span v-if="b.b" class="sb" :style="{ flex: b.b }" />
                  <span v-if="b.t" class="st" :style="{ flex: b.t }" />
                  <span v-if="b.s" class="ss" :style="{ flex: b.s }" />
                </div>
              </div>
              <div class="axis"><span>0:00</span><span>{{ mmss(span / 2) }}</span><span>{{ mmss(span) }}</span></div>
              <div class="legend"><i class="ls" />滚动<i class="lt" />顶部<i class="lb2" />底部</div>
            </div>

            <div class="panel">
              <div class="ptitle">弹幕列表</div>
              <div class="line">
                <input v-model="pane.q" type="text" placeholder="搜索弹幕内容" spellcheck="false" />
              </div>
              <div class="chips">
                <button type="button" :class="{ on: pane.mode === 0 }" @click="pane.mode = 0">全部 {{ counts.all }}</button>
                <button type="button" :class="{ on: pane.mode === 1 }" @click="pane.mode = 1">滚动 {{ counts.scroll }}</button>
                <button type="button" :class="{ on: pane.mode === 5 }" @click="pane.mode = 5">顶部 {{ counts.top }}</button>
                <button type="button" :class="{ on: pane.mode === 4 }" @click="pane.mode = 4">底部 {{ counts.bottom }}</button>
              </div>
              <div class="rows">
                <div v-for="(r, i) in shown" :key="i" class="row">
                  <span class="time">{{ mmss(r.time) }}</span>
                  <span class="cdot" :style="{ background: hex(r.color) }" :title="hex(r.color)" />
                  <span class="modelab" :class="modeClass(r.mode)">{{ modeName(r.mode) }}</span>
                  <span class="text">{{ r.text }}</span>
                </div>
                <button v-if="filtered.length > shown.length" class="more" type="button" @click="pane.limit += 300">
                  还有 {{ filtered.length - shown.length }} 条，继续显示
                </button>
                <p v-if="!filtered.length" class="hint pad">没有匹配的弹幕。</p>
              </div>
            </div>
          </section>
        </template>

        <template v-else>
          <section class="card">
            <p class="hint">直接向这个接口发一次请求，拿到原始回话。不做缓存、不做重试，超时 25 秒。</p>
            <div class="presets">
              <button v-for="p in PRESETS" :key="p.label" type="button" class="chip" @click="usePreset(p)">{{ p.label }}</button>
            </div>
            <div class="line">
              <select v-model="rawMethod" class="sel small"><option value="GET">GET</option><option value="POST">POST</option></select>
              <input v-model="rawPath" type="text" spellcheck="false" placeholder="/api/v2/search/anime?keyword=..." @keydown.enter="send" />
              <button class="go" type="button" :disabled="rawBusy || !base" @click="send">{{ rawBusy ? '请求中…' : '发送' }}</button>
            </div>
            <textarea v-if="rawMethod === 'POST'" v-model="rawBody" class="bodyinput" spellcheck="false" rows="5" />
            <p class="hint mono">{{ base }}{{ rawPath }}</p>
          </section>

          <section v-if="raw" class="panel">
            <div class="rsum">
              <span class="badge" :class="{ bad: !raw.status || raw.status >= 300 }">{{ raw.status || '无响应' }}</span>
              <span class="dim">{{ raw.ms }} ms</span>
              <span class="dim">{{ sizeOf(raw.bytes) }}</span>
              <span v-if="raw.error" class="bad">{{ raw.error }}</span>
            </div>
            <pre class="code">{{ pretty }}</pre>
          </section>
        </template>
      </div>
    </div>
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
.col {
  display: flex;
  flex-direction: column;
  height: 100%;
  max-width: 1180px;
  margin: 0 auto;
  padding-top: calc(var(--titlebar-h) + 18px);
}
.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
}
.head h1 {
  margin: 0;
  font-size: clamp(20px, 2.3vw, 26px);
  font-weight: 700;
  letter-spacing: -0.3px;
}
.back {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--bg-elev);
  color: var(--text-dim);
  cursor: pointer;
  transition: color var(--hov) var(--ease), border-color var(--hov) var(--ease);
}
.back:hover {
  color: var(--text);
  border-color: var(--line-strong);
}
.src {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.lb {
  font-size: 12.5px;
  color: var(--text-faint);
}
.sel {
  height: 32px;
  max-width: 300px;
  padding: 0 8px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: 12.5px;
  font-family: inherit;
}
.sel.small {
  height: 30px;
  max-width: 130px;
}
.link {
  border: 0;
  background: none;
  padding: 0;
  color: var(--accent);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.tabs {
  flex: none;
  display: flex;
  margin-top: 16px;
  border-bottom: 1px solid var(--line);
}
.tabs button {
  position: relative;
  padding: 9px 4px 11px;
  margin-right: 18px;
  border: 0;
  background: none;
  color: var(--text-faint);
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
}
.tabs button.on {
  color: var(--text);
}
.tabs button.on::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
}
.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 2px 40px;
}
.subtabs {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}
.subtabs button {
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-elev);
  color: var(--text-dim);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: color var(--hov) var(--ease), border-color var(--hov) var(--ease), background var(--hov) var(--ease);
}
.subtabs button.on {
  border-color: transparent;
  background: var(--accent);
  color: #fff;
}
.card {
  padding: 14px 16px 16px;
  margin-bottom: 14px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--bg-elev);
  box-shadow: var(--shadow-sm);
}
.hint {
  margin: 0 0 10px;
  font-size: 12.5px;
  color: var(--text-faint);
}
.hint.pad {
  padding: 12px;
}
.hint.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  margin: 10px 0 0;
  word-break: break-all;
}
.line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.line input {
  flex: 1;
  min-width: 0;
  height: 36px;
  padding: 0 11px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
}
.line input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.go {
  flex: none;
  height: 36px;
  padding: 0 18px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.go:disabled {
  background: var(--bg-elev-2);
  color: var(--text-faint);
  border-color: var(--line);
  cursor: default;
}
.go.small {
  height: 30px;
  padding: 0 13px;
  font-size: 12.5px;
}
.match {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-top: 12px;
}
.mlab {
  font-size: 12px;
  color: var(--text-faint);
}
.mrow {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  max-width: 300px;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--bg);
  text-align: left;
  cursor: pointer;
}
.mrow b {
  font-size: 12.5px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mrow i {
  font-size: 11.5px;
  color: var(--text-faint);
  font-style: normal;
}
.animes {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: 12px;
  margin-top: 14px;
}
.anime {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--bg);
  text-align: left;
  cursor: pointer;
  transition: border-color var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.anime:hover {
  border-color: var(--line-strong);
  transform: translateY(-1px);
}
.poster {
  display: block;
  aspect-ratio: 2 / 3;
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-elev-2);
}
.poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.anime b {
  font-size: 12.5px;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.anime i {
  font-size: 11px;
  color: var(--text-faint);
  font-style: normal;
}
.eps {
  margin-top: 14px;
}
.ephead {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.ephead b {
  font-size: 13px;
}
.jump {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--bg);
  font-size: 12.5px;
  color: var(--text-dim);
}
.jump input {
  width: 68px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--bg-elev);
  color: var(--text);
  font-family: inherit;
  font-size: 12.5px;
}
.jump .dim {
  margin-left: auto;
  color: var(--text-faint);
}
.mini {
  height: 28px;
  padding: 0 11px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.eplist {
  margin-top: 10px;
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: 10px;
}
.eprow {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 12px;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: none;
  text-align: left;
  cursor: pointer;
}
.eprow:last-child {
  border-bottom: 0;
}
.eprow:hover {
  background: var(--bg);
}
.epno {
  flex: none;
  min-width: 56px;
  color: var(--text-faint);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.epname {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.epgo {
  flex: none;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11.5px;
  font-weight: 600;
}
.epgo.on {
  background: color-mix(in srgb, var(--brand) 16%, transparent);
  color: var(--brand);
}
.note {
  margin: 0 0 12px;
  font-size: 12.5px;
  color: var(--text-faint);
}
.warn {
  margin: 0 0 12px;
  font-size: 12.5px;
  color: var(--danger);
}
.result {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.rhead {
  display: flex;
  align-items: flex-end;
  gap: 12px;
}
.rt {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.rt b {
  font-size: 14.5px;
}
.rt i {
  font-size: 12.5px;
  color: var(--text-faint);
  font-style: normal;
}
.ghost.on {
  border-color: color-mix(in srgb, var(--brand) 55%, transparent);
  color: var(--brand);
}
.stats {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 10px;
}
.stat {
  padding: 11px 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--bg-elev);
}
.stat b {
  display: block;
  font-size: 15px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.stat i {
  display: block;
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--text-faint);
  font-style: normal;
}
.panel {
  padding: 12px 14px 14px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--bg-elev);
}
.ptitle {
  font-size: 12.5px;
  font-weight: 700;
  margin-bottom: 10px;
}
.heat {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 120px;
  padding: 6px 6px 0;
  border-radius: 10px;
  background: var(--bg);
}
.bar {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  min-height: 2px;
  border-radius: 2px;
  overflow: hidden;
}
.ss,
.st,
.sb {
  display: block;
  width: 100%;
}
.ss,
.ls {
  background: #ef4b5f;
}
.st,
.lt {
  background: #a259e6;
}
.sb,
.lb2 {
  background: #3f7ef0;
}
.axis {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.legend {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--text-dim);
}
.legend i {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  margin-left: 6px;
}
.chips {
  display: flex;
  gap: 6px;
  margin: 10px 0;
}
.chips button {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-elev);
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.chips button.on {
  border-color: transparent;
  background: var(--accent);
  color: #fff;
}
.rows {
  max-height: 460px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: 10px;
}
.row {
  display: grid;
  grid-template-columns: 54px 8px 34px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--line);
  font-size: 12.5px;
}
.row:last-child {
  border-bottom: 0;
}
.time {
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
/* The colour a comment is printed in, as a dot. White is the default for almost every comment, and a white
 *  dot on a white row is nothing at all: the column looked empty on ordinary rows and populated only where
 *  someone had picked a colour, which read as colour being lost. The ring keeps white visible, and the title
 *  spells the colour out. */
.cdot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px var(--line-strong);
}
.modelab {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim);
}
/* Darker than the bars on purpose: the bars are 10px wide and read as colour, these are 11px text. */
.modelab.m5 {
  color: #8a3fd6;
}
.modelab.m4 {
  color: #2c66d6;
}
.text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.more {
  width: 100%;
  padding: 9px;
  border: 0;
  background: var(--bg);
  color: var(--accent);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.chip {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg);
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
}
.bodyinput {
  width: 100%;
  margin-top: 8px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--bg);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  resize: vertical;
}
.rsum {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  font-size: 12px;
}
.badge {
  padding: 2px 8px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--brand) 16%, transparent);
  color: var(--brand);
  font-weight: 700;
}
.badge.bad {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  color: var(--danger);
}
.dim {
  color: var(--text-faint);
}
.bad {
  color: var(--danger);
}
.code {
  margin: 0;
  max-height: 520px;
  overflow: auto;
  padding: 12px;
  border-radius: 10px;
  background: var(--bg);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  line-height: 1.55;
}
@media (max-width: 1100px) {
  .stats {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
