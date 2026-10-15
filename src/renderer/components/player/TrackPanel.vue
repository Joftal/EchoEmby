<script setup lang="ts">
import { computed } from 'vue';
import PanelShell from './PanelShell.vue';
import { usePlayerStore } from '../../stores/player';
import type { PlayerTrack, TrackSelection } from '../../../shared/types';

const props = defineProps<{ kind: 'subtitle' | 'audio' | 'video' }>();
const player = usePlayerStore();
const media = computed(() => player.media);

const title = computed(() => (props.kind === 'subtitle' ? '字幕' : props.kind === 'audio' ? '音轨' : '画面'));

const tracks = computed(() => media.value.tracks.filter(t => t.kind === props.kind));
const current = computed<TrackSelection>(() => (props.kind === 'subtitle' ? media.value.subtitle : props.kind === 'audio' ? media.value.audio : media.value.video));

/** mpv numbers each kind from 1, so the row the user picks has to say which one it is. */
const rowLabel = (t: PlayerTrack): string => {
  const named = (t.title || '').trim();
  const lang = langName(t.lang);
  const head = named && named !== String(t.ordinal) ? named : lang || `轨道 ${t.ordinal}`;
  return `${t.ordinal}. ${head}${t.forced ? '（强制）' : ''}`;
};

const LANGS: Record<string, string> = {
  zho: '中文', chi: '中文', chs: '中文（简）', zht: '中文（繁）', zh: '中文', yue: '粤语', eng: '英文', en: '英文', jpn: '日文', kor: '韩文', fre: '法文', fra: '法文', ger: '德文', deu: '德文', spa: '西文', ita: '意文', rus: '俄文', por: '葡文', tha: '泰文', vie: '越南文', und: '无语言',
};

const langName = (code?: string): string => {
  if (!code) return '';
  const key = code.toLowerCase();
  if (key.startsWith('zh-hant') || key === 'cht') return '中文（繁）';
  if (key.startsWith('zh-hans') || key === 'chs') return '中文（简）';
  return LANGS[key] || code;
};

const meta = (t: PlayerTrack): string => [t.selected ? '正在用' : '', t.codec ? t.codec.toUpperCase() : ''].filter(Boolean).join(' · ');

async function pick(id: TrackSelection): Promise<void> {
  await player.cmd({ action: 'track', value: { kind: props.kind, id } });
}

const ASPECTS: { label: string; value: TrackSelection }[] = [
  { label: '默认', value: 'no' },
  { label: '16:9', value: 16 / 9 },
  { label: '4:3', value: 4 / 3 },
  { label: '21:9', value: 21 / 9 },
  { label: '2.35:1', value: 2.35 },
];

const isAspect = (v: TrackSelection): boolean =>
  v === 'no' ? media.value.aspect === 'no' : typeof v === 'number' && typeof media.value.aspect === 'number' && Math.abs(media.value.aspect - v) < 0.02;

function setAspect(v: TrackSelection): void {
  void player.cmd({ action: 'aspect', value: v });
}

/** The two delay sliders hold seconds; the kernel wants milliseconds. */
const subDelaySec = computed(() => media.value.subtitleDelayMs / 1000);
const audioDelaySec = computed(() => media.value.audioDelayMs / 1000);
</script>

