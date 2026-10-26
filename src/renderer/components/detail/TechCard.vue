<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { enName, fmtDateTime, langName, zhTrackWords } from '../../lib/format';
import type { LibraryItem, MediaStreamInfo } from '../../../shared/types';

/** One file's technical sheet: the version strip, the video card, every audio track, the subtitle list,
 *  and the date the server took the file in. It takes the row rather than an id because the row is what
 *  carries `sources` — and only the item endpoint ever fills that field (measured 2026-10-22: the season
 *  listing answers zero MediaSources on an Episode row).
 *
 *  The same component serves both places it can appear: inline under the hero on a page that has no episode
 *  row (a movie, a single video), and inside the popup a 分集 card's corner button opens.
 *
 *  Who owns which number: a version strip answers 「this file」 (its own name, size, bitrate, container,
 *  where it lives), the video card answers 「this stream」, and the audio list answers 「every track in
 *  it」 — one row each, because measured 2026-10-26 on 468 files, 107 of them hold more than one audio
 *  track and in 52 of those the hidden ones are a different language. A reader picking a dub cannot do
 *  that from 「共 5 条」. */
const props = defineProps<{ item: LibraryItem | null }>();

const sources = computed(() => props.item?.sources || []);
/** Which of the file's versions the video card, the audio list and the subtitle list below are answering
 *  for. `0` is where it starts because that is the file the player loads when nothing else is asked for;
 *  the strips are buttons from there, because measured 2026-10-26 on 444 files, 6 of them carry a second
 *  version (挽救计划 2160p/29.72 GB beside 1080p/5.09 GB) whose own tracks are the reason it exists. */
const picked = ref(0);
const at = computed(() => Math.min(picked.value, sources.value.length - 1));
/** With one version there is nothing to switch, so the strip is not a tab bar: no button, no cursor, and
 *  no selected tint painted on a card that has no rival to be selected over. */
const multi = computed(() => sources.value.length > 1);
const described = computed(() => sources.value[at.value]);
/* A new item is a new question: the second version of one file must not stay selected while the reader
   opens another, whose strips may not even be two. */
watch(() => props.item?.id, () => { picked.value = 0; });
const vstream = computed(() => described.value?.video);

/** What the server used to tell two tracks of one language apart, in the reader's own language. The titles
 *  on these files are English even when everything else on the page is Chinese — 「中文（Chinese
 *  Simplified） / 中文（Chinese Traditional）」 said 简体 and 繁体 in two scripts to make one point — and a
 *  title that carries brackets of its own would print a second pair inside the ones added below. So they
 *  come off, and with them the words: `Dansk (Danmark)` is 丹麦语（Dansk）, and 322 of the 1,980 stream
 *  titles sampled here are that shape — the bracket restating the language in its own country.
 *  `keep` puts the words back for the one case that earns it: a track the plain version would name exactly
 *  like its sibling. 阿甘正传 is that file — 「简体中文-SRT_(导演评论)字幕」 and 「…_(监制评论)字幕」 both
 *  stripped to 「简体中文-SRT_ 字幕」, so two of its nine subtitle tracks became one label and a dangling
 *  underscore was all the difference left behind. What is left of nothing is the codec, when the caller
 *  says the tracks beside this one differ by format. */
const discName = (s: MediaStreamInfo, keep: boolean, codecFallback = true): string => {
  const t = s.title || '';
  if (/simplified|chs\b/i.test(t)) return '简体';
  if (/traditional|cht\b/i.test(t)) return '繁体';
  if (/sdh|hearing/i.test(t)) return 'SDH';
  if (/forced/i.test(t)) return '强制';
  return t.replace(/[(（]([^)）]*)[)）]/g, keep ? '$1' : ' ').replace(/\s+/g, ' ').trim()
    || (codecFallback ? s.codec?.toUpperCase() || '' : '');
};
/** Codec and profile on one token. The two fields overlap by design — `Profile` qualifies a codec rather
 *  than naming a second thing — so joining them printed 「DTS DTS」 on every dts track whose profile the
 *  server spells out as `DTS`, and 「AAC HE-AAC」 where HE-AAC *is* the codec. When the profile already
 *  contains the codec name, the profile alone is the whole answer. */
