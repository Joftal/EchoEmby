<script setup lang="ts">
import { computed } from 'vue';
import PanelShell from './PanelShell.vue';
import SubPopover from './SubPopover.vue';
import SubRow from './SubRow.vue';
import StepRow from './StepRow.vue';
import { usePlayerStore } from '../../stores/player';

const player = usePlayerStore();
const cfg = computed(() => player.prefs);
const sourceLabel = computed(() => (cfg.value.source?.type === 'dandan' ? cfg.value.source.url || '弹弹 play' : 'Bilibili'));

/** The knobs write straight through to the setting: the canvas reads the store every frame, so a stepper
 *  that moved has already changed what the next frame draws by the time the file write lands. */
function set(patch: Record<string, unknown>): void {
  void player.patchDanmaku(patch);
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** The row says how much came in, not which track is chosen: the titles are whole series names and the
 *  list itself is one tap away. */
const trackValue = computed(() => {
  if (player.dmLoading) return '载入中…';
  const t = player.dmCandidates.find(c => c.id === player.dmTrackId);
  if (!t) return player.dmCandidates.length ? '' : '没匹配到';
  return t.count ? `${t.count} 条` : '';
});
</script>

<template>
  <PanelShell title="弹幕" :wide="320">
    <div class="pl-switch" :class="{ on: player.danmakuOn }" @click="player.setDanmakuEnabled(!player.danmakuOn)">
      <span class="label">显示弹幕</span>
      <span class="track"><i></i></span>
    </div>
    <p class="pl-note">关掉之后不会再向弹幕源发任何请求。当前来源：{{ sourceLabel }}。</p>

    <template v-if="player.danmakuOn">
      <div class="pl-sep"></div>
      <SubRow name="tracks" label="弹幕轨道" :value="trackValue" />
      <SubRow name="tune" label="显示设置" :value="`${pct(cfg.opacity)} · ${Math.round(cfg.fontScale * 100)}%`" />
      <SubRow name="words" label="过滤关键词" :value="cfg.blockedWords ? `${cfg.blockedWords.split(/[\n,，]/).filter(Boolean).length} 个` : ''" />
    </template>

    <template #sub>
      <SubPopover v-if="player.sub === 'tracks'" title="弹幕轨道" :wide="330">
        <div class="pl-sect">当前选择</div>
        <p v-if="player.dmLoading" class="pl-empty">载入中…</p>
        <button v-for="t in player.dmCandidates" :key="t.id" class="pl-row" :class="{ on: player.dmTrackId === t.id }" @click="player.selectDanmaku(t.id)">
          <span class="mark"></span>
          <span class="label">{{ t.title }}</span>
          <span class="meta">{{ t.count ? `${t.count} 条` : '' }}</span>
        </button>
        <p v-if="!player.dmLoading && !player.dmCandidates.length" class="pl-empty">这一条没有匹配到弹幕</p>
      </SubPopover>

      <SubPopover v-else-if="player.sub === 'tune'" title="微调" :wide="300">
        <StepRow label="显示区域" :text="pct(cfg.displayArea)" @down="set({ displayArea: clamp(cfg.displayArea - 0.05, 0.2, 1) })" @up="set({ displayArea: clamp(cfg.displayArea + 0.05, 0.2, 1) })" />
        <StepRow label="不透明度" :text="pct(cfg.opacity)" @down="set({ opacity: clamp(cfg.opacity - 0.05, 0.2, 1) })" @up="set({ opacity: clamp(cfg.opacity + 0.05, 0.2, 1) })" />
        <StepRow label="字号" :text="pct(cfg.fontScale)" @down="set({ fontScale: clamp(cfg.fontScale - 0.1, 0.6, 2) })" @up="set({ fontScale: clamp(cfg.fontScale + 0.1, 0.6, 2) })" />
        <StepRow label="速度" :text="`${(cfg.durationMs / 1000).toFixed(0)}s 过屏`" @down="set({ durationMs: clamp(cfg.durationMs - 1000, 3000, 30000) })" @up="set({ durationMs: clamp(cfg.durationMs + 1000, 3000, 30000) })" />
        <StepRow label="同屏上限" :text="`${cfg.maxOnScreen}`" @down="set({ maxOnScreen: clamp(cfg.maxOnScreen - 10, 10, 300) })" @up="set({ maxOnScreen: clamp(cfg.maxOnScreen + 10, 10, 300) })" />
        <p class="pl-note">同屏上限是一堵墙：密度超过它时新到的弹幕被丢掉，而不是把帧率拖下去。</p>
        <div class="pl-chips">
          <button class="pl-chip" @click="set({ displayArea: 0.5, opacity: 1, fontScale: 1, durationMs: 8000, maxOnScreen: 120 })">重置</button>
        </div>
      </SubPopover>

      <SubPopover v-else-if="player.sub === 'words'" title="过滤关键词" :wide="300">
        <textarea class="pl-words" rows="5" :value="cfg.blockedWords" placeholder="用逗号或换行分开" @change="e => set({ blockedWords: (e.target as HTMLTextAreaElement).value })"></textarea>
        <p class="pl-note">屏蔽在取回时生效，已有的缓存下一次读取才会干净。</p>
        <div class="pl-chips">
          <button class="pl-chip" @click="set({ blockedWords: '' })">清空</button>
        </div>
      </SubPopover>
    </template>
  </PanelShell>
</template>

<style scoped>
.pl-words {
  width: 100%;
  box-sizing: border-box;
  margin: 6px 0;
  padding: 9px 10px;
  border-radius: 10px;
  border: 1px solid var(--pl-line);
  background: rgba(255, 255, 255, 0.06);
  color: var(--pl-text);
  font: inherit;
  font-size: 13px;
  resize: vertical;
}
.pl-words::placeholder {
  color: var(--pl-faint);
}
</style>
