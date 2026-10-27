<script setup lang="ts">
import { computed } from 'vue';
import SubPopover from './SubPopover.vue';
import SubRow from './SubRow.vue';
import StepRow from './StepRow.vue';
import { usePlayerStore } from '../../stores/player';
import { langName, openBrackets, zhTrackWords } from '../../lib/format';
import type { MediaStreamInfo, PlayerTrack, TrackSelection } from '../../../shared/types';

/** Body only: the card that holds this belongs to SheetLayer, and so does its title. */
const props = defineProps<{ kind: 'subtitle' | 'audio' | 'video' }>();
const player = usePlayerStore();
const media = computed(() => player.media);

const tracks = computed(() => media.value.tracks.filter(t => t.kind === props.kind));
const embedded = computed(() => tracks.value.filter(t => !t.external));
/** One server subtitle row whose stream number is known — the address the player asks for. */
type SidecarRow = MediaStreamInfo & { index: number };
/** The subtitles this version keeps as files beside the video. They are rows of the server's answer, not of
 *  mpv's: the stream the player opened does not contain them, so nothing about them ever reaches
 *  `media.tracks` until one is picked and its bytes handed over. A picture subtitle (.sup) is left out —
 *  measured 2026-10-27, 3 of the 784 sidecar rows in both corpora are one, and mpv can only decode those
 *  inside a container, so the row would sit in the menu promising a subtitle that fails when clicked. */
const sidecars = computed<SidecarRow[]>(() => {
  const s = player.session;
  const src = s ? s.sources[s.sourceIndex] : undefined;
  return (src?.subtitle || []).flatMap(t =>
    t.isExternal && t.isTextSubtitle !== false && typeof t.index === 'number' ? [{ ...t, index: t.index }] : [],
  );
});
const current = computed<TrackSelection>(() => (props.kind === 'subtitle' ? media.value.subtitle : props.kind === 'audio' ? media.value.audio : media.value.video));

/** The row is 正在用 only while the track this viewing fetched is the one mpv is showing: the id says the
 *  track is on screen, the index says it is this row's rather than a sidecar picked before a reload. */
const inUse = (s: SidecarRow): boolean =>
  !!media.value.sidecar && media.value.sidecar.index === s.index && current.value === media.value.sidecar.trackId;

/** mpv numbers each kind from 1, so the row the user picks has to say which one it is. The title is the
 *  container's own, in whatever language the release group worked in — the same string the 播放资源 card
 *  translates — so this menu says 巴西 and 听障 where the file said 「Brazilian Portuguese」 and 「SDH」.
 *  A title that only re-says the language leaves the row to the language itself. */
const rowLabel = (t: PlayerTrack): string => {
  const said = zhTrackWords((t.title || '').trim(), t.lang || '', false);
  const lang = langName(t.lang);
  const head = said || lang || `轨道 ${t.id}`;
  return `${t.id}. ${head}${t.forced ? '（强制）' : ''}`;
};
/** The language rides beside the row only when the row does not already say it — 「12. 巴西 葡萄牙语」
 *  needs both halves, 「12. 葡萄牙语 葡萄牙语」 says one thing twice. */
const subLang = (t: PlayerTrack): string => {
  const lang = langName(t.lang);
  return lang && rowLabel(t).includes(lang) ? '' : lang;
};

const meta = (t: PlayerTrack): string => [t.selected ? '正在用' : '', t.codec ? t.codec.toUpperCase() : ''].filter(Boolean).join(' · ');

/** A sidecar named by the same pass the 播放资源 card runs, so one track cannot read 巴西 葡萄牙语 there and
 *  Brazilian Portuguese here. The card clusters by language and lets the head carry it; these rows are one
 *  per file, so the language is the floor a title that restates nothing still falls back to — and this is
 *  the menu rather than the card, so a row with no `Title` reads the server's own `DisplayTitle`. Measured
 *  2026-10-27 over both corpora: all 784 sidecar rows have a `DisplayTitle`, 631 of them have no `Title`,
 *  and the ones that have neither say nothing but the codec in brackets — 「(SRT)」, 「(ASS)」, 「(SUP)」 —
 *  which is why the pass runs on the title it fell back to and can still come home empty. */
const sidecarName = (s: MediaStreamInfo): string => {
  const said = zhTrackWords(openBrackets(s.title || s.displayTitle || ''), s.lang || '', false);
  // 未标语言 rather than 外挂字幕: the row already sits under a 外挂字幕 header, so repeating it there would be
  // the section's name standing in for the track's. Measured 2026-10-27: 210 of the sidecar rows that reach
  // this menu say neither a title nor a language — and no version keeps two of them at once (0 of 554
  // sources with a sidecar), so the word needs no ordinal beside it.
  return `${said || langName(s.lang) || '未标语言'}${s.isForced ? '（强制）' : ''}`;
};
/** The same rule the 内封 rows follow: the language rides beside the row only when the row does not already
 *  say it, because 「简体中文 中文（简）」 is one fact printed twice. */
const sidecarLang = (s: MediaStreamInfo): string => {
  const lang = langName(s.lang);
  return lang && sidecarName(s).includes(lang) ? '' : lang;
};
const sidecarMeta = (s: SidecarRow): string =>
  [inUse(s) ? '正在用' : '', s.codec ? s.codec.toUpperCase() : ''].filter(Boolean).join(' · ');

async function pick(id: TrackSelection): Promise<void> {
  await player.cmd({ action: 'track', value: { kind: props.kind, id } });
}

/** Asking for the file rather than a track number: the bytes are not in what mpv opened, so main has to go
 *  and fetch them before there is a track to select. */
async function pickSidecar(s: SidecarRow): Promise<void> {
  await player.cmd({ action: 'sidecarSubtitle', value: s.index });
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
        <span v-if="subLang(t)" class="sub">{{ subLang(t) }}</span>
      </span>
      <span class="meta">{{ meta(t) }}</span>
    </button>
    <p v-if="!embedded.length && !sidecars.length" class="pl-empty">这个文件里没有字幕</p>

    <div v-if="sidecars.length" class="pl-sect">外挂字幕</div>
    <button v-for="s in sidecars" :key="s.index" class="pl-row" :class="{ on: inUse(s) }" @click="pickSidecar(s)">
      <span class="mark"></span>
      <span class="label">
        {{ sidecarName(s) }}
        <span v-if="sidecarLang(s)" class="sub">{{ sidecarLang(s) }}</span>
      </span>
      <span class="meta">{{ sidecarMeta(s) }}</span>
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