const codecLabel = (a: MediaStreamInfo): string => {
  const c = (a.codec || '').toUpperCase().replace(/[̀-ͯ]/g, '');
  const p = a.profile || '';
  if (c && p && p.toUpperCase().replace(/[^A-Z0-9]/g, '').includes(c)) return p;
  return [a.codec?.toUpperCase(), p].filter(Boolean).join(' ');
};
/** Every audio track, one line each: the numbers a reader compares, then the server's own words for it.
 *  One line, not two, because the card is the wide one — 视频 beside it only needs the width of its own
 *  values, and giving the slack to the track list is what keeps ten tracks scannable as a list instead of
 *  as a block of text.
 *  `title` rides at the end because it is the only field that separates 德加拉国配 from 央视国配 — those
 *  two tracks of 阿甘正传 agree on language, codec, layout, bitrate and sample rate, so anything else
 *  printed twice over would read as one track listed twice. */
const audioRows = computed(() =>
  (described.value?.audio || []).map(a => {
    const nums = [
      langName(a.lang) || '无语言',
      codecLabel(a),
      fmtLayout(a.channelLayout) || (a.channels ? `${a.channels} 声道` : ''),
      fmtRate(a.bitRate),
      fmtHz(a.sampleRate),
    ].filter(Boolean).join(' · ');
    return { nums, name: audioName(a, nums), isDefault: !!a.isDefault };
  }),
);
/** The server's own words for a track, in the reader's language: `zhTrackWords` drops every part that
 *  restates the language the row already heads (in English, in the language's own spelling, or in
 *  Chinese) and turns what qualifies it (a region, SDH, a commentary credit) into Chinese. What comes
 *  back empty said nothing the heading does not say. */
const DEFAULT_MARK = /[（(]\s*(?:默认|default)\s*[)）]/i;
const trackName = (s: MediaStreamInfo): string => {
  const t = (s.title || s.displayTitle || '').replace(DEFAULT_MARK, '').replace(/\s{2,}/g, ' ').trim();
  return zhTrackWords(t, s.lang || '', false);
};
/** A name that only re-says the numbers beside it is not a second fact. 「FLAC stereo」 sits over
 *  「FLAC · 立体声 · 48 kHz」 and 「English-DTS_5.1」 over 「英语 · DTS · 5.1 · 1.5 Mbps · 48 kHz」 — the
 *  server's own title, spelled in English, for a row that already spells it out. So the tail goes only when
 *  every alphanumeric token of it is something the row's own fields can say (codec, profile, layout, the
 *  language in either of its spellings, or a number already printed); one token the fields cannot say —
 *  德加拉国配, DD, キャストコメンタリー — keeps the whole name, because that is the token worth reading.
 *  CJK carries no [a-z0-9] tokens, so a Chinese-only name can never be judged an echo by accident. */
const audioName = (a: MediaStreamInfo, nums: string): string => {
  const t = trackName(a);
  if (!t) return '';
  const known = [a.codec, a.profile, a.channelLayout, a.lang, langName(a.lang), enName(a.lang), nums]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const tokens = t.toLowerCase().match(/[a-z0-9]+/g) || [];
  return tokens.length && tokens.every(k => known.includes(k)) ? '' : t;
};
/** Subtitles, clustered one per language. Two tracks of one file share a language code on 36 of 40 files
 *  here — 简体 and 繁体 both come back `chi` — so a join of the codes alone printed 「chi / chi」 and told
 *  the reader nothing; whatever the server used to separate the tracks has to ride along.
 *
 *  The language heads its cluster and the variants follow it, because printing the language once per
 *  variant made 阿甘正传's card nine repetitions of 「中文（…）」 before the part that differed. The
 *  clusters flow rather than stacking one per line: these files average nine subtitle tracks each (3,047
 *  over 335), so a line per language would spend the height of the audio list to say the same thing.
 *
 *  Tracks that come out identical in every field the gateway reports are then one variant with a `×N` on
 *  it: merging them silently was the old behaviour and it lied by omission — measured 2026-10-26, 315
 *  subtitle tracks over 169 files disappeared this way (星球大战：曼达洛人与古古 6 tracks → 3 labels) with
 *  no count beside them to notice against. */
