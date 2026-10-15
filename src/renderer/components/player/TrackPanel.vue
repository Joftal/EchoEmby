<script setup lang="ts">
import { computed } from 'vue';
import SubPopover from './SubPopover.vue';
import SubRow from './SubRow.vue';
import StepRow from './StepRow.vue';
import { usePlayerStore } from '../../stores/player';
import type { PlayerTrack, TrackSelection } from '../../../shared/types';

/** Body only: the card that holds this belongs to SheetLayer, and so does its title. */
const props = defineProps<{ kind: 'subtitle' | 'audio' | 'video' }>();
const player = usePlayerStore();
const media = computed(() => player.media);

const tracks = computed(() => media.value.tracks.filter(t => t.kind === props.kind));
const embedded = computed(() => tracks.value.filter(t => !t.external));
const external = computed(() => tracks.value.filter(t => t.external));
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
  { label: '不裁剪', value: 'no' },
  { label: '16:9 (1.78:1)', value: 16 / 9 },
  { label: '4:3 (1.33:1)', value: 4 / 3 },
  { label: '2.35:1', value: 2.35 },
  { label: '2.39:1', value: 2.39 },
  { label: '2.40:1', value: 2.4 },
  { label: '1.85:1', value: 1.85 },
  { label: '2.00:1', value: 2 },
  { label: '2.20:1', value: 2.2 },
  { label: '2.76:1', value: 2.76 },
];

const isAspect = (v: TrackSelection): boolean =>
  v === 'no' ? media.value.aspect === 'no' : typeof v === 'number' && typeof media.value.aspect === 'number' && Math.abs(media.value.aspect - v) < 0.02;

function setAspect(v: TrackSelection): void {
  void player.cmd({ action: 'aspect', value: v });
}

/** mpv's panscan is a 0→1 blend between fitting the frame and filling it, so the two named modes are its
 *  two ends rather than a third setting. */
const FILLS = [
  { label: '适应屏幕', value: 0 },
  { label: '填满屏幕', value: 1 },
];

const delayMs = computed(() => (props.kind === 'audio' ? media.value.audioDelayMs : media.value.subtitleDelayMs));
function nudgeDelay(dir: number): void {
  const v = delayMs.value + dir * 100;
  void player.cmd({ action: props.kind === 'audio' ? 'audioDelay' : 'subtitleDelay', value: Math.round(v * 10) / 10 });
}
</script>

