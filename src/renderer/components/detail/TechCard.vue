<script setup lang="ts">
import { computed } from 'vue';
import { fmtDateTime, langName } from '../../lib/format';
import type { LibraryItem, MediaStreamInfo } from '../../../shared/types';

/** One file's technical sheet: the strip that names the version, the two codec columns, the track list, and
 *  the two lines about the file itself. It takes the row rather than an id because the row is what carries
 *  `sources` — and only the item endpoint ever fills that field (measured 2026-10-22: the season listing
 *  answers zero MediaSources on every episode row).
 *
 *  The same component serves both places it can appear: inline under the hero on a page that has no episode
 *  row (a movie, a single video), and inside the popup a 分集 card's corner button opens.
 *
 *  Who owns which number: the strip answers 「this file」 (range, size, bitrate, container), the two cards
 *  answer 「this stream」, the wide card answers 「what else is in it」. 色彩范围/文件大小/文件码率 used to sit
 *  in the 视频 card too, which printed the same three values twice four rows apart. */
const props = defineProps<{ item: LibraryItem | null }>();

const source = computed(() => props.item?.sources?.[0]);
const vstream = computed(() => source.value?.video);
const astream = computed<MediaStreamInfo | undefined>(() => {
  const a = source.value?.audio || [];
  return a.find(x => x.isDefault) || a[0];
});
/** What the server used to tell two tracks of one language apart, in the reader's own language. The titles
 *  on these files are English even when everything else on the page is Chinese — 「中文（Chinese
 *  Simplified） / 中文（Chinese Traditional）」 said 简体 and 繁体 in two scripts to make one point — and a
 *  title that already carries parentheses, 「English (SDH)」, would have printed a second pair around it.
 *  What is left after the known shapes are named is the title itself; what is left of nothing is the codec. */
const discName = (s: MediaStreamInfo): string => {
  const t = s.title || '';
  if (/simplified|chs\b/i.test(t)) return '简体';
  if (/traditional|cht\b/i.test(t)) return '繁体';
  if (/sdh|hearing/i.test(t)) return 'SDH';
  if (/forced/i.test(t)) return '强制';
  return t.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim() || s.codec?.toUpperCase() || '';
};
/** Two subtitle tracks of one file share a language code on 36 of 40 files here — 简体 and 繁体 both come
 *  back `chi` — so a join of the codes alone printed 「chi / chi」 and told the reader nothing. Where a
 *  language repeats, whatever the server used to separate the tracks rides along: its own Title, and failing
 *  that the codec. Labels that come out identical are one label: the two `spa` ASS tracks of FX战士久留美
 *  differ in no field the gateway reports, and printing 西文（ASS） twice only lengthened the line. */
const subLabels = computed<string[]>(() => {
  const subs = source.value?.subtitle || [];
  const langs = subs.map(s => s.lang || '');
  const repeated = new Set(langs.filter((l, i) => langs.indexOf(l) !== i));
  const out = subs.map(s => {
    const lang = langName(s.lang) || '无语言';
    const disc = repeated.has(s.lang || '') ? discName(s) : '';
    return disc ? `${lang}（${disc}）` : lang;
  });
  return [...new Set(out)];
});
/** Which release this file is, in the server's own words. Present on 52 of 52 sampled files on both gateways
 *  (「师兄啊师兄 - S01E164 - 第 164 集」, 「final.destination.2.2003.4…」) and the only field that answers
 *  「我这一版是哪来的」, so it is printed rather than dropped. */
const file = computed(() => source.value?.name || '');
const added = computed(() => (props.item?.dateCreated ? fmtDateTime(props.item.dateCreated) : ''));

/** A 3 MB 特别篇 file printed 「0.00 GB」 under a two-decimal GB rule, and 11 of the 14 files in one such
 *  season were under 10 MB. The unit follows the number instead. */
const fmtSize = (n?: number): string => {
  if (!n) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  const mb = n / 1e6;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`;
};
/** An audio stream rounded to 「0.2 Mbps」 is one significant figure standing in for 192 or 208 kbps, so
 *  under a megabit the number is stated in kilobits — which is where audio bitrates actually live. */
const fmtRate = (n?: number): string => (!n ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)} Mbps` : `${Math.round(n / 1e3)} kbps`);
const fmtRes = (v?: MediaStreamInfo): string => (v?.width && v?.height ? `${v.width}×${v.height}` : '');
/** 44100 and 48000 are the two readings worth comparing, but a bare number was the only value on this sheet
 *  carrying no unit. */
const fmtHz = (n?: number): string => (!n ? '' : `${+(n / 1000).toFixed(1)} kHz`);
const fmtFps = (n?: number): string => (!n ? '' : `${+n.toFixed(2)} fps`);
/** 6 channels is 5.1 or 2×stereo or 3.1 depending on the layout, and the count alone cannot say which —
 *  `ChannelLayout` came back on 62 of 62 sampled streams, so it is printed next to the count. */
const fmtLayout = (s?: string): string =>
  !s ? '' : s === 'mono' ? '单声道' : s === 'stereo' ? '立体声' : s.replace(/\(.*\)/, '').trim() || s;
</script>

