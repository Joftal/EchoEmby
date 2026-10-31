<script setup lang="ts">
import { computed, ref } from 'vue';
import SubPopover from './SubPopover.vue';
import SubRow from './SubRow.vue';
import StepRow from './StepRow.vue';
import { usePlayerStore } from '../../stores/player';
import { useAppStore } from '../../stores/app';
import { channelsWord, codecLabel, fmtRate, formatWord, langName, layoutWord, NO_LANG, openBrackets, saidLang, zhTrackWords } from '../../lib/format';
import type { FitMode, MediaStreamInfo, PlayerTrack, TrackSelection } from '../../../shared/types';

/** Body only: the card that holds this belongs to SheetLayer, and so does its title. */
const props = defineProps<{ kind: 'subtitle' | 'audio' | 'video' }>();
const player = usePlayerStore();
const app = useAppStore();
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
 *  A title that only re-says the language leaves the row to the language itself, and a row with neither
 *  says 无语言 — the card's word for the same fact, not the 「轨道 1」 this line used to invent next to a
 *  sibling named 英语. The number the row was reaching for is already the one in front of it. */
const rowLabel = (t: PlayerTrack, i?: number): string => {
  const said = zhTrackWords((t.title || '').trim(), t.lang || '', false);
  const lang = langName(t.lang);
  const head = said || lang || NO_LANG;
  // The step of the row in its own list, not mpv's id: once a 本地字幕 holds id 1 the file's own subtitles
  // start at 2, and a list that opens on 「2.」 reads like a row is missing.
  const n = i === undefined ? t.id : i + 1;
  return `${n}. ${head}${t.forced ? '（强制）' : ''}`;
};
/** The language rides beside the row only when the row does not already say it — 「12. 巴西 葡萄牙语」
 *  needs both halves, 「12. 葡萄牙语 葡萄牙语」 says one thing twice. `saidLang` is the version of that
 *  test which counts a script word as the language it qualifies: a sidecar titled 「简体」 under a `zh-cn`
 *  language has already said 中文（简）, and the plain `includes` this line used to run read it as news and
 *  printed 「简体 / 中文（简）」 on the two lines of one row. */
const subLang = (t: PlayerTrack): string => (saidLang(rowLabel(t), t.lang) ? '' : langName(t.lang));

/* The codec column is the same word the 播放资源 card prints for the same stream, not the raw id: mpv names
   a subtitle `subrip` where the card says SRT, and `hdmv_pgs_subtitle` where it says PGS — measured
   2026-10-28 over the 127 tracks of the one-file-per-codec walk. It is also the only thing that tells two
   rows apart once their titles fold to the same words, so it stays on the row, just spelled one way. */
/** The server's own row for the stream mpv opened, matched on the container's stream number - the one
 *  number both sides agree on (mpv's `ff-index` and the server's `MediaStreamInfo.index`). The menu
 *  takes its numbers from here because mpv does not carry them: on the live pipe it answers
 *  `demux-channel-count` and `demux-channels`, but the layout word is 「unknown6」 beside a real 5.1
 *  track, and there is no bitrate at all. */
const audioStream = (t: PlayerTrack): MediaStreamInfo | undefined => {
  const s = player.session;
  const src = s ? s.sources[s.sourceIndex] : undefined;
  const list = src?.audio || [];
  return typeof t.ffIndex === 'number' ? list.find(a => a.index === t.ffIndex) : undefined;
};
/** 英语 · EAC3 left two tracks of one file saying the same thing: 死神来了2's 5.1 main mix and its 2.0
 *  commentary credit list are both `eng` `ac3`. The 播放资源 card has always printed the layout and the
 *  rate beside the codec (「英语 · AC3 · 5.1 · 768 kbps · 48 kHz」), so the menu says the same two words in
 *  the same order rather than making the viewer open the card to tell the tracks apart. The sample rate
 *  stays on the card: it is the one field no pair of tracks in these corpora differs by, and the menu's
 *  column is one line wide. */
