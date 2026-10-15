<script setup lang="ts">
import { computed } from 'vue';
import PanelShell from './PanelShell.vue';
import { usePlayerStore } from '../../stores/player';

const player = usePlayerStore();
const cfg = computed(() => player.prefs);
const sourceLabel = computed(() => (cfg.value.source?.type === 'dandan' ? cfg.value.source.url || '弹弹 play' : 'Bilibili'));

/** The knobs write straight through to the setting: the canvas reads the store every frame, so a slider
 *  that moved has already changed what the next frame draws by the time the file write lands. */
function set(patch: Record<string, unknown>): void {
  void player.patchDanmaku(patch);
}
</script>

<template>
  <PanelShell kind="danmaku" title="弹幕">
    <div class="pl-switch" :class="{ on: player.danmakuOn }" @click="player.setDanmakuEnabled(!player.danmakuOn)">
      <span class="track"><i></i></span>
      <span class="label">显示弹幕</span>
    </div>
    <p class="pl-note">关掉之后不会再向弹幕源发任何请求。当前来源：{{ sourceLabel }}。</p>

    <template v-if="player.danmakuOn">
      <div class="pl-sect">弹幕轨道</div>
      <p v-if="player.dmLoading" class="pl-empty">载入中…</p>
      <button v-for="t in player.dmCandidates" :key="t.id" class="pl-row" :class="{ on: player.dmTrackId === t.id }" @click="player.selectDanmaku(t.id)">
        <span class="label">{{ t.title }}</span>
        <span class="meta">{{ t.count ? `${t.count} 条` : '' }}</span>
      </button>
      <p v-if="!player.dmLoading && !player.dmCandidates.length" class="pl-empty">这一条没有匹配到弹幕</p>

      <div class="pl-sect">显示</div>
      <div class="pl-slide">
        <span>区域</span>
        <input type="range" min="0.2" max="1" step="0.05" :value="cfg.displayArea" @change="e => set({ displayArea: Number((e.target as HTMLInputElement).value) })" />
        <span class="val">{{ Math.round(cfg.displayArea * 100) }}%</span>
      </div>
      <div class="pl-slide">
        <span>透明度</span>
        <input type="range" min="0.2" max="1" step="0.05" :value="cfg.opacity" @change="e => set({ opacity: Number((e.target as HTMLInputElement).value) })" />
        <span class="val">{{ Math.round(cfg.opacity * 100) }}%</span>
      </div>
      <div class="pl-slide">
        <span>字号</span>
        <input type="range" min="0.6" max="2" step="0.1" :value="cfg.fontScale" @change="e => set({ fontScale: Number((e.target as HTMLInputElement).value) })" />
        <span class="val">{{ Math.round(cfg.fontScale * 100) }}%</span>
      </div>
      <div class="pl-slide">
        <span>停留</span>
        <input type="range" min="3" max="30" step="1" :value="cfg.durationMs / 1000" @change="e => set({ durationMs: Math.round(Number((e.target as HTMLInputElement).value) * 1000) })" />
        <span class="val">{{ Math.round(cfg.durationMs / 1000) }}s</span>
      </div>
      <div class="pl-slide">
        <span>同屏上限</span>
        <input type="range" min="10" max="300" step="10" :value="cfg.maxOnScreen" @change="e => set({ maxOnScreen: Number((e.target as HTMLInputElement).value) })" />
        <span class="val">{{ cfg.maxOnScreen }}</span>
      </div>
      <p class="pl-note">同屏上限是一堵墙：密度超过它时新到的弹幕被丢掉，而不是把帧率拖下去。</p>

      <div class="pl-sect">屏蔽词</div>
      <textarea class="pl-words" rows="3" :value="cfg.blockedWords" placeholder="用逗号或换行分开" @change="e => set({ blockedWords: (e.target as HTMLTextAreaElement).value })"></textarea>
      <p class="pl-note">屏蔽在取回时生效，已有的缓存下一次读取才会干净。</p>
    </template>
  </PanelShell>
</template>

<style scoped>
.pl-words {
  width: 100%;
  box-sizing: border-box;
  margin: 2px 0 6px;
  padding: 9px 10px;
  border-radius: var(--radius);
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