<template>
  <div v-if="source" class="sheet">
    <div class="src">
      <div class="srccard">
        <p class="sc-top">{{ vstream?.range || 'SDR' }}</p>
        <p class="sc-meta"><span>{{ fmtSize(source.sizeBytes) }}</span><span>{{ fmtRate(source.bitRate) }}</span></p>
        <p class="sc-foot"><span class="dot"></span>{{ source.container }}<span class="ok">✓</span></p>
      </div>
    </div>

    <div class="tech">
      <div v-if="vstream" class="tcard">
        <h3>视频</h3>
        <dl>
          <template v-for="row in [
            ['标题', vstream.displayTitle || vstream.title],
            ['分辨率', fmtRes(vstream)],
            ['帧率', fmtFps(vstream.fps)],
            ['编码', vstream.codec?.toUpperCase()],
            ['配置', vstream.profile],
            ['位深', vstream.bitDepth ? vstream.bitDepth + ' 位' : ''],
            ['色度', vstream.chroma],
          ] as Array<[string, string]>" :key="row[0]">
            <template v-if="row[1]"><dt>{{ row[0] }}</dt><dd>{{ row[1] }}</dd></template>
          </template>
        </dl>
      </div>
      <div v-if="astream" class="tcard">
        <h3>音频</h3>
        <dl>
          <template v-for="row in [
            ['标题', astream.title || astream.displayTitle],
            ['语言', langName(astream.lang) || '无语言'],
            ['编码', astream.codec?.toUpperCase()],
            ['配置', astream.profile],
            ['声道数', astream.channels ? String(astream.channels) : ''],
            ['声道布局', fmtLayout(astream.channelLayout)],
            ['码率', fmtRate(astream.bitRate)],
            ['采样率', fmtHz(astream.sampleRate)],
          ] as Array<[string, string]>" :key="row[0]">
            <template v-if="row[1]"><dt>{{ row[0] }}</dt><dd>{{ row[1] }}</dd></template>
          </template>
        </dl>
      </div>
      <div v-if="source.audio.length > 1 || subLabels.length" class="tcard wide">
        <h3>轨道</h3>
        <dl>
          <template v-if="source.audio.length > 1"><dt>音轨</dt><dd>共 {{ source.audio.length }} 条</dd></template>
          <template v-if="subLabels.length"><dt>字幕</dt><dd>{{ subLabels.join(' / ') }}</dd></template>
        </dl>
      </div>
    </div>

    <p v-if="file || added" class="foot">
      <span v-if="file" class="file" :title="file">文件名　{{ file }}</span>
      <span v-if="added" class="added">入库时间　{{ added }}</span>
    </p>
  </div>
</template>

<style scoped>
/* The band's width is the parent's business — inline it is the content column, in the popup it is the
   dialog — so nothing here fixes a width beyond the flex basis the two columns share. */
.src { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 16px; }
/* The reference this block was laid out against opens with a row of version cards, one per server. This
   page answers one version — measured 66/66 files carry exactly one MediaSource — so that row is one strip
   across the band: a 210px box on the left leaves 900px of nothing beside it, and the eye reads the void as
   a card that failed to load. */
.srccard {
  flex: 1 1 380px;
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 50px;
  padding: 0 18px;
  border-radius: var(--radius);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
}
.sc-top { margin: 0; font-size: 15px; font-weight: 700; color: var(--text); }
.sc-meta { margin: 0; display: flex; gap: 14px; font-size: 13px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.sc-foot { margin: 0 0 0 auto; display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; color: var(--text); }
.sc-foot .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fbf7f; }
.sc-foot .ok { margin-left: 6px; color: #3fbf7f; }

/* Two codec cards side by side, then the track list across the whole band. The 380px basis is what makes
   the pair stack instead of squeezing once the column drops below ~800px, and `flex-start` is what keeps
   the shorter card honest: a 1080p file with no chroma line asks 视频 for 6 rows while 音频 still carries 9,
   and stretched to match the taller one the short card spent those three rows as blank inside its own
   border — which reads as a field that failed to arrive, not as a file that has fewer of them. */
.tech { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.tcard {
  flex: 1 1 380px;
  padding: 14px 18px 16px;
  border-radius: var(--radius);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
}
/* Eleven subtitle labels inside a 400px column wrapped onto three lines while the card beside it finished a
   third of its height early — and the list describes the file, not either stream. */
.tcard.wide { flex: 1 1 100%; }
.tcard h3 { margin: 0 0 10px; font-size: 14px; font-weight: 650; color: var(--text); }
.tcard dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 6px 18px; }
.tcard dt { font-size: 13px; color: var(--text-dim); }
.tcard dd { margin: 0; font-size: 13px; font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
/* A wrapped value reads as another row at 6px of leading, because the label column is four characters wide
   and the eye lands on the break rather than on the hanging indent. */
.tcard.wide dd { line-height: 1.8; }

/* The block ends on two lines about the file itself: which release it is, and when the server took it in.
   The name is the longer of the two and takes the flexible half, so the date never moves. */
.foot { display: flex; align-items: baseline; gap: 18px; margin: 16px 0 0; font-size: 13px; color: var(--text-dim); }
.file { flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.added { flex: none; }
</style>