const ZH_SPLIT = /^(中文)（(简|繁)）$/;
const subGroups = computed(() => {
  const subs = described.value?.subtitle || [];
  const full = subs.map(s => langName(s.lang) || '无语言');
  // A code that names a script of Chinese is one language with a qualifier, not a second language: 挽救计划's
  // `chi` tracks head 中文 and its `zh-cn` sidecar headed 中文（简）, so one subtitle family appeared under
  // two headings two words apart. The script moves down into the variant, where the server's own 「简体」
  // titles already live.
  const heads = full.map(f => ZH_SPLIT.exec(f)?.[1] || f);
  // Whether a track's codec is worth printing is a fact about its cluster, not about the track: 阿甘正传's
  // Dolby Vision file has 30 subtitle tracks and every one is pgssub, so 30 PGSSUB tokens said nothing,
  // while a file holding an SRT and an ASS track of one language needs both words. The clusters therefore
  // settle before any label is cut.
  const codecs = new Map<string, Set<string>>();
  subs.forEach((s, i) => {
    let cs = codecs.get(heads[i]);
    if (!cs) codecs.set(heads[i], (cs = new Set()));
    cs.add((s.codec || '').toUpperCase());
  });
  const shared = subs.map((_, i) => (codecs.get(heads[i])?.size || 0) > 1);
  const bare = subs.map((s, i) => discName(s, false, shared[i]));
  const byLang = new Map<string, string[]>();
  for (const [i, s] of subs.entries()) {
    const lang = heads[i];
    const split = ZH_SPLIT.exec(full[i]);
    const twin = subs.some((o, j) => j !== i && (o.lang || '') === (s.lang || '') && bare[j] === bare[i]);
    const label0 = twin ? discName(s, true, shared[i]) : bare[i];
    let label = zhTrackWords(label0, s.lang || '', shared[i]);
    if (split) {
      const script = split[2] === '简' ? '简体' : '繁体';
      // The head already says 中文, so a title that says it again loses that half — 「简体中文」 under a
      // 中文 heading is 简体 and nothing else. One that adds something (简体中文-SRT_导演评论) keeps it.
      label = label.replace(/^中文/, '').replace(/^(简体|繁体)中文$/, '$1');
      if (!label) label = script;
      else if (!label.startsWith(script) && !/simplified|traditional/i.test(label)) label = `${script} ${label}`;
    }
    // The two states a reader acts on: a subtitle that is not inside the file, and one mpv will switch on
    // by itself. `isForced` is the server's word for the second, so the title regex above is only the
    // fallback for files that spell it out instead.
    const extra = [s.isExternal ? '外挂' : '', s.isForced && !/强制|forced/i.test(label) ? '强制' : ''].filter(Boolean).join(' ');
    const key = [label, extra].filter(Boolean).join(' ');
    const list = byLang.get(lang) || [];
    byLang.set(lang, list);
    list.push(key);
  }
  return [...byLang.entries()].map(([lang, list]) => {
    const merged = new Map<string, number>();
    for (const k of list) merged.set(k, (merged.get(k) || 0) + 1);
    const entries = [...merged.entries()];
    // One shape: the count goes on the language when there is nothing else to say (three plain 韩语 tracks
    // are 韩语×3, and 「韩语 普通×3」 would be three words for one fact). A named shape keeps its name and
    // carries the count on itself — SDH×2 is two tracks of one kind, not two kinds of one track.
    if (entries.length === 1) {
      const [key, count] = entries[0];
      if (!key) return { lang: count > 1 ? `${lang}×${count}` : lang, vars: [] };
      return { lang, vars: [count > 1 ? `${key}×${count}` : key] };
    }
    // Two shapes or more, and an empty key is a track in its own right: the plain one — not SDH, not
    // forced, not an external file. Naming it 普通 is what keeps 爱的迫降's 32 条 on screen as 32: 韩语,
    // 葡萄牙语 and 西班牙语 each hide such a track beside a labelled sibling, and a list that prints 29
    // names under a heading of 32 is the same lie by omission the `×N` was added for.
    return { lang, vars: entries.map(([k, m]) => `${k || '普通'}${m > 1 ? `×${m}` : ''}`) };
  });
});
const subTotal = computed(() => described.value?.subtitle?.length || 0);
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
/** Where the bytes actually are. The green dot and the ✓ this row used to carry were constants — painted
 *  on all 444 sampled files, including the one `strm` entry that has no file behind it — so they said
 *  nothing. `Protocol` is the server's own answer: File on 474 of 474 sources here, Http on a referral. */
const WHERE: Record<string, string> = { File: '服务器文件', Http: '网络地址' };
const where = (p?: string): string => (!p ? '' : WHERE[p] || p);
/** Each version strip answers 「this file」 with its own name when the name is a label: 挽救计划's two are
 *  literally 「2160p」 and 「1080p」. Where the server put the whole filename there instead — 僵尸世界大战
 *  carries 「僵尸世界大战 (2013) - 2160p」 on both of its versions — it restates the page headline and,
 *  twice over, restates the card beside it, so those strips fall back to the dynamic range: the one file
 *  fact no card below repeats. */
const versionName = (name?: string): string => {
  const t = props.item?.name || '';
  return name && name.length <= 12 && !t.includes(name) ? name : '';
};
</script>

