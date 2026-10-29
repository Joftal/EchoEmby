<script setup lang="ts">
import { computed } from 'vue';
import { Shield } from 'lucide-vue-next';
import SubPopover from './SubPopover.vue';
import SubRow from './SubRow.vue';
import { usePlayerStore } from '../../stores/player';
import { useAppStore } from '../../stores/app';
import { decoderWord, fmtRate, fmtSize, colorSpaceWord, rangeWord } from '../../lib/format';
import { versionNames } from '../../../shared/version-label';
import { ANIME4K_LABELS, ANIME4K_LEVELS, ANIME4K_NOTES } from '../../../shared/anime4k';
import { hasContent, type PlayMethod, type PlaybackSource, type PlayerPrefs } from '../../../shared/types';

const player = usePlayerStore();
const app = useAppStore();
const session = computed(() => player.session);
const media = computed(() => player.media);
const prefs = computed<PlayerPrefs>(() => app.config?.settings.player || ({} as PlayerPrefs));

const METHOD_CN: Record<PlayMethod, string> = { DirectPlay: '直接播放', DirectStream: '直接串流', Transcode: '转码' };

/** The app never asks the server to re-encode: a version that cannot be handed over whole is refused by the
 *  negotiation, so 转码 has no way to reach this row and what it prints is a confirmation rather than a
 *  choice. The dash is the panel open with no session, where there is no answer to give yet. */
const methodLabel = (m?: PlayMethod | ''): string => (m ? METHOD_CN[m] : '—');

async function patch(p: Partial<PlayerPrefs>): Promise<void> {
  await app.saveSettings({ player: p });
}

const HWDECS: { value: PlayerPrefs['hwdec']; label: string }[] = [
  { value: 'd3d11va', label: 'D3D11' },
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

/** The version's own word, from the same shape vocabulary the 播放资源 card reads. This row used to print
 *  the server's `Name` whole, which on a movie is 「僵尸世界大战 (2013) - 2160p」 — the film title, the year
 *  and a resolution, in a card that already prints its size, its bitrate and its range — and on an episode
 *  is the filename. Two surfaces then named one file two ways, and only one of them said anything the card
 *  below it had not already said. */
const names = computed(() => versionNames(session.value?.sources || []));
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
  <SubRow name="sources" label="播放源" :value="`${versions.length} 个版本`" />
  <SubRow name="decode" label="解码" :value="decoderWord(media.hwdec) || '软解'" />
  <SubRow name="range" label="动态范围" :value="playingRange" />
  <SubRow name="quality" label="Anime4K" :value="ANIME4K_LABELS[prefs.anime4k || 'off']" />

  <SubPopover name="sources" title="播放源">
    <div class="pl-grid">
      <button v-for="v in versions" :key="v.src.id" class="pl-card" :class="{ on: session?.sourceIndex === v.i }" @click="pickSource(v.i)">
        <span class="kind">{{ kind(v.src) }}</span>
        <span>{{ size(v.src.sizeBytes) }}</span>
        <span>{{ rate(v.src.bitRate) }}</span>
        <span class="who">
          <Shield :size="17" :fill="session?.sourceIndex === v.i ? '#6ddc8f' : 'rgba(255,255,255,.4)'" stroke-width="1.6" />
          {{ versions.length < 2 ? '正在用' : names[v.i] }}
        </span>
      </button>
    </div>
    <p v-if="!versions.length" class="pl-empty">这个条目没有可播放的版本</p>
    <p v-else-if="versions.length < 2" class="pl-empty">这个条目只有一个版本</p>
    <div class="pl-sep"></div>
    <div class="pl-line"><span class="label">播放方式</span><span class="pl-text">{{ methodLabel(session?.method) }}</span></div>
  </SubPopover>

  <SubPopover name="decode" title="解码">
    <div class="pl-sect">解码器</div>
    <div class="pl-chips">
      <button v-for="h in HWDECS" :key="h.value" class="pl-chip" :class="{ on: prefs.hwdec === h.value }" @click="patch({ hwdec: h.value })">{{ h.label }}</button>
    </div>
    <p class="pl-note">实际用上的那个写在下面：选了自动或硬件不可用时，mpv 会落回软解。</p>
    <div class="pl-line"><span class="label">正在用</span><span class="pl-text">{{ decoderWord(media.hwdec) || '—' }}</span></div>
  </SubPopover>

  <SubPopover name="range" title="动态范围">
    <div class="pl-line"><span class="label">这条片源</span><span class="pl-text">{{ playingRange }}</span></div>
    <div class="pl-line"><span class="label">色彩空间</span><span class="pl-text">{{ colorSpaceWord(media.colorSpace) || '—' }}</span></div>
    <div class="pl-switch" role="switch" tabindex="0" :aria-checked="!!prefs.hdr" :class="{ on: prefs.hdr }" @click="patch({ hdr: !prefs.hdr })">
      <span class="label">播放时打开 Windows 的 HDR</span>
      <span class="track"><i></i></span>
    </div>
    <p class="pl-note">这一项管的是 Windows 自己的 HDR 开关：播放 HDR 片源时替你打开，关掉播放器或换成 SDR 片源时再还原，屏幕会黑一下。屏幕本来就不支持 HDR 时什么也不会发生，mpv 照旧把它压成 SDR。改这一项立刻生效。</p>
  </SubPopover>

  <SubPopover name="quality" title="Anime4K 画质增强">
    <div class="pl-sect">档位</div>
    <div class="pl-chips">
      <button v-for="l in ANIME4K_LEVELS" :key="l" class="pl-chip" :class="{ on: prefs.anime4k === l }" @click="patch({ anime4k: l })">{{ ANIME4K_LABELS[l] }}</button>
    </div>
    <p class="pl-note">{{ ANIME4K_NOTES[prefs.anime4k || 'off'] }}</p>
    <p class="pl-note">换档立刻生效，画面不会中断。修复这一步任何尺寸都跑；放大只在窗口比画面大 1.2 倍以上时才起作用，所以 1080p 片源在 1080p 窗口上开「标准」是看不出差别的，720p 片源放大到 1080p 窗口最明显。</p>
  </SubPopover>
</template>