const audioMeta = (t: PlayerTrack): string => {
  const a = audioStream(t);
  return [
    t.selected ? '正在用' : '',
    // The server's profile is the half mpv does not carry: it reports `dts` where the card says
    // 「DTS-HD MA」, so the profile wins whenever there is one and the codec alone is the fallback.
    codecLabel(t.codec, a?.profile) || formatWord(t.codec),
    layoutWord(a?.channelLayout) || channelsWord(a?.channels || t.channels),
    fmtRate(a?.bitRate),
  ].filter(Boolean).join(' · ');
};
/** The subtitle and video rows keep the codec-only reading they always had: a subtitle has no layout or
 *  rate to print, and a video track's numbers live on the 画面 panel beside this one. */
const meta = (t: PlayerTrack): string =>
  [t.selected ? '正在用' : '', formatWord(t.codec)].filter(Boolean).join(' · ');

/** A sidecar named by the same pass the 播放资源 card runs, so one track cannot read 巴西 葡萄牙语 there and
 *  Brazilian Portuguese here. The card clusters by language and lets the head carry it; these rows are one
 *  per file, so the language is the floor a title that restates nothing still falls back to — and this is
 *  the menu rather than the card, so a row with no `Title` reads the server's own `DisplayTitle`. Measured
 *  2026-10-27 over both corpora: all 784 sidecar rows have a `DisplayTitle`, 631 of them have no `Title`,
 *  and the ones that have neither say nothing but the codec in brackets — 「(SRT)」, 「(ASS)」, 「(SUP)」 —
 *  which is why the pass runs on the title it fell back to and can still come home empty. */
const sidecarName = (s: MediaStreamInfo): string => {
  const said = zhTrackWords(openBrackets(s.title || s.displayTitle || ''), s.lang || '', false);
  // Not 外挂字幕, which is the name of the section the row sits under and says nothing about the track.
  // Measured 2026-10-28, 215 of the 784 sidecar rows that reach this menu say neither a title nor a
  // language. The card's 无语言 is the word for that, and it is the same one the 内封 rows above print, so
  // the two sections of one menu cannot say one fact two ways. No version keeps two sidecars at once (0 of
  // 554 sources with a sidecar), so the word needs no ordinal beside it.
  return `${said || langName(s.lang) || NO_LANG}${s.isForced ? '（强制）' : ''}`;
};
/** The same rule the 内封 rows follow: the language rides beside the row only when the row does not already
 *  say it, because 「简体中文 中文（简）」 is one fact printed twice. */
const sidecarLang = (s: MediaStreamInfo): string => (saidLang(sidecarName(s), s.lang) ? '' : langName(s.lang));
const sidecarMeta = (s: SidecarRow): string =>
  [inUse(s) ? '正在用' : '', formatWord(s.codec)].filter(Boolean).join(' · ');

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

/** 适应 / 填满 / 拉伸, named the way the 设置 row names them. This menu used to offer only mpv's two panscan
 *  ends; 拉伸填满 is the pair (keepaspect=no, panscan=0) that leaves no black bars and no cropped edge, so the
 *  three answers are one setting in both places rather than two in one and two-and-a-half in the other. */
const FITS: { value: FitMode; label: string }[] = [
  { value: 'fit', label: '适应屏幕' },
  { value: 'fill', label: '填满屏幕' },
  { value: 'stretch', label: '拉伸填满' },
];

/** mpv's own pair, read back, so the row reports what the picture is doing — including a change made in 设置
 *  while this window was open, which lands through `applyPrefs` and arrives here as a property event. */
const fitMode = computed<FitMode>(() =>
  media.value.keepaspect === false ? 'stretch' : media.value.panscan >= 0.99 ? 'fill' : 'fit',
);

/** The menu writes the setting, the way the 解码 row in 播放资源 does: a choice made here answers 「how should
 *  films sit in this window」 for every file, and a session-only answer would be undone by the next episode. */
async function setFit(mode: FitMode): Promise<void> {
  await player.cmd({ action: 'fit', value: mode });
  await app.saveSettings({ player: { fit: mode } });
}