<template>
  <div v-if="sources.length" class="sheet">
    <!-- One strip per version of the file, and with two of them the strips are also the switch: the three
         cards below answer for the picked version only, so a second version's tracks would otherwise hide
         behind the first one's. A lone strip has nothing to switch to and stays a plain box. -->
    <div class="src" :class="{ multi }">
      <component
        :is="multi ? 'button' : 'div'"
        v-for="(s, i) in sources"
        :key="s.id"
        class="srccard"
        :class="{ solo: !multi, on: multi && i === at }"
        :type="multi ? 'button' : undefined"
        :aria-pressed="multi ? i === at : undefined"
        @click="picked = i"
      >
        <div class="sc-main">
          <p class="sc-top">{{ versionName(s.name) || s.video?.range || 'SDR' }}</p>
          <p class="sc-meta">
            <span>{{ fmtSize(s.sizeBytes) }}</span>
            <span>{{ fmtRate(s.bitRate) }}</span>
            <span>{{ s.container }}</span>
            <span>{{ where(s.protocol) }}</span>
          </p>
        </div>
      </component>
    </div>

    <div class="tech">
      <div v-if="vstream" class="tcard vid">
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
      <div v-if="audioRows.length" class="tcard aud">
        <h3>音频<span v-if="audioRows.length > 1" class="cnt">{{ audioRows.length }} 条</span></h3>
        <ul class="tracks">
          <li v-for="(a, i) in audioRows" :key="i" class="trk" :class="{ def: a.isDefault }">
            <p class="tk">{{ a.nums }}<span v-if="a.name" class="tk-name">{{ a.name }}</span><span v-if="a.isDefault" class="tk-tag">默认</span></p>
          </li>
        </ul>
      </div>
      <div v-if="subGroups.length" class="tcard wide">
        <h3>字幕<span v-if="subTotal > 1" class="cnt">{{ subTotal }} 条</span></h3>
        <p class="labs"><span v-for="g in subGroups" :key="g.lang" class="lg"><span class="lead"><b>{{ g.lang }}</b><span v-if="g.vars[0]" class="v" :class="{ tail: g.vars.length > 1 }">{{ g.vars[0] }}</span></span><span v-for="(v, j) in g.vars.slice(1)" :key="j" class="v" :class="{ tail: j < g.vars.length - 2 }">{{ v }}</span></span></p>
      </div>
    </div>

    <p v-if="added" class="foot"><span class="added">入库时间　{{ added }}</span></p>
  </div>
</template>

<style scoped>
/* The band's width is the parent's business — inline it is the content column, in the popup it is the
   dialog — so nothing here fixes a width beyond the flex basis the two columns share. */
.src { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 16px; }
/* One card per version. Until 2026-10-26 this row drew `sources[0]` alone on the measurement that every
   file carries exactly one — 6 of 444 do not, and the second was a different resolution. The basis keeps
   a lone version full width and lets two sit side by side at 836px of dialog, where each gets 411px. */
.srccard {
  flex: 1 1 380px;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 0 18px;
  border-radius: var(--radius);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
}
/* A lone version has nothing to switch to, so it stays a plain box. From two versions up the strip is a
   tab bar and the cards under it describe the picked one — the accent has to say which is on screen, and
   picking must not move anything: border colour and text colour only, never the 1px border's thickness. */
