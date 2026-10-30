<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
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
})

/** 「5931 条」 reads as a number; 「208000 条」 does not, so the ten-thousands get their own unit. */
const countText = (n: number): string => (n >= 10_000 ? `${(n / 10_000).toFixed(1).replace(/\.0$/, '')} 万条` : `${n} 条`);

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

/** The row that opens the search page says whether this episode already has a link, so the drill-in can be
 *  skipped by anyone who does not need it — and cannot be mistaken for an unlinked one. */
const manualValue = computed(() => (player.dmLink ? cleanTitle(player.dmLink.animeTitle) : '未链接'));

/** The word, the rows, the numbers and the pick all live in the store: they are the viewer's own comparison and
 *  must outlive the drawer closing or a link being made, while still belonging to this sitting only. */
async function runSearch(): Promise<void> {
  await player.runDmSearch();
  // The body keeps the scroll it had, so an answer used to open in the middle of the old list. Land its first
  // row where the eye already is.
  await nextTick();
  mhead.value?.closest('.pl-body')?.scrollTo({ top: 0 });
}

/** Picking a work links the *episode that is playing* to the row at the same position inside that work: the
 *  service lists a show's episodes in order, so the number the library gives is the index to take. A film has
 *  one row and takes it. */


/** A mirror dresses a title for its own index — 「葬送的芙莉莲(2023)【TV动画】from dandan」 — while the year, the
 *  kind and the mirror itself are printed on the line under it. Showing the dressed string cost the name its
 *  room: every row of 银魂 ended in 「from dandan」 and the words that tell two seasons apart were the ones cut
 *  off. This is display only — 手动链接 hands main the exact string it matched on. */
const MIRROR = /\s*from\s+(\S+)\s*$/i;
const mirrorOf = (title: string): string => (MIRROR.exec(String(title || '')) || [])[1] || '';
function cleanTitle(title: string): string {
  let out = String(title || '').replace(MIRROR, '').trim();
  // Peeled in rounds the way main's plainTitle is, because the dressing nests: 【TV动画】 sits inside the year.
  for (let round = 0; round < 3; round += 1) {
    const before = out;
    out = out.replace(/\s*【[^】]*】\s*$/, '').replace(/\s*[（(]\s*(?:19|20)\d{2}\s*[)）]\s*$/, '').trim();
    if (out === before) break;
  }
  return out;
}

/** The line under a result's name: year, kind, and which mirror answered. */
const subOf = (a: DanmakuAnime): string =>
  [a.year ? String(a.year) : '', a.type || '', mirrorOf(a.title)].filter(Boolean).join(' · ');