const delayMs = computed(() => (props.kind === 'audio' ? media.value.audioDelayMs : media.value.subtitleDelayMs));

/** What 显示设置 reports on its closed row: the two values that were always there, plus the three this menu
 *  later grew — otherwise a speed of ×1.40 or a shifted file would be invisible from the menu that set it. */
const styleMeta = computed(() => {
  const parts = [`${media.value.subtitleScale}%`, `${delayMs.value > 0 ? '+' : ''}${(delayMs.value / 1000).toFixed(1)}s`];
  if (media.value.subtitleSpeed !== 100) parts.push(`×${(media.value.subtitleSpeed / 100).toFixed(2)}`);
  if (media.value.subtitlePos !== 100) parts.push(`高度 ${media.value.subtitlePos}%`);
  const dy = media.value.localSub?.dy ?? 0;
  if (dy) parts.push(`位移 ${dy > 0 ? '+' : ''}${dy}px`);
  return parts.join(' · ');
});

/** 本地字幕. The picker is a native dialog, so it is one round trip from here to main and the answer comes
 *  back through the media push rather than as a value this component stores: what is on screen is mpv's
 *  track list, not this file's opinion of it. */
/** What the local row says on its right: a picture track is neither 可调高度 nor 自带定位 — its placement was
 *  painted into the frames by whoever authored it. */
const localMeta = computed(() => {
  const l = media.value.localSub;
  if (!l) return '';
  if (l.bitmap) return '图像字幕';
  return l.positioned ? '自带定位' : '可调高度';
});
const picking = ref(false);
async function pickSubtitle(): Promise<void> {
  if (picking.value) return;
  picking.value = true;
  try {
    const r = await window.echoemby.player.pickSubtitle();
    if (!r.ok) player.say(r.error || '没有导入字幕文件');
  } catch {
    player.say('没有导入字幕文件');
  } finally {
    picking.value = false;
  }
}
function dropLocal(): void {
  void player.cmd({ action: 'dropLocalSubtitle' });
}
/** 特效位置 moves the copy itself, in ten-pixel steps: on a file that writes its own coordinates mpv's
 *  `sub-pos` does nothing at all (measured), so this is a rewrite-and-re-add rather than a property. */
function shiftLocal(dx: number, dy: number): void {
  const local = media.value.localSub;
  if (!local) return;
  if (!dx && !dy) return;
  void player.cmd({ action: 'subtitleShift', value: { dx, dy } });
}
/** 字幕速度 is a factor of real time: a file timed by hand can sit seconds off, and moving the whole track is
 *  the only cure that does not rewrite every cue. Steps of 5% stay inside what a viewer can judge by eye. */