.srccard.solo { min-height: 44px; }
.srccard.solo .sc-main { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
.srccard.solo .sc-meta { margin: 0; }
button.srccard {
  margin: 0; font: inherit; color: inherit; text-align: left;
  cursor: pointer; transition: background-color 140ms ease, border-color 140ms ease;
}
.src.multi .srccard:hover { background: color-mix(in srgb, var(--text) 5%, var(--bg-elev)); }
.src.multi .srccard:focus-visible { outline: 2px solid color-mix(in srgb, var(--text) 55%, transparent); outline-offset: 2px; }
.srccard.on { background: color-mix(in srgb, var(--text) 9%, var(--bg-elev)); border-color: color-mix(in srgb, var(--text) 40%, var(--line)); }
/* The un-picked tabs keep the same boxes and lose only the brightness of their headline: with the card the
   reader is on named by a lit border, its neighbours recede without anything moving out from under them. */
.src.multi .srccard:not(.on) .sc-top { color: var(--text-dim); }
.sc-main { min-width: 0; }
.sc-top { margin: 0; font-size: 15px; font-weight: 700; color: var(--text); }
.sc-meta { margin: 2px 0 0; display: flex; gap: 14px; font-size: 13px; color: var(--text-dim); font-variant-numeric: tabular-nums; }

/* Two codec cards side by side, then the subtitle list across the whole band. `flex-start` is what keeps the
   shorter card honest: a file with one audio track asks 音频 for one line while 视频 still carries seven,
   and stretched to match the taller one the short card would spend those rows as blank inside its own
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
/* 视频 answers 「this stream」 with short values in two columns, so it takes the width of those values and
   hands the rest of the band to the track list, which is the card that has to hold ten rows of a reader's
   own comparisons side by side. The 380px basis is on 音频 rather than on the pair so a file with no audio
   card still lets 视频 sit at its own width across the full band. */
.tcard.vid { flex: 0 1 auto; min-width: 216px; }
.tcard.aud { flex: 1 1 380px; }
.tcard h3 { margin: 0 0 10px; font-size: 14px; font-weight: 650; color: var(--text); display: flex; align-items: baseline; gap: 8px; }
/* The count that names how many tracks the list below holds. It sits on the heading because it is a fact
   about the whole card, and a reader comparing two files reads the heading first. */
.tcard h3 .cnt { font-size: 13px; font-weight: 500; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.tcard dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 6px 18px; }
.tcard dt { font-size: 13px; color: var(--text-dim); }
.tcard dd { margin: 0; font-size: 13px; font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }

/* Every audio track, one entry each. The old card described one track in eight labelled rows and then
   printed 「共 5 条」 for the rest, which hid the two 国语 dubs of 阿甘正传 completely. */
.tracks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.trk { padding-left: 9px; border-left: 2px solid transparent; }
/* The default is marked rather than assumed: 18 of 474 sources carry no default at all and 27 carry more
   than one, so which track the player picks is not something this sheet can infer silently. */
.trk.def { border-left-color: color-mix(in srgb, var(--text) 34%, transparent); }
.tk {
  margin: 0; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  font-size: 13px; font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums;
}
.tk-tag { flex: none; padding: 0 6px; border-radius: 999px; background: var(--chip); color: var(--text-dim); font-size: 13px; font-weight: 500; }
/* The server's own words for the track — the only thing that separates 德加拉国配 from 央视国配. One step
   quieter than the numbers, because it is the field a reader compares only after the numbers match. */
.tk-name { font-weight: 500; color: var(--text-dim); overflow-wrap: anywhere; }

/* The list describes the file, not either stream, so it takes the whole band: eleven labels inside a 400px
   column wrapped onto three lines while the card beside it finished a third of its height early. */
.tcard.wide { flex: 1 1 100%; min-width: 0; }
.labs { margin: 0; font-size: 13px; line-height: 1.9; }
/* A cluster reads 「韩语 普通 / SDH / 强制」: the language is what a scanner of a 27-cluster list is looking
   for, so it carries the weight and the variants behind it step back. The old split was the other way round
   — borrowed from the 视频 rows, where the label is boilerplate and the value is the answer. Here the label
   is the answer and the variants are its qualifiers. */
.labs b { margin-right: 8px; color: var(--text); font-weight: 700; white-space: nowrap; }
/* One track, one box. A label that broke mid-word — 「简体中文-」 on one line and 「SRT_YYeTs字幕」 under
   it — reads as two tracks, which is the one thing this list exists to get right. */
.labs .v {
  display: inline-block; white-space: nowrap; vertical-align: bottom;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis;
  color: var(--text-dim); font-weight: 500;
}
/* A box with another one behind it closes on the slash, so a wrapped line ends on the divider instead of
   opening on one. Which boxes have a follower is the cluster's own arithmetic, so the template says it. */
.labs .v.tail::after { content: '/'; margin: 0 8px; font-weight: 400; }
/* The language and its first variant are one reading unit: without the glue, a cluster that wrapped left
   「葡萄牙语」 at the end of a line and its two names at the start of the next, which reads as those names
   belonging to whatever language the eye happened to land on. Flex, not just nowrap, so the pair is capped
   at the card's own width and a title long enough to pass it loses its tail to an ellipsis instead of
   pushing the sheet sideways. */
.labs .lead { display: inline-flex; align-items: baseline; vertical-align: bottom; max-width: 100%; white-space: nowrap; }
.labs .lead .v { min-width: 0; }
/* Clusters are separated by the gap between them, not by a bar: at 32 subtitle tracks a row of pipes turned
   the list into a fence. The space keeps the break opportunity the bar used to supply — without it the
   longest cluster would run past the card. */
.labs .lg + .lg::before { content: ' '; }
.labs .lg + .lg { margin-left: 16px; }

/* The block ends on the one line about the file that no other surface answers: when the server took it in.
   Which release this is moved up into the version strip, where each version can say it for itself. */
.foot { display: flex; justify-content: flex-end; gap: 18px; margin: 16px 0 0; font-size: 13px; color: var(--text-dim); }
.added { flex: none; font-variant-numeric: tabular-nums; }
</style>