<template>
  <PanelShell :kind="kind" :title="title">
    <template v-if="kind === 'subtitle'">
      <div class="pl-sect">字幕轨道</div>
      <button class="pl-row" :class="{ on: current === 'no' }" @click="pick('no')">
        <span class="label">关闭</span>
      </button>
      <button class="pl-row" @click="pick('auto')">
        <span class="label">自动选择</span>
        <span class="meta">按语言偏好挑一条</span>
      </button>
      <button v-for="t in tracks" :key="t.id" class="pl-row" :class="{ on: current === t.id }" @click="pick(t.id)">
        <span class="label">{{ rowLabel(t) }}</span>
        <span class="meta">{{ meta(t) }}</span>
      </button>
      <p v-if="!tracks.length" class="pl-empty">这个文件里没有内嵌字幕</p>

      <div class="pl-sect">时间</div>
      <div class="pl-slide">
        <span>延迟</span>
        <input type="range" min="-30" max="30" step="0.1" :value="subDelaySec" @change="e => player.cmd({ action: 'subtitleDelay', value: Math.round(Number((e.target as HTMLInputElement).value) * 1000) })" />
        <span class="val">{{ subDelaySec.toFixed(1) }}s</span>
      </div>
      <div class="pl-chips">
        <button class="pl-chip" @click="player.cmd({ action: 'subtitleDelay', value: media.subtitleDelayMs - 500 })">−0.5s</button>
        <button class="pl-chip" @click="player.cmd({ action: 'subtitleDelay', value: media.subtitleDelayMs + 500 })">+0.5s</button>
        <button class="pl-chip" @click="player.cmd({ action: 'subtitleDelay', value: 0 })">复位</button>
      </div>

      <div class="pl-sect">样式</div>
      <div class="pl-slide">
        <span>字号</span>
        <input type="range" min="50" max="200" step="5" :value="media.subtitleScale" @change="e => player.cmd({ action: 'subtitleStyle', value: { scale: Number((e.target as HTMLInputElement).value) } })" />
        <span class="val">{{ media.subtitleScale }}%</span>
      </div>
      <div class="pl-slide">
        <span>高度</span>
        <input type="range" min="0" max="100" step="1" :value="media.subtitlePos" @change="e => player.cmd({ action: 'subtitleStyle', value: { pos: Number((e.target as HTMLInputElement).value) } })" />
        <span class="val">{{ media.subtitlePos }}%</span>
      </div>
    </template>

    <template v-else-if="kind === 'audio'">
      <div class="pl-sect">音频轨道</div>
      <button v-for="t in tracks" :key="t.id" class="pl-row" :class="{ on: current === t.id }" @click="pick(t.id)">
        <span class="label">{{ rowLabel(t) }}</span>
        <span class="meta">{{ meta(t) }}</span>
      </button>
      <p v-if="!tracks.length" class="pl-empty">这个文件里没有可切换的音轨</p>

      <div class="pl-sect">时间</div>
      <div class="pl-slide">
        <span>延迟</span>
        <input type="range" min="-30" max="30" step="0.1" :value="audioDelaySec" @change="e => player.cmd({ action: 'audioDelay', value: Math.round(Number((e.target as HTMLInputElement).value) * 1000) })" />
        <span class="val">{{ audioDelaySec.toFixed(1) }}s</span>
      </div>
      <div class="pl-chips">
        <button class="pl-chip" @click="player.cmd({ action: 'audioDelay', value: media.audioDelayMs - 500 })">−0.5s</button>
        <button class="pl-chip" @click="player.cmd({ action: 'audioDelay', value: media.audioDelayMs + 500 })">+0.5s</button>
        <button class="pl-chip" @click="player.cmd({ action: 'audioDelay', value: 0 })">复位</button>
      </div>
    </template>

    <template v-else>
      <div class="pl-sect">视频轨道</div>
      <button v-for="t in tracks" :key="t.id" class="pl-row" :class="{ on: current === t.id }" @click="pick(t.id)">
        <span class="label">{{ rowLabel(t) }}</span>
        <span class="meta">{{ meta(t) }}</span>
      </button>
      <p v-if="!tracks.length" class="pl-empty">这个文件里只有一条视频轨</p>

      <div class="pl-sect">画面比例</div>
      <div class="pl-chips">
        <button v-for="a in ASPECTS" :key="a.label" class="pl-chip" :class="{ on: isAspect(a.value) }" @click="setAspect(a.value)">{{ a.label }}</button>
      </div>

      <div class="pl-sect">填满窗口</div>
      <div class="pl-slide">
        <span>裁切</span>
        <input type="range" min="0" max="1" step="0.02" :value="media.panscan" @change="e => player.cmd({ action: 'panscan', value: Number((e.target as HTMLInputElement).value) })" />
        <span class="val">{{ Math.round(media.panscan * 100) }}%</span>
      </div>
      <p class="pl-note">裁切把画面放大到没有黑边，代价是超出比例的部分被切掉。</p>
    </template>
  </PanelShell>
</template>