function nudgeSpeed(dir: number): void {
  const v = Math.max(25, Math.min(400, media.value.subtitleSpeed + dir * 5));
  void player.cmd({ action: 'subtitleSpeed', value: Math.round(v) });
}
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
    <button v-for="(t, i) in embedded" :key="t.id" class="pl-row" :class="{ on: current === t.id }" @click="pick(t.id)">
      <span class="mark"></span>
      <span class="label">
        {{ rowLabel(t, i) }}
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

    <div class="pl-sect">本地字幕</div>
    <button v-if="media.localSub" class="pl-row" :class="{ on: current === media.localSub.trackId }" @click="pick(media.localSub.trackId)">
      <span class="mark"></span>
      <span class="label">
        {{ media.localSub.name }}
        <span class="sub">本地</span>
      </span>
      <span class="meta">{{ localMeta }}</span>
    </button>
    <p v-else class="pl-empty">电脑里的字幕文件可以直接拿进来用</p>
    <div class="pl-chips">
      <button class="pl-chip" :disabled="picking" @click="pickSubtitle">{{ media.localSub ? '换一个字幕文件…' : '导入字幕文件…' }}</button>
      <button v-if="media.localSub" class="pl-chip" @click="dropLocal">移除</button>
    </div>

    <div class="pl-sep"></div>
    <SubRow name="style" label="显示设置" :value="styleMeta" />
  </template>

  <template v-else-if="kind === 'audio'">
    <button v-for="(t, i) in tracks" :key="t.id" class="pl-row" :class="{ on: current === t.id }" @click="pick(t.id)">
      <span class="mark"></span>
      <span class="label">{{ rowLabel(t, i) }}</span>
      <span class="meta">{{ audioMeta(t) }}</span>
    </button>
    <p v-if="!tracks.length" class="pl-empty">这个文件里没有可切换的音轨</p>
    <div v-if="tracks.length" class="pl-sep"></div>
    <SubRow name="delay" label="声音延迟" :value="`${(delayMs / 1000).toFixed(1)}s`" />
  </template>

  <template v-else>
    <SubRow name="fit" label="画面适配" :value="FITS.find(f => f.value === fitMode)?.label || ''" />
    <SubRow name="aspect" label="画面比例" :value="ASPECTS.find(a => isAspect(a.value))?.label || ''" />
    <template v-if="tracks.length > 1">
      <div class="pl-sect">视频轨道</div>
      <button v-for="(t, i) in tracks" :key="t.id" class="pl-row" :class="{ on: current === t.id }" @click="pick(t.id)">
        <span class="mark"></span>
        <span class="label">{{ rowLabel(t, i) }}</span>
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
    <StepRow v-if="!media.localSub?.positioned" label="高度" :text="`${media.subtitlePos}%`" @down="player.cmd({ action: 'subtitleStyle', value: { pos: Math.max(0, media.subtitlePos - 2) } })" @up="player.cmd({ action: 'subtitleStyle', value: { pos: Math.min(100, media.subtitlePos + 2) } })" />
    <p v-else class="pl-note">这条字幕自己写死了坐标，没有「高度」可调，用下面的「特效位置」整块挪动。</p>
    <StepRow label="速度" :text="`×${(media.subtitleSpeed / 100).toFixed(2)}`" @down="nudgeSpeed(-1)" @up="nudgeSpeed(1)" />
    <div class="pl-chips">
      <button class="pl-chip" @click="player.cmd({ action: 'subtitleSpeed', value: 100 })">原速</button>
    </div>
    <template v-if="media.localSub?.positioned">
      <StepRow label="特效位置" :text="`${media.localSub.dy > 0 ? '+' : ''}${media.localSub.dy}px`" @down="shiftLocal(0, -10)" @up="shiftLocal(0, 10)" />
      <div class="pl-chips">
        <button class="pl-chip" @click="shiftLocal(-10, 0)">左移</button>
        <button class="pl-chip" @click="shiftLocal(10, 0)">右移</button>
        <button class="pl-chip" @click="shiftLocal(-media.localSub.dx, -media.localSub.dy)">复位</button>
      </div>
    </template>
  </SubPopover>

  <SubPopover v-else-if="kind === 'audio'" name="delay" title="声音延迟">
    <StepRow label="延迟" :text="`${(delayMs / 1000).toFixed(1)}s`" @down="nudgeDelay(-1)" @up="nudgeDelay(1)" />
    <div class="pl-chips">
      <button class="pl-chip" @click="player.cmd({ action: 'audioDelay', value: 0 })">复位</button>
    </div>
  </SubPopover>

  <template v-else>
    <SubPopover name="fit" title="画面适配">
      <button v-for="f in FITS" :key="f.value" class="pl-row" :class="{ on: fitMode === f.value }" @click="setFit(f.value)">
        <span class="mark"></span>
        <span class="label">{{ f.label }}</span>
      </button>
      <p class="pl-note">填满把画面放大到没有黑边，代价是超出比例的部分被切掉；拉伸填满不管原片比例，直接把画面拉满窗口。</p>
    </SubPopover>

    <SubPopover name="aspect" title="画面比例">
      <button v-for="a in ASPECTS" :key="a.label" class="pl-row" :class="{ on: isAspect(a.value) }" @click="setAspect(a.value)">
        <span class="mark"></span>
        <span class="label">{{ a.label }}</span>
      </button>
    </SubPopover>
  </template>
</template>