const mhead = ref<HTMLElement | null>(null);
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

  <SubPopover name="tracks" title="弹幕轨道" wide>
    <!-- Above the list, not under it: the sheet is capped by the player's height and the entry sat below the
         fold on 720p, so the one way out of a wrong auto link was the one thing you had to scroll for. -->
    <SubRow name="manual" label="手动搜索" :value="manualValue" />
    <p class="pl-note">按作品名搜镜像、一集一集地挑；条数在那一页里看，不会挤动下面这份列表。</p>
    <div class="pl-sep"></div>
    <div class="pl-sect dm-candhead">
      <span>匹配到的弹幕</span>
      <button class="pl-chip dm-again" :disabled="player.dmLoading" @click="player.loadDanmaku(true)">重新匹配</button>
    </div>
    <p v-if="player.dmLoading" class="pl-empty">载入中…</p>
    <button v-for="t in player.dmCandidates" :key="t.id" class="pl-row" :class="{ on: player.dmTrackId === t.id }" @click="player.selectDanmaku(t.id, t.shift || 0)">
      <span class="mark"></span>
      <span class="label">
        {{ cleanTitle(t.title) }}
        <span v-if="t.year || t.episode" class="sub">{{ t.year ?? '' }}{{ t.year && t.episode ? ' · ' : '' }}{{ t.episode || '' }}</span>
      </span>
      <span v-if="t.count != null" class="dm-ct">{{ countText(t.count) }}</span>
      <span class="meta">{{ t.linked ? '手动链接' : t.exact ? '自动匹配' : '自动链接' }}</span>
    </button>
    <p v-if="!player.dmLoading && !player.dmCandidates.length" class="pl-empty">{{ player.dmRefusal || '这一条没有匹配到弹幕' }}</p>
    <p v-if="!player.dmLoading && !player.dmCandidates.length && !player.dmRefusal" class="pl-note">可以在下面的「手动搜索」里搜作品名链接，选对了之后每一集都按它取。</p>
    <p v-if="player.dmCandidates.length" class="pl-note">自动链接是按 TMDB 编号或标题猜的；猜错了就去「手动搜索」里找到正确的作品，之后每一集都按它取。</p>
    <p v-if="player.dmSource" class="pl-note">这一条来自「{{ player.dmSource }}」；设置里可以加别的接口，按顺序回退。</p>
  </SubPopover>

  <SubPopover name="manual" title="手动搜索" wide back="tracks">
    <div ref="mhead" class="pl-sect">在镜像里搜作品</div>
    <div class="dm-row">
      <input v-model="player.dmWord" class="dm-input" placeholder="搜索番剧名" @keyup.enter="runSearch" />
      <button class="pl-chip" :disabled="player.dmSearchBusy || player.dmPicking" @click="runSearch">{{ player.dmSearchBusy ? '搜索中…' : '搜索' }}</button>
    </div>
    <!-- Above the results, not under them: 66 rows of a common name buried the one sentence that said the pick
         did not take, and buried 已链接 and 解除 with it. -->
    <p v-if="player.dmNote" class="pl-note">{{ player.dmNote }}</p>
    <div v-if="player.dmLink" class="dm-linked">
      <span class="label">已链接 {{ cleanTitle(player.dmLink.animeTitle) }}</span>
      <button class="pl-chip" @click="player.unlinkDm">解除</button>
    </div>
    <div v-if="player.dmSearched" class="dm-resbar">
      <span class="label">{{ player.dmResults.length ? `找到 ${player.dmResults.length} 部` : '没有找到，换个名字试试' }}</span>
      <button class="pl-chip" @click="player.dropDmSearch()">取消搜索</button>
    </div>
    <!-- Its own scroller: the search box and 已链接 stay put while a 42-row answer scrolls, instead of the whole
         page sliding away from the field that made it. -->
    <div v-if="player.dmResults.length" class="dm-list">
      <button v-for="a in player.dmResults" :key="a.id" class="pl-row" :disabled="player.dmPicking" @click="player.pickDmAnime(a)">
        <span class="mark"></span>
        <span class="label">
          {{ cleanTitle(a.title) }}
          <span v-if="subOf(a)" class="sub">{{ subOf(a) }}</span>
        </span>
        <span v-if="player.dmCounts[a.id] != null" class="dm-ct">{{ countText(player.dmCounts[a.id] || 0) }}</span>
        <span class="meta">{{ a.episodes ? `${a.episodes} 集` : '' }}</span>
      </button>
    </div>
    <p v-if="player.dmResults.length" class="pl-note">条数是这一集在这一部作品里的数量，每一部都数，先到的先显示，接口没回数的先空着。挑数字大的那条，它才是最全的；换了集只重算数字，名单留着。</p>
    <p v-else class="pl-note">选中一部作品就把它和正在播的这一集绑起来：条数取自同一集，换集不用重选。</p>
  </SubPopover>

  <SubPopover name="style" title="弹幕样式" wide>
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

  <SubPopover name="tune" title="微调" wide>
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

  <SubPopover name="words" title="弹幕过滤" wide>
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
/* How many works the search found, and the way back to the candidates. The number is the point: nine rows fit
   the card, 银魂 answers with 66, and without a count the list looked like it ended there. */
.dm-resbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 6px 2px;
  font-size: 13px;
  color: var(--pl-faint);
}
.dm-resbar .label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The answer scrolls inside this box rather than the whole sheet: a 42-row search would otherwise push the
   field that made it off the top, and the numbers are read while typing the next name. */
.dm-list {
  max-height: 40vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
}
.dm-list::-webkit-scrollbar {
  width: 0;
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
/* Sits in the section header rather than under the list: a wrong auto link is what brings the viewer here, and
   the list it would have sat under is long enough to push the one control that fixes it below the fold. */
.dm-candhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dm-again {
  margin: 0 6px 0 0;
}
/* The count sits where a thumb would be on a list row: before the word that says how the row was found, in the
   same muted tone, so the numbers line up in a column of their own instead of shoving the labels about. */
.dm-ct {
  flex: none;
  margin-left: auto;
  color: var(--pl-dim);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
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