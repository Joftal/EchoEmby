<script setup lang="ts">
import { computed, ref } from 'vue';
import SubPopover from './SubPopover.vue';
import SubRow from './SubRow.vue';
import StepRow from './StepRow.vue';
import { usePlayerStore } from '../../stores/player';
import type { DanmakuAnime, DanmakuSettings } from '../../../shared/types';

const player = usePlayerStore();
const cfg = computed(() => player.prefs);

/** The knobs write straight through to the setting: the canvas reads the store every frame, so a stepper
 *  that moved has already changed what the next frame draws by the time the file write lands. */
function set(patch: Partial<DanmakuSettings>): void {
  void player.patchDanmaku(patch);
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** The row says which row is playing, in the terms the list uses: the work's title, plus the episode. */
const trackValue = computed(() => {
  if (player.dmLoading) return '载入中…';
  const t = player.dmCandidates.find(c => c.id === player.dmTrackId);
  if (!t) return player.dmCandidates.length ? '' : '没匹配到';
  return player.dmLink ? '手动链接' : t.exact ? '自动匹配' : '自动链接';
});

const words = computed(() => cfg.value.blockedWords.split(/[,，\n]/).map(w => w.trim()).filter(Boolean));

/** 屏蔽词 are applied on the way out of the main process, so a change here has to ask again for the track
 *  that is playing — the comments themselves come back from cache, no new download. */
async function setWords(list: string[]): Promise<void> {
  await player.patchDanmaku({ blockedWords: [...new Set(list)].join('\n') });
  const id = player.dmTrackId;
  if (id) await player.selectDanmaku(id, player.dmCandidates.find(c => c.id === id)?.shift || 0);
}

const newWord = ref('');
async function addWord(): Promise<void> {
  const w = newWord.value.trim();
  if (!w) return;
  await setWords([...words.value, w]);
  newWord.value = '';
}

// ---- 手动链接 -----------------------------------------------------------------

const word = ref('');
const results = ref<DanmakuAnime[]>([]);
const searched = ref(false);
const searchBusy = ref(false);
const picking = ref(false);
const linkNote = ref('');

async function runSearch(): Promise<void> {
  const q = word.value.trim();
  if (q.length < 2) {
    linkNote.value = '至少输入两个字';
    return;
  }
  searchBusy.value = true;
  linkNote.value = '';
  results.value = await player.searchDanmaku(q);
  searchBusy.value = false;
  searched.value = true;
}

/** Picking a work links the *episode that is playing* to the row at the same position inside that work: the
 *  service lists a show's episodes in order, so the number the library gives is the index to take. A film has
 *  one row and takes it. */
async function pick(anime: DanmakuAnime): Promise<void> {
  picking.value = true;
  linkNote.value = '';
  const eps = await player.danmakuEpisodes(anime.title, anime.id);
  const ep = player.dmEpisode;
  // A long runner's list comes back cut short (死神 lists 128 of its 366), so 第 131 集 cannot be indexed out of
  // it. Ask the service for that number directly; the auto match resolves the same way.
  const hit =
    (ep ? eps.find(e => e.title.includes(String(ep))) || eps[ep - 1] : eps[0]) ||
    (ep ? await player.danmakuEpisodeAt(anime.title, anime.id, ep) : null);
  picking.value = false;
  if (!hit) {
    linkNote.value = ep ? `这部作品里没有第 ${ep} 集` : '这部作品没有可用的分集';
    return;
  }
  await player.linkDanmaku({
    animeId: anime.id,
    animeTitle: anime.title,
    type: anime.type,
    episodeId: hit.id,
    episodeTitle: hit.title,
  });
  results.value = [];
  word.value = '';
  searched.value = false;
}

async function unlink(): Promise<void> {
  linkNote.value = '';
  results.value = [];
  word.value = '';
  searched.value = false;
  await player.linkDanmaku(null);
}

const epLabel = (t: { title: string; episode?: string; year?: number; type?: string; exact?: boolean; linked?: boolean }): string =>
  [t.year ? String(t.year) : '', t.type || ''].filter(Boolean).join(' · ');
</script>

<template>
  <div class="pl-switch" role="switch" tabindex="0" :aria-checked="player.danmakuOn" :class="{ on: player.danmakuOn }" @click="player.setDanmakuEnabled(!player.danmakuOn)">
    <span class="label">显示弹幕</span>
    <span class="track"><i></i></span>
  </div>
  <p class="pl-note">关掉之后不会再向弹幕服务发任何请求。链接与样式都存在本机。</p>

  <template v-if="player.danmakuOn">
    <div class="pl-sep"></div>
    <SubRow name="tracks" label="弹幕轨道" :value="trackValue" />
    <SubRow name="style" label="弹幕样式" :value="`${cfg.fontSize}px · ${pct(cfg.opacity)}`" />
    <SubRow name="tune" label="微调" :value="`${cfg.speed.toFixed(1)}×`" />
    <SubRow name="words" label="弹幕过滤" :value="words.length ? `${words.length} 个` : ''" />
  </template>

  <SubPopover name="tracks" title="弹幕轨道">
    <div class="pl-sect">手动链接</div>
    <div class="dm-row">
      <input v-model="word" class="dm-input" placeholder="搜索番剧名" @keyup.enter="runSearch" />
      <button class="pl-chip" :disabled="searchBusy || picking" @click="runSearch">{{ searchBusy ? '搜索中…' : '搜索' }}</button>
    </div>
    <button v-for="a in results" :key="a.id" class="pl-row" :disabled="picking" @click="pick(a)">
      <span class="mark"></span>
      <span class="label">
        {{ a.title }}
        <span v-if="a.year" class="sub">{{ epLabel(a) }}</span>
      </span>
      <span class="meta">{{ a.episodes ? `${a.episodes} 集` : '' }}</span>
    </button>
    <p v-if="searched && !results.length" class="pl-empty">没有找到，换个名字试试</p>
    <div v-if="player.dmLink" class="dm-linked">
      <span class="label">已链接 {{ player.dmLink.animeTitle }}</span>
      <button class="pl-chip" @click="unlink">解除</button>
    </div>
    <p v-if="linkNote" class="pl-note">{{ linkNote }}</p>

    <div class="pl-sect">匹配到的弹幕</div>
    <p v-if="player.dmLoading" class="pl-empty">载入中…</p>
    <button v-for="t in player.dmCandidates" :key="t.id" class="pl-row" :class="{ on: player.dmTrackId === t.id }" @click="player.selectDanmaku(t.id, t.shift || 0)">
      <span class="mark"></span>
      <span class="label">
        {{ t.title }}
        <span v-if="t.episode" class="sub">{{ t.episode }}</span>
      </span>
      <span class="meta">{{ t.linked ? '手动链接' : t.exact ? '自动匹配' : '自动链接' }}</span>
    </button>
    <p v-if="!player.dmLoading && !player.dmCandidates.length" class="pl-empty">{{ player.dmRefusal || '这一条没有匹配到弹幕' }}</p>
    <p v-if="player.dmCandidates.length" class="pl-note">自动链接是按 TMDB 编号或标题猜的；猜错了就在上面搜到正确的作品手动链接，之后每一集都按它取。</p>
    <p v-if="player.dmSource" class="pl-note">这一条来自「{{ player.dmSource }}」；设置里可以加别的接口，按顺序回退。</p>
  </SubPopover>

  <SubPopover name="style" title="弹幕样式">
    <StepRow label="字号大小" :text="`${cfg.fontSize}`" :can-down="cfg.fontSize > 10" :can-up="cfg.fontSize < 40" @down="set({ fontSize: clamp(cfg.fontSize - 1, 10, 40) })" @up="set({ fontSize: clamp(cfg.fontSize + 1, 10, 40) })" />
    <div class="pl-switch" role="switch" tabindex="0" :aria-checked="cfg.bold" :class="{ on: cfg.bold }" @click="set({ bold: !cfg.bold })">
      <span class="label">粗体</span>
      <span class="track"><i></i></span>
    </div>
    <StepRow label="不透明度" :text="cfg.opacity.toFixed(1)" :can-down="cfg.opacity > 0.2" :can-up="cfg.opacity < 1" @down="set({ opacity: clamp(Math.round((cfg.opacity - 0.1) * 10) / 10, 0.2, 1) })" @up="set({ opacity: clamp(Math.round((cfg.opacity + 0.1) * 10) / 10, 0.2, 1) })" />
    <div class="pl-line">
      <span class="label">预设</span>
      <div class="pl-chips dm-presets">
        <button class="pl-chip" @click="set({ fontSize: 18, bold: false, opacity: 1, strokeWidth: 1, strokeColor: '#000000', shadowOffset: 0, shadowBlur: 0, shadowColor: '#000000' })">默认</button>
        <button class="pl-chip" @click="set({ strokeWidth: 2, strokeColor: '#000000' })">描边</button>
        <button class="pl-chip" @click="set({ strokeWidth: 1, shadowOffset: 0, shadowBlur: 6, shadowColor: '#000000' })">柔光</button>
      </div>
    </div>
    <StepRow label="描边大小" :text="cfg.strokeWidth.toFixed(1)" :can-down="cfg.strokeWidth > 0" :can-up="cfg.strokeWidth < 6" @down="set({ strokeWidth: clamp(cfg.strokeWidth - 1, 0, 6) })" @up="set({ strokeWidth: clamp(cfg.strokeWidth + 1, 0, 6) })" />
    <div class="pl-line">
      <span class="label">描边颜色</span>
      <label class="dm-color" :style="{ '--swatch': cfg.strokeColor }">
        <input type="color" :value="cfg.strokeColor" @input="set({ strokeColor: (($event.target as HTMLInputElement).value) })" />
      </label>
    </div>
    <StepRow label="阴影位置" :text="cfg.shadowOffset.toFixed(1)" :can-down="cfg.shadowOffset > 0" :can-up="cfg.shadowOffset < 12" @down="set({ shadowOffset: clamp(cfg.shadowOffset - 1, 0, 12) })" @up="set({ shadowOffset: clamp(cfg.shadowOffset + 1, 0, 12) })" />
    <StepRow label="阴影大小" :text="cfg.shadowBlur.toFixed(1)" :can-down="cfg.shadowBlur > 0" :can-up="cfg.shadowBlur < 20" @down="set({ shadowBlur: clamp(cfg.shadowBlur - 1, 0, 20) })" @up="set({ shadowBlur: clamp(cfg.shadowBlur + 1, 0, 20) })" />
    <div class="pl-line">
      <span class="label">阴影颜色</span>
      <label class="dm-color" :style="{ '--swatch': cfg.shadowColor }">
        <input type="color" :value="cfg.shadowColor" @input="set({ shadowColor: (($event.target as HTMLInputElement).value) })" />
      </label>
    </div>
  </SubPopover>

  <SubPopover name="tune" title="微调">
    <div class="pl-switch" role="switch" tabindex="0" :aria-checked="cfg.scrollPinned" :class="{ on: cfg.scrollPinned }" @click="set({ scrollPinned: !cfg.scrollPinned })">
      <span class="label">固定弹幕转为滚动弹幕</span>
      <span class="track"><i></i></span>
    </div>
    <StepRow label="延迟显示" :text="`${(cfg.delayMs / 1000).toFixed(1)}s`" :can-down="cfg.delayMs > -30000" :can-up="cfg.delayMs < 30000" @down="set({ delayMs: clamp(cfg.delayMs - 500, -30000, 30000) })" @up="set({ delayMs: clamp(cfg.delayMs + 500, -30000, 30000) })" />
    <StepRow label="弹幕行数" :text="cfg.lanes ? `${cfg.lanes}` : '自动'" :can-down="cfg.lanes > 0" :can-up="cfg.lanes < 40" @down="set({ lanes: clamp(cfg.lanes - 1, 0, 40) })" @up="set({ lanes: clamp(cfg.lanes + 1, 0, 40) })" />
    <StepRow label="行间距" :text="`${cfg.laneGap}`" :can-down="cfg.laneGap > 0" :can-up="cfg.laneGap < 40" @down="set({ laneGap: clamp(cfg.laneGap - 1, 0, 40) })" @up="set({ laneGap: clamp(cfg.laneGap + 1, 0, 40) })" />
    <StepRow label="基础速度" :text="`${cfg.speed.toFixed(1)}x`" :can-down="cfg.speed > 0.5" :can-up="cfg.speed < 3" @down="set({ speed: clamp(Math.round((cfg.speed - 0.1) * 10) / 10, 0.5, 3) })" @up="set({ speed: clamp(Math.round((cfg.speed + 0.1) * 10) / 10, 0.5, 3) })" />
    <div class="pl-line">
      <span class="label">字体</span>
      <div class="pl-chips dm-presets">
        <button class="pl-chip" :class="{ on: !cfg.fontFamily }" @click="set({ fontFamily: '' })">默认</button>
        <button v-for="f in ['微软雅黑', '宋体', '楷体']" :key="f" class="pl-chip" :class="{ on: cfg.fontFamily === f }" @click="set({ fontFamily: f })">{{ f }}</button>
      </div>
    </div>
    <StepRow label="显示区域" :text="pct(cfg.displayArea)" :can-down="cfg.displayArea > 0.2" :can-up="cfg.displayArea < 1" @down="set({ displayArea: clamp(Math.round((cfg.displayArea - 0.1) * 100) / 100, 0.2, 1) })" @up="set({ displayArea: clamp(Math.round((cfg.displayArea + 0.1) * 100) / 100, 0.2, 1) })" />
    <StepRow label="同屏上限" :text="`${cfg.maxOnScreen}`" :can-down="cfg.maxOnScreen > 10" :can-up="cfg.maxOnScreen < 300" @down="set({ maxOnScreen: clamp(cfg.maxOnScreen - 10, 10, 300) })" @up="set({ maxOnScreen: clamp(cfg.maxOnScreen + 10, 10, 300) })" />
    <p class="pl-note">同屏上限是一堵墙：密度超过它时新到的弹幕被丢掉，而不是把帧率拖下去。延迟显示为正表示弹幕更晚出现。</p>
    <div class="pl-chips">
      <button class="pl-chip" @click="set({ scrollPinned: false, delayMs: 0, lanes: 0, laneGap: 5, speed: 1, displayArea: 1, maxOnScreen: 80, fontFamily: '' })">重置</button>
    </div>
  </SubPopover>

  <SubPopover name="words" title="弹幕过滤">
    <div class="dm-row">
      <input v-model="newWord" class="dm-input" placeholder="输入要过滤的关键词" @keyup.enter="addWord" />
      <button class="pl-chip" @click="addWord">添加</button>
    </div>
    <div v-if="words.length" class="dm-words">
      <button v-for="w in words" :key="w" class="dm-word" :title="`不再显示包含「${w}」的弹幕`" @click="setWords(words.filter(x => x !== w))">
        <span>{{ w }}</span>
        <span class="x">×</span>
      </button>
    </div>
    <p v-else class="pl-note">暂无屏蔽关键词</p>
    <p class="pl-note">关键词立刻生效，正在播的这一条也会当场清一遍；弹幕本身不会再下载。</p>
    <div v-if="words.length" class="pl-chips">
      <button class="pl-chip" @click="setWords([])">清空</button>
    </div>
  </SubPopover>
</template>

<style scoped>
.dm-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 6px 6px;
}
.dm-input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border-radius: 9px;
  border: 1px solid var(--pl-line);
  background: rgba(255, 255, 255, 0.07);
  color: var(--pl-text);
  font: inherit;
  font-size: 14px;
}
.dm-input::placeholder {
  color: var(--pl-faint);
}
.dm-input:focus-visible {
  outline: 2px solid var(--pl-accent, #7fb2ff);
  outline-offset: 1px;
}
.dm-linked {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 2px 6px 6px;
  padding: 6px 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 14px;
  color: var(--pl-text);
}
.dm-linked .label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The swatch is a colour input drawn as the circle the reference uses; the native control is what opens the
   picker, so it stays in the DOM and only loses its own chrome. */
.dm-color {
  position: relative;
  width: 26px;
  height: 26px;
  flex: none;
  border-radius: 50%;
  background: conic-gradient(#ff5f5f, #ffd15f, #6dff8a, #5fd8ff, #7a6dff, #ff5fd0, #ff5f5f);
  box-shadow: inset 0 0 0 12px var(--swatch);
  border: 1px solid var(--pl-line);
  overflow: hidden;
  cursor: pointer;
}
.dm-color input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.dm-presets {
  max-width: none;
  padding: 0;
  justify-content: flex-end;
}
.dm-words {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 6px 6px;
}
.dm-word {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
  color: var(--pl-dim);
  font-size: 13px;
}
.dm-word:hover {
  background: rgba(255, 255, 255, 0.18);
  color: var(--pl-text);
}
.dm-word .x {
  color: var(--pl-faint);
}
</style>