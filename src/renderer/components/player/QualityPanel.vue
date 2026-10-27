<script setup lang="ts">
import { computed } from 'vue';
import { Shield } from 'lucide-vue-next';
import SubPopover from './SubPopover.vue';
import SubRow from './SubRow.vue';
import { usePlayerStore } from '../../stores/player';
import { useAppStore } from '../../stores/app';
import { fmtRate, fmtSize, rangeWord } from '../../lib/format';
import { hasContent, type PlayMethod, type PlaybackSource, type PlayerPrefs } from '../../../shared/types';

const player = usePlayerStore();
const app = useAppStore();
const session = computed(() => player.session);
const media = computed(() => player.media);
const prefs = computed<PlayerPrefs>(() => app.config?.settings.player || ({} as PlayerPrefs));

const METHOD_CN: Record<PlayMethod, string> = { DirectPlay: '直接播放', DirectStream: '直接串流', Transcode: '转码' };

/** 0 is the rung that forbids transcoding outright, which is what 原片 means to Emby. */
const methodLabel = (m?: PlayMethod): string => (m ? METHOD_CN[m] : '未试过');

async function setTier(bitrate: number): Promise<void> {
  if (session.value?.tier === bitrate) return;
  // Writing the setting is the one path the main process listens to: it re-negotiates and reloads in
  // place, so the panel does not need a second command of its own.
  await app.saveSettings({ player: { tier: bitrate } });
}

async function patch(p: Partial<PlayerPrefs>): Promise<void> {
  await app.saveSettings({ player: p });
}

const HWDECS: { value: PlayerPrefs['hwdec']; label: string }[] = [
  { value: 'd3d11va', label: 'D3D11' },
  { value: 'cuda', label: 'CUDA' },
  { value: 'auto', label: '自动' },
  { value: 'no', label: '软解' },
];

/** Each card answers for its own version, so the range is that version's and not the session's: every card
 *  in this popover used to print the one word the playing file decided, which read 「HDR」 on a 1080p SDR
 *  version sitting beside the 4K Dolby Vision one that was actually playing. */
const kind = (src: PlaybackSource): string => rangeWord(src.video?.range) || (src.video ? '—' : '无视频轨');
/** Size and rate come from the same two formatters the 播放资源 card reads, because one file's 834749497
 *  bytes are not two facts: this panel divided by 1024³ and always said GB, so a 3 MB 特别篇 read
 *  「0.00 GB」, and it said Mbps for a 192 kbps audio track, which is one significant figure standing in for
 *  the number that separates two dubs. The dash is this panel's own word for 「the server did not say」. */
const size = (n?: number): string => fmtSize(n) || '—';
const rate = (n?: number): string => fmtRate(n) || '—';

function pickSource(index: number): void {
  void player.cmd({ action: 'source', value: index });
}

/** The versions this panel offers, with the seat each one holds in the session's own list — `source` is a
 *  command argument, so a filtered view has to carry the index it was cut from. The rows the server lists
 *  but cannot probe (no stream at all: 133 of 23,027 sources measured 2026-10-27) are left out: pressing one
 *  here reloads the player onto a path that answers HTTP 500, and the 播放资源 card already keeps that row
 *  visible-and-untouchable for the reader who wants to know the file has it. */
const versions = computed(() => (session.value?.sources || []).map((src, i) => ({ src, i })).filter(r => hasContent(r.src)));

/** The version actually playing, whose range is what the 动态范围 row answers for. `session.hdr` is a
 *  yes/no, so that row called Dolby Vision and HDR10 both 「HDR」 while the cards it opens named them — two
 *  spellings of one fact on one panel. mpv's own flag is the fallback for the source that reports no video
 *  stream at all, where the server has nothing to say and the decoder still does. */
const playingRange = computed(() => {
  const s = session.value;
  return rangeWord(s?.sources[s.sourceIndex]?.video?.range) || (s?.hdr || media.value.hdr ? 'HDR' : 'SDR');
});
</script>

<template>
  <div class="pl-sect">清晰度</div>
  <button v-for="t in session?.tiers || []" :key="t.bitrate" class="pl-row" :class="{ on: session?.tier === t.bitrate }" @click="setTier(t.bitrate)">
    <span class="mark"></span>
    <span class="label">{{ t.label }}</span>
    <span class="meta">{{ session?.tier === t.bitrate ? methodLabel(t.method) : '' }}</span>
  </button>

  <div class="pl-sep"></div>
  <SubRow name="sources" label="播放源" :value="`${versions.length} 个版本`" />
  <SubRow name="decode" label="解码与渲染" :value="media.hwdec || '软解'" />
  <SubRow name="range" label="动态范围" :value="playingRange" />

  <SubPopover name="sources" title="播放源">
    <div class="pl-grid">
      <button v-for="v in versions" :key="v.src.id" class="pl-card" :class="{ on: session?.sourceIndex === v.i }" @click="pickSource(v.i)">
        <span class="kind">{{ kind(v.src) }}</span>
        <span>{{ size(v.src.sizeBytes) }}</span>
        <span>{{ rate(v.src.bitRate) }}</span>
        <span class="who">
          <Shield :size="17" :fill="session?.sourceIndex === v.i ? '#6ddc8f' : 'rgba(255,255,255,.4)'" stroke-width="1.6" />
          {{ v.src.name || `版本 ${v.i + 1}` }}
        </span>
      </button>
    </div>
    <p v-if="!versions.length" class="pl-empty">这个条目没有可播放的版本</p>
    <p v-else-if="versions.length < 2" class="pl-empty">这个条目只有一个版本</p>
  </SubPopover>

  <SubPopover name="decode" title="解码与渲染">
    <div class="pl-sect">解码器</div>
    <div class="pl-chips">
      <button v-for="h in HWDECS" :key="h.value" class="pl-chip" :class="{ on: prefs.hwdec === h.value }" @click="patch({ hwdec: h.value })">{{ h.label }}</button>
    </div>
    <p class="pl-note">实际用上的那个写在下面：选了自动或硬件不可用时，mpv 会落回软解。</p>
    <div class="pl-line"><span class="label">正在用</span><span class="pl-text">{{ media.hwdec || '—' }}</span></div>
    <div class="pl-sep"></div>
    <div class="pl-sect">渲染</div>
    <div class="pl-line">
      <span class="label">取向</span>
      <span class="pl-seg">
        <button :class="{ on: prefs.render !== 'hq' }" @click="patch({ render: 'smooth' })">流畅优先</button>
        <button :class="{ on: prefs.render === 'hq' }" @click="patch({ render: 'hq' })">清晰优先</button>
      </span>
    </div>
    <p class="pl-note">清晰优先开的是 gpu-hq，会换一个新的 mpv 进程：画面会黑一下。</p>
  </SubPopover>

  <SubPopover name="range" title="动态范围">
    <div class="pl-line"><span class="label">这条片源</span><span class="pl-text">{{ playingRange }}</span></div>
    <div class="pl-line"><span class="label">色彩空间</span><span class="pl-text">{{ media.colorSpace || '—' }}</span></div>
    <div class="pl-switch" role="switch" tabindex="0" :aria-checked="!!prefs.hdrHint" :class="{ on: prefs.hdrHint }" @click="patch({ hdrHint: !prefs.hdrHint })">
      <span class="label">把 HDR 信号交给显示器</span>
      <span class="track"><i></i></span>
    </div>
    <p class="pl-note">关掉时 mpv 把 HDR 压成 SDR 显示；打开后如果屏幕不支持 HDR，画面会发灰。改动在下一次播放生效。</p>
  </SubPopover>
</template>