<template>
  <template v-if="kind === 'subtitle'">
    <button class="pl-row" :class="{ on: current === 'no' }" @click="pick('no')">
      <span class="mark"></span>
      <span class="label">关闭</span>
    </button>
    <button class="pl-row" :class="{ on: current === 'auto' }" @click="pick('auto')">
      <span class="mark"></span>
      <span class="label">自动选择</span>
      <span class="meta">按语言偏好挑一条</span>
    </button>

    <div v-if="embedded.length" class="pl-sect">内封字幕</div>
    <button v-for="t in embedded" :key="t.id" class="pl-row" :class="{ on: current === t.id }" @click="pick(t.id)">
      <span class="mark"></span>
      <span class="label">
        {{ rowLabel(t) }}
        <span v-if="langName(t.lang)" class="sub">{{ langName(t.lang) }}</span>
      </span>
      <span class="meta">{{ meta(t) }}</span>
    </button>
    <p v-if="!embedded.length && !external.length" class="pl-empty">这个文件里没有字幕</p>

    <div v-if="external.length" class="pl-sect">外挂字幕</div>
    <button v-for="t in external" :key="t.id" class="pl-row" :class="{ on: current === t.id }" @click="pick(t.id)">
      <span class="mark"></span>
      <span class="label">{{ rowLabel(t) }}</span>
      <span class="meta">{{ meta(t) }}</span>
    </button>

    <div class="pl-sep"></div>
    <SubRow name="style" label="显示设置" :value="`${media.subtitleScale}% · ${delayMs > 0 ? '+' : ''}${(delayMs / 1000).toFixed(1)}s`" />
  </template>

  <template v-else-if="kind === 'audio'">
    <button v-for="t in tracks" :key="t.id" class="pl-row" :class="{ on: current === t.id }" @click="pick(t.id)">
      <span class="mark"></span>
      <span class="label">{{ rowLabel(t) }}</span>
      <span class="meta">{{ meta(t) }}</span>
    </button>
    <p v-if="!tracks.length" class="pl-empty">这个文件里没有可切换的音轨</p>
    <div v-if="tracks.length" class="pl-sep"></div>
    <SubRow name="delay" label="声音延迟" :value="`${(delayMs / 1000).toFixed(1)}s`" />
  </template>

  <template v-else>
    <SubRow name="fill" label="填充模式" :value="media.panscan >= 0.99 ? '填满屏幕' : media.panscan <= 0.01 ? '适应屏幕' : `${Math.round(media.panscan * 100)}%`" />
    <SubRow name="aspect" label="画面比例" :value="ASPECTS.find(a => isAspect(a.value))?.label || ''" />
    <template v-if="tracks.length > 1">
      <div class="pl-sect">视频轨道</div>
      <button v-for="t in tracks" :key="t.id" class="pl-row" :class="{ on: current === t.id }" @click="pick(t.id)">
        <span class="mark"></span>
        <span class="label">{{ rowLabel(t) }}</span>
        <span class="meta">{{ meta(t) }}</span>
      </button>
    </template>
  </template>

  <SubPopover v-if="kind === 'subtitle'" name="style" title="字幕显示设置">
    <StepRow label="延迟" :text="`${(delayMs / 1000).toFixed(1)}s`" @down="nudgeDelay(-1)" @up="nudgeDelay(1)" />
    <div class="pl-chips">
      <button class="pl-chip" @click="player.cmd({ action: 'subtitleDelay', value: 0 })">复位</button>
    </div>
    <StepRow label="字号" :text="`${media.subtitleScale}%`" @down="player.cmd({ action: 'subtitleStyle', value: { scale: Math.max(50, media.subtitleScale - 5) } })" @up="player.cmd({ action: 'subtitleStyle', value: { scale: Math.min(200, media.subtitleScale + 5) } })" />
    <StepRow label="高度" :text="`${media.subtitlePos}%`" @down="player.cmd({ action: 'subtitleStyle', value: { pos: Math.max(0, media.subtitlePos - 2) } })" @up="player.cmd({ action: 'subtitleStyle', value: { pos: Math.min(100, media.subtitlePos + 2) } })" />
  </SubPopover>

  <SubPopover v-else-if="kind === 'audio'" name="delay" title="声音延迟">
    <StepRow label="延迟" :text="`${(delayMs / 1000).toFixed(1)}s`" @down="nudgeDelay(-1)" @up="nudgeDelay(1)" />
    <div class="pl-chips">
      <button class="pl-chip" @click="player.cmd({ action: 'audioDelay', value: 0 })">复位</button>
    </div>
  </SubPopover>

  <template v-else>
    <SubPopover name="fill" title="填充模式">
      <button v-for="f in FILLS" :key="f.label" class="pl-row" :class="{ on: Math.abs(media.panscan - f.value) < 0.01 }" @click="player.cmd({ action: 'panscan', value: f.value })">
        <span class="mark"></span>
        <span class="label">{{ f.label }}</span>
      </button>
      <p class="pl-note">填满把画面放大到没有黑边，代价是超出比例的部分被切掉。</p>
    </SubPopover>

    <SubPopover name="aspect" title="画面比例">
      <button v-for="a in ASPECTS" :key="a.label" class="pl-row" :class="{ on: isAspect(a.value) }" @click="setAspect(a.value)">
        <span class="mark"></span>
        <span class="label">{{ a.label }}</span>
      </button>
    </SubPopover>
  </template>
</template>
