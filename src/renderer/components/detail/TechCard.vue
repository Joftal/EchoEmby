<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { codecLabel, enName, fmtDateTime, fmtRate, fmtRuntime, fmtSize, formatWord, langName, layoutWord, NO_LANG, openBrackets, rangeWord, zhTrackWords } from '../../lib/format';
import { versionLabel, versionNames } from '../../../shared/version-label';
import { pickTracks, type TrackPick } from '../../../shared/track-pick';
import { useAppStore } from '../../stores/app';
import { hasContent, type LibraryItem, type MediaStreamInfo } from '../../../shared/types';

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
/* The version this page already pointed at, when it has one: the popup is `v-if`, so closing it destroys
   this component and reopening it starts at 0 — while the page still holds the pick and 播放 would load the
   second file under a card showing the first pressed. The page owns the answer, so it passes it in. */
const props = defineProps<{ item: LibraryItem | null; wanted?: string; using?: string }>();
/** The file the player actually has open, which is a different fact from `wanted`: that one is the version
 *  this page would hand the player, this one is the version it already has. Two versions of one film differ
 *  by nothing on the strip but a range word, so without this the reader who walked in from 播放 cannot tell
 *  which of the two files the picture is coming out of — and after pressing the other card, whether the
 *  press took. Only one strip can ever say it; the page mirrors the session event to say which. */
const live = (id: string): boolean => !!props.using && id === props.using;
/** The pick is not only this card's business: 播放 on this page has to load the version the reader was
 *  reading, so the page keeps the id and hands it to the player when playback starts. */
const emit = defineEmits<{ pick: [itemId: string, sourceId: string] }>();

/** The file's versions, in the order the card shows them: the ones that hold a stream first, in the order
 *  the server listed them, and the rows that hold none sunk to the end. 133 of the 23,027 sources measured
 *  2026-10-27 carry no `MediaStreams` at all — a `.strm` or `.iso` path the gateway can see and cannot
 *  probe, 132 of them reporting `Size` 0 — and asking the server to stream one answers HTTP 500. They are
 *  listed because the server says the file has them and hiding a row would make the count a lie; they are
 *  last and unpressable because there is nothing in them to read or to play. */
const sources = computed(() => {
  const list = props.item?.sources || [];
  return [...list.filter(s => hasContent(s)), ...list.filter(s => !hasContent(s))];
});
/** Which of the file's versions the video card, the audio list and the subtitle list below are answering
 *  for. `0` is where it starts because that is the file the player loads when nothing else is asked for;
 *  the strips are buttons from there, because measured 2026-10-26 on 444 files, 6 of them carry a second
 *  version (挽救计划 2160p/29.72 GB beside 1080p/5.09 GB) whose own tracks are the reason it exists. */
const wantedIndex = (): number => {
  const i = props.wanted ? sources.value.findIndex(s => s.id === props.wanted) : -1;
  return i > 0 ? i : 0;
};
const picked = ref(wantedIndex());
const at = computed(() => Math.min(picked.value, sources.value.length - 1));
/** With one version there is nothing to switch, so the strip is not a tab bar: no button, no cursor, and
 *  no selected tint painted on a card that has no rival to be selected over. */
const multi = computed(() => sources.value.length > 1);
const described = computed(() => sources.value[at.value]);
/* A new item is a new question: the second version of one file must not stay selected while the reader
   opens another, whose strips may not even be two. And the page's answer can arrive after this card has
   already painted — the version the controller holds comes back over IPC, so `wanted` moves from nothing to
   an id under the same item. Both re-seat the strip; a click here writes that same id back out, so the
   watcher can never fight the reader. */
watch(() => [props.item?.id, props.wanted], () => { picked.value = wantedIndex(); });
const pick = (i: number): void => {
  const s = sources.value[i];
  // A row with nothing in it describes nothing and plays nothing, so it is not a pick. The page keeps
  // whatever was pressed last, which is the version 播放 will load.
  if (!s || !hasContent(s)) return;
  picked.value = i;
  if (props.item) emit('pick', props.item.id, s.id);
};
const vstream = computed(() => described.value?.video);
/** Which track the 首选语言 settings would open this version on, answered by the picker the player itself
 *  runs (`pickTracks`) rather than by a second opinion written here: a card that guessed differently from
 *  the player would be worse than a card that said nothing. The card can only say it, not do it — pressing a
 *  version strip re-runs the same picker in the controller.
 *
 *  Both lists belong to the version being described, so pressing the other strip re-answers them: 霸王别姬's
 *  2160p opens on 原版国语 TrueHD and its 1080p on a flac, and one TL;DR mark carried across the switch would
 *  name a track the other file does not have. */
const app = useAppStore();
const prefs = computed(() => app.config?.settings.player);
const planned = computed<TrackPick>(() => {
  const src = described.value;
  if (!src) return {};
  return pickTracks({ audio: src.audio || [], subtitle: src.subtitle || [] }, { audioLang: prefs.value?.audioLang, subLang: prefs.value?.subLang });
});
/** The two answers as stream indexes, which is what the rows below carry. `-1` is 「nothing was picked」 —
 *  no preference set, or a preference this file has no track for — and it is the state the card draws
 *  nothing for, because the file's own default still decides and the 默认 tag already says which that is. */
const audPick = computed(() => planned.value.audio?.index ?? -1);
const subPick = computed(() => (typeof planned.value.subtitle === 'string' ? -1 : planned.value.subtitle?.index ?? -1));
const subOff = computed(() => planned.value.subtitle === 'off');
/** Which subtitle track the card frames, preference or not: the picker's answer when the preference found a
 *  track, and otherwise the file's own single default — the row mpv would switch on for a file nobody has
 *  an opinion about. `-1` is 「nothing to frame」: 关闭字幕, or a file that marks no single default, where
 *  the choice is left to the player and a frame would be this card guessing. */
const subShown = computed(() => {
  if (subOff.value) return -1;
  if (subPick.value >= 0) return subPick.value;
  const list = described.value?.subtitle || [];
  const def = onlyDefault(list);
  return def >= 0 ? list[def].index ?? -1 : -1;
});

/** What the server used to tell two tracks of one language apart, opened up for the pass that translates
 *  it — see `openBrackets`, which the player's subtitle menu reads through the same pass so the two
 *  surfaces cannot name one track with two sets of words. What is left of nothing here is the codec, when
 *  the caller says the tracks beside this one differ by format. */
const discName = (s: MediaStreamInfo, keepFormats: boolean): string =>
  openBrackets(s.title || '') || (keepFormats ? s.codec?.toUpperCase() || '' : '');
/** The card's own codec word, shared with the player's audio menu through `format.ts` — see `codecLabel`. */
const codecWord = (a: MediaStreamInfo): string => codecLabel(a.codec, a.profile);
/** Every audio track, one line each: the numbers a reader compares, then the server's own words for it.
 *  One line, not two, because the card is the wide one — 视频 beside it only needs the width of its own
 *  values, and giving the slack to the track list is what keeps ten tracks scannable as a list instead of
 *  as a block of text.
 *  `title` rides at the end because it is the only field that separates 德加拉国配 from 央视国配 — those
 *  two tracks of 阿甘正传 agree on language, codec, layout, bitrate and sample rate, so anything else
 *  printed twice over would read as one track listed twice.
 *  默认 is printed only where the file marks one track that way: measured 2026-10-27 over 23,027 sources,
 *  21,178 mark exactly one and 819 mark two or more — up to 29 of them — so on those cards the badge was
 *  not naming the track the player picks, it was naming a third of the list. */
const onlyDefault = <T extends { isDefault?: boolean }>(list: T[]): number => {
  const hits = list.filter(x => x.isDefault);
  return hits.length === 1 ? list.indexOf(hits[0]) : -1;
};
const audioRows = computed(() => {
  const list = described.value?.audio || [];
  const def = onlyDefault(list);
  /* The row the frame goes on: the preference's own pick when it found one, and otherwise the file's single
     default — the same fallback the subtitle list makes, so 「which one will I hear」 has an answer on every
     file rather than only on the ones a preference happens to cover. A file marking no default at all (18 of
     474 sources) is the one case with no frame: there the player's own first-track rule decides, and the
     card says nothing rather than guessing at it. */
  const frameAt = audPick.value >= 0
    ? list.findIndex(a => a.index === audPick.value)
    : def >= 0 ? def : -1;
  const rows = list.map((a, i) => {
    const nums = [
      langName(a.lang) || NO_LANG,
      codecWord(a),
      layoutWord(a.channelLayout) || (a.channels ? `${a.channels} 声道` : ''),
      fmtRate(a.bitRate),
      fmtHz(a.sampleRate),
      // 位深, spelled the one way the 视频 card spells it. Measured 2026-10-27 over 32,770 audio rows:
      // the server names it on 3,623 (2,713 of them 24), and on 20 of those the release wrote the number
      // into the title as 「24-bit」 — which the card had no slot for, so the digits dropped, the unit
      // stayed and the row read 「bit」 in Latin letters beside a Chinese line.
      a.bitDepth ? `${a.bitDepth} 位` : '',
    ].filter(Boolean).join(' · ');
    return { nums, name: audioName(a, nums), isDefault: i === def, idx: a.index, pick: i === frameAt };
  });
  /* Two rows that come out word for word the same are two tracks the gateway reports no field apart.
     Measured 2026-10-27 over 23,027 sources: 231 files hold 550 such rows, 18 of them three or more alike,
     and only 38 of the groups differ in any real field. The list does not merge them — both print — so the
     sign a reader needs is that they are two: the row's own position, on the colliding ones only. An
     ordinal on every row would be a number nobody asks for. */
  const count = new Map<string, number>();
  for (const r of rows) {
    const id = `${r.nums} ${r.name}`;
    count.set(id, (count.get(id) || 0) + 1);
  }
  return rows.map((r, i) => ({ ...r, ord: (count.get(`${r.nums} ${r.name}`) || 0) > 1 ? `第 ${i + 1} 条` : '' }));
});
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
  const defSub = onlyDefault(subs);
  const full = subs.map(s => langName(s.lang) || NO_LANG);
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
  const bare = subs.map((s, i) => discName(s, shared[i]));
  /** One row's chip: the server's own words through the translation pass, then the facts the cluster
   *  settled. `keepRegions` is the one question a row cannot answer alone — see the lift below. */
  const keyOf = (i: number, keepRegions: boolean): { lang: string; key: string } => {
    const s = subs[i];
    const split = ZH_SPLIT.exec(full[i]);
    let label = zhTrackWords(bare[i], s.lang || '', shared[i], keepRegions);
    if (split) {
      const script = split[2] === '简' ? '简体' : '繁体';
      // The head already says 中文, so a title that says it again loses that half — 「简体中文」 under a
      // 中文 heading is 简体 and nothing else. One that adds something (简体中文-SRT_导演评论) keeps it.
      label = label.replace(/^中文/, '').replace(/^(简体|繁体)中文$/, '$1');
      if (!label) label = script;
      else if (!label.startsWith(script) && !/simplified|traditional/i.test(label)) label = `${script} ${label}`;
    }
    // `keepFormats` only preserves a format word the title already carries, and 乐园之夜's two 简体 tracks
    // are 「Simplified Chinese (简体中文)」 in ASS and the same words again in SUBRIP — titles that name no
    // format at all — so the cluster mixed containers, there was nothing to keep, and the pair printed as
    // one 「简体×2」. Where the cluster disagrees on the container and the label does not already say it, the
    // container is the whole difference between the two tracks and rides along: measured 2026-10-27 over
    // 131,741 subtitle tracks in 23,027 sources, that put the chip count at 53,708 → 55,803, and a pair
    // still sharing a label after it is the case the lift below is there to catch.
    const fmt = formatWord(s.codec);
    if (shared[i] && fmt && !label.toUpperCase().includes(fmt)) label = [label, fmt].filter(Boolean).join(' ');
    // The states a reader acts on: a subtitle that is not inside the file, one mpv will switch on by
    // itself, the one the server points at when nothing has been picked, and one written for viewers who
    // cannot hear the track — `isForced` is the server's word for the second, so the title regex above is
    // only the fallback for files that spell it out instead. The third was the field the card never read:
    // measured 2026-10-27, 10,433 of 23,027 sources mark exactly one subtitle row that way, and it joins
    // the merge key rather than only the printed chip, because two rows whose labels the translation pass
    // folds together are still two different tracks. The fourth is the only route to 听障 for 440 of the
    // 1,817 rows the server flags: their own `Title` says nothing of it and the word sits in
    // `DisplayTitle`, which no card reads — so 左撇子女孩 printed one 「听障」 over a row the server does
    // not flag and hid the row it does under 「普通×2」.
    const extra = [
      // 外挂 says where the bytes sit, and for three rows it has to say which kind: measured 2026-10-27
      // on the 784 sidecar subtitle rows in both corpora, 781 are text (srt 397, ass 376, ssa 8) and 3 are
      // pictures (复活她 idx5, 酷儿 idx7, 战·争 idx5 — all `.sup`). The player's own menu filters those out
      // because mpv decodes a bitmap only inside a container, so a bare 外挂 on one of the three names a
      // track the menu will not offer and clicking the file cannot deliver.
      s.isExternal ? (s.isTextSubtitle === false ? '外挂（图片）' : '外挂') : '',
      s.isForced && !/强制|forced/i.test(label) ? '强制' : '',
      s.isHearingImpaired && !/听障|sdh/i.test(label) ? '听障' : '',
      i === defSub ? '默认' : '',
    ].filter(Boolean).join(' ');
    return { lang: heads[i], key: [label, extra].filter(Boolean).join(' ') };
  };
  const cut = subs.map((_, i) => keyOf(i, false));
  // A region whose name is the head's own prefix — 西班牙语 starts with 西班牙, 葡萄牙语 with 葡萄牙 — is
  // what the pass drops, on the reading that the heading already said it. Usually true, and the reason a
  // lone 「Dansk (Danmark)」 row is not printed as 丹麦语 丹麦. But it is the only word some rows have: of
  // the 1,049 clusters measured 2026-10-27 over 23,027 sources whose rows differ in the title yet print as
  // one chip, this lift separates 191 — 162 by exactly this region word, 28 by the 默认 flag that joins the
  // key above — and 858 still fold. Read pair by pair against what a reader picks between, those 858 are
  // 792 that spell one script two ways around a chip already printing it (「Simplified Chinese (简体中文)」
  // against 「Simplified」), 315 whose chip already says 听障 — 301 of them merged by the flag itself, two
  // rows the gateway states the same fact about in two places — 50 where the words differ and nothing else
  // does, and 2 that still cost the choice: 「mp4.繁英」 against 「mp4.简英」 on a 无语言 row, where no
  // language word exists for the dictionary to hang a script on, and a 「英语听障字幕」 that the pass blanks
  // whole, so the pair prints 普通×2 over a track that named itself SDH. The gateway reports no field apart
  // between the rows of all but one of them, so what a fold costs is words — and the 19 that hid a real
  // 简体/繁体 choice in the bare order 中文简体 are no longer among them, because the dictionary has that
  // entry now.
  const lift = new Set<string>();
  const saidOnce = new Map<string, string>();
  cut.forEach((c, i) => {
    const id = `${c.lang} ${c.key}`;
    const raw = (subs[i].title || '').trim();
    const prev = saidOnce.get(id);
    if (prev === undefined) saidOnce.set(id, raw);
    else if (prev !== raw) lift.add(c.lang);
  });
  const chips = lift.size ? subs.map((_, i) => keyOf(i, lift.has(heads[i]))) : cut;
  /** Which chip the 首选 language would land on. The mark has to travel with the key the chip was cut from,
   *  not with the words printed on it: two rows that fold into one label — and the `×N` that follows them —
   *  are still two tracks, and a reader comparing this card against the player's menu needs the one the
   *  player will really switch on. Resolved by stream index, the same address the picker answers with. */
  const pickKeys = new Set<string>();
  if (subShown.value >= 0) chips.forEach((c, i) => { if (subs[i].index === subShown.value) pickKeys.add(c.key); });
  const byLang = new Map<string, string[]>();
  for (const c of chips) {
    const list = byLang.get(c.lang) || [];
    byLang.set(c.lang, list);
    list.push(c.key);
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
      if (!key) return { lang: count > 1 ? `${lang}×${count}` : lang, vars: [], pickLang: pickKeys.has('') };
      return { lang, vars: [{ t: count > 1 ? `${key}×${count}` : key, pick: pickKeys.has(key) }], pickLang: false };
    }
    // Two shapes or more, and an empty key is a track in its own right: the plain one — not SDH, not
    // forced, not an external file. Naming it 普通 is what keeps 爱的迫降's 32 条 on screen as 32: 韩语,
    // 葡萄牙语 and 西班牙语 each hide such a track beside a labelled sibling, and a list that prints 29
    // names under a heading of 32 is the same lie by omission the `×N` was added for.
    return { lang, vars: entries.map(([k, m]) => ({ t: `${k || '普通'}${m > 1 ? `×${m}` : ''}`, pick: pickKeys.has(k) })), pickLang: false };
  });
});
const subTotal = computed(() => described.value?.subtitle?.length || 0);
const added = computed(() => (props.item?.dateCreated ? fmtDateTime(props.item.dateCreated) : ''));

/** A 3 MB 特别篇 file printed 「0.00 GB」 under a two-decimal GB rule, and 11 of the 14 files in one such
 *  season were under 10 MB — and the player's 播放源 popover spelled the same file differently again, so
 *  both surfaces read `fmtSize` and `fmtRate` out of lib/format now. */
const fmtRes = (v?: MediaStreamInfo): string => (v?.width && v?.height ? `${v.width}×${v.height}` : '');
/** 44100 and 48000 are the two readings worth comparing, but a bare number was the only value on this sheet
 *  carrying no unit. */
const fmtHz = (n?: number): string => (!n ? '' : `${+(n / 1000).toFixed(1)} kHz`);
const fmtFps = (n?: number): string => (!n ? '' : `${+n.toFixed(2)} fps`);

/** Where the bytes actually are. The green dot and the ✓ this row used to carry were constants — painted
 *  on all 444 sampled files, including the one `strm` entry that has no file behind it — so they said
 *  nothing. `Protocol` is the server's own answer: File on 474 of 474 sources here, Http on a referral. */
const WHERE: Record<string, string> = { File: '服务器文件', Http: '网络地址' };
const where = (p?: string): string => (!p ? '' : WHERE[p] || p);
/** A lone version's head, where the server's name is the only word that could name it. With rivals to
 *  compare against, the head comes from `versionLabel` instead — see that file for why a length cap cannot
 *  tell a filename from a label. Here nothing is being compared, so a name is only worth printing when it
 *  is short enough to be a label and is not the page headline said again: on 23,027 sources measured
 *  2026-10-27, 50 of the 1,418 strips that printed `Name` as the head are the headline with the year bolted
 *  on (「岳父大人 (2022)」), and a strip that re-reads the title above it says nothing a version switch
 *  could act on. The compare runs on the name with its bracketed tail cut off, because that is exactly the
 *  shape those 50 have. */
const versionName = (name?: string): string => {
  if (!name || name.length > 12) return '';
  const t = props.item?.name || '';
  return t.includes(name.replace(/[（(].*$/, '').trim()) ? '' : name;
};
/** What every version strip prints, worked out together because three of the values are facts about the set
 *  of versions rather than about one file.
 *
 *  With more than one version, the head is the shape word out of the server's own name — 挽救计划's two are
 *  literally 「2160p」 and 「1080p」, 哺乳动物星球 S01E01's are 「tv」 and 「mobile」 glued behind a 23-character
 *  filename — and the dynamic range only when the name holds no such word. A name is not asked to restate
 *  the headline here, because `versionLabel` cuts the headline out of it along with everything else that is
 *  not a shape.
 *
 *  The length is printed only where the versions disagree on it: one file's runtime is already on the page
 *  above this card, so a lone version saying it again is the same number twice, and two versions that agree
 *  say it twice each. Measured 2026-10-27, 8 of 479 items carry a second version and only 七武士's two cuts
 *  differ once the length is rounded to the minute the card prints — 3小时27分 against 3小时21分 — which is
 *  the whole reason to pick one of them over the other.
 *
 *  The track counts join the small line when two or more strips head with the same word. Two buttons that
 *  open on the same word read as the same file twice, and the file the reader is choosing between is not
 *  twice the same: 僵尸世界大战's two 「2160p」 differ by a subtitle track (4 against 3), 无职转生's two SDR
 *  rows by eight (12 against 4) — and those counts are the version's own, answered by no other line on the
 *  sheet, because the 音频 and 字幕 cards below describe the picked version only. Where the counts match too,
 *  the ordinal is what is left, and where nothing else differs it is the only word telling two buttons apart.
 *
 *  A source with no video stream has no range to print and no picture the 视频 card can describe, so the
 *  strip says that instead of falling through to 'SDR' — the one value the server never reported.
 *
 *  The range is the last thing the small line says whenever the big line is not already saying it. On the
 *  same 23,027 sources, 1,418 strips head with the server's own `Name`, and 1,414 of those were hiding a
 *  dynamic range the gateway had reported — 87 of them 杜比视界 or HDR10 — because the range only ever
 *  reached the strip as the fallback head, and 21,479 strips already head with it. A reader asking 「is
 *  this file HDR」 had no answer anywhere on the page. */
const strips = computed(() => {
  const list = sources.value;
  const runs = new Set(list.map(s => fmtRuntime(s.runTimeTicks)));
  const showRun = list.length > 1 && runs.size > 1;
  const rows = list.map(s => {
    const range = rangeWord(s.video?.range);
    const head = hasContent(s)
      ? (multi.value ? versionLabel(s.name) : versionName(s.name)) || range || (s.video ? '' : '无视频轨')
      : '无内容';
    const meta = [
      showRun ? fmtRuntime(s.runTimeTicks) : '',
      fmtSize(s.sizeBytes),
      fmtRate(s.bitRate),
      s.container || '',
      where(s.protocol),
      head === range ? '' : range,
    ].filter(Boolean);
    return { src: s, head, meta };
  });
  const same = new Map<string, number>();
  for (const r of rows) same.set(r.head, (same.get(r.head) || 0) + 1);
  /** Two versions whose names say no shape are two strips reading the same word — measured 2026-10-29 on
   *  无职转生 S03E09: both files are 1080p SDR 1.45 GB 8.2 Mbps and the only difference is 12 subtitle tracks
   *  against 4, which the strip already prints beside the size. What it did not print was a handle: the
   *  player's own 播放源 card calls those two files 版本 1 and 版本 2, so a reader who picked one here had no
   *  way to know which of the two that panel was calling 版本 2 — two surfaces, one file, two names. The
   *  number therefore comes from versionNames(), the same call the panel makes, and it is the server's own
   *  position rather than this list's: 133 of 23,027 sources carry no stream and sink to the end here, so
   *  counting rows would renumber a file the panel numbers by its place in the session. Only ties get the
   *  word — on 挽救计划's 2160p beside 1080p the head already says which is which. */
  const names = new Map((props.item?.sources || []).map((s, i) => [s.id, versionNames(props.item?.sources || [])[i]]));
  for (const r of rows) {
    if ((same.get(r.head) || 0) < 2 || !hasContent(r.src)) continue;
    r.meta.push(`音频 ${r.src.audio?.length || 0} 条`, `字幕 ${r.src.subtitle?.length || 0} 条`);
  }
  return rows.map(r => ({
    head: r.head,
    meta: r.meta,
    pressable: hasContent(r.src),
    ord: (same.get(r.head) || 0) > 1 && hasContent(r.src) ? /版本 \d+$/.exec(names.get(r.src.id) || '')?.[0] || '' : '',
  }));
});
</script>

<template>
  <div v-if="sources.length" class="sheet">
    <!-- One strip per version of the file, and with two of them the strips are also the switch: the three
         cards below answer for the picked version only, so a second version's tracks would otherwise hide
         behind the first one's. A lone strip has nothing to switch to and stays a plain box. -->
    <div class="src" :class="{ multi }">
      <component
        :is="multi && strips[i].pressable ? 'button' : 'div'"
        v-for="(s, i) in sources"
        :key="s.id"
        class="srccard"
        :class="{ solo: !multi, on: multi && i === at, live: live(s.id), inert: !strips[i].pressable }"
        :type="multi && strips[i].pressable ? 'button' : undefined"
        :aria-pressed="multi && strips[i].pressable ? i === at : undefined"
        @click="pick(i)"
      >
        <div class="sc-main">
          <p class="sc-top">{{ strips[i].head }}<span v-if="strips[i].ord" class="sc-ord">{{ strips[i].ord }}</span></p>
          <p class="sc-meta"><span v-for="(m, j) in strips[i].meta" :key="j">{{ m }}</span></p>
        </div>
      </component>
    </div>

    <div class="tech">
      <div v-if="vstream" class="tcard vid">
        <h3>视频</h3>
        <dl>
          <!-- 「标题」 printed the server's own sentence — 1080p H264, 4K HDR 10 HEVC — on 22,858 of the
               23,027 sources measured 2026-10-27, and every word of it is a row below: the height, the
               range the strip above names, the codec. What none of them said was the 58 files whose height
               is fields of interlaced lines rather than frames, so that is the one word kept, from the
               server's own flag. -->
          <template v-for="row in [
            ['分辨率', fmtRes(vstream)],
            ['扫描', vstream.isInterlaced ? '隔行' : ''],
            ['帧率', fmtFps(vstream.fps)],
            ['编码', vstream.codec?.toUpperCase()],
            ['配置', vstream.profile],
            ['位深', vstream.bitDepth ? vstream.bitDepth + ' 位' : ''],
          ] as Array<[string, string]>" :key="row[0]">
            <template v-if="row[1]"><dt>{{ row[0] }}</dt><dd>{{ row[1] }}</dd></template>
          </template>
        </dl>
      </div>
      <div v-if="audioRows.length" class="tcard aud">
        <h3>音频<span v-if="audioRows.length > 1" class="cnt">{{ audioRows.length }} 条</span></h3>
        <ul class="tracks">
          <li v-for="(a, i) in audioRows" :key="i" class="trk" :class="{ def: a.isDefault, on: a.pick }">
            <p class="tk">{{ a.nums }}<span v-if="a.name" class="tk-name">{{ a.name }}</span><span v-if="a.ord" class="tk-tag">{{ a.ord }}</span><span v-if="a.isDefault" class="tk-tag">默认</span></p>
          </li>
        </ul>
      </div>
      <div v-if="subGroups.length || multi" class="tcard wide">
        <h3>字幕<span v-if="subTotal > 1" class="cnt">{{ subTotal }} 条</span></h3>
        <!-- The separator is its own element rather than the chip's ::after pseudo-element, so the green frame can
             close on the label alone: a frame drawn around 「上译简中特效 /」 reads as if the slash were part of the
             track's name, which is the one thing on this card a reader could mistake for the row's own text. -->
        <p v-if="subGroups.length" class="labs"><span v-for="g in subGroups" :key="g.lang" class="lg"><span class="lead"><b :class="{ on: g.pickLang }">{{ g.lang }}</b><span v-if="g.vars.length" class="v" :class="{ on: g.vars[0].pick }">{{ g.vars[0].t }}</span><span v-if="g.vars.length > 1" class="sep">/</span></span><template v-for="(v, j) in g.vars.slice(1)" :key="j"><span class="v" :class="{ on: v.pick }">{{ v.t }}</span><span v-if="j < g.vars.length - 2" class="sep">/</span></template></span></p>
        <!-- A version with no subtitle track has no list, and 9,165 of the 23,027 sources are that way with
             no second version to press — on those, the card's absence is the honest answer. Under a switch
             it is not: measured on OkEmby 197229 阿甘正传, the 字幕 card holding 30 tracks vanished the
             moment the reader pressed the other strip and the sheet gave no reason for losing a block. One
             line, and only where a strip made it go away. -->
        <p v-else class="labs none">这个版本没有字幕</p>
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
/* The sunk row is a fact about the file rather than a choice: no pointer, no tint, and no press that would
   leave the three cards below describing something the server cannot serve. Its words keep their colour —
   「无内容」 has to be readable to be believed — the row simply stops behaving like a control. */
.src.multi .srccard.inert,
.srccard.inert { cursor: default; }
.src.multi .srccard.inert:hover { background: var(--bg-elev); }
/* One weight of 「focused」 on this sheet. The ring was 55% alpha: sampled off the screen it painted
   rgb(119,119,124) on the rgb(244,244,247) page, 4.06:1, while the dialog's × painted solid --text at
   18.63:1 — two stops of one Tab walk answering the same question in two voices. Solid, it measures
   rgb(18,18,26) at 16.57:1 on the page and 15.49:1 over the .on tint, so the ring reads on the strip the
   reader is already on and not only on its neighbours. The player's sheet does it this way already: one
   rule, one token, every control inside it. */
.src.multi .srccard:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
.srccard.on { background: color-mix(in srgb, var(--text) 9%, var(--bg-elev)); border-color: color-mix(in srgb, var(--text) 40%, var(--line)); }
/* The un-picked tabs keep the same boxes and lose only the brightness of their headline: with the card the
   reader is on named by a lit border, its neighbours recede without anything moving out from under them. */
.src.multi .srccard:not(.on) .sc-top { color: var(--text-dim); }
.sc-main { min-width: 0; }
.sc-top { margin: 0; font-size: 15px; font-weight: 700; color: var(--text); }
/* The ordinal qualifies the headline rather than repeating it, so it sits at the meta's weight: on a strip
   where nothing else differs it is the only word telling two buttons apart, and it still must not outrank
   the range beside it. */
.sc-ord { margin-left: 8px; font-size: 13px; font-weight: 500; color: var(--text-dim); }
/* 「the file playing」 is a state, not a choice, and the strip already spends its accent on the choice — the
   pressed version. So this one is a green frame and nothing more: the same box on a lone version (which has
   no tab bar and no press) and on the one row of a tab bar the player is reading. Frame only, no ring and no
   word, because 「使用中」 printed on every card a viewer happens to be playing was the label doing the frame's
   job twice. --brand is the app's live dot (账号 · 侧栏), mixed toward --line so it reads as a frame on the
   white sheet instead of a selection tint. */
.srccard.live { border-color: color-mix(in srgb, var(--brand) 60%, var(--line)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--brand) 30%, transparent), var(--shadow-sm); }
/* Wraps, because a strip that shares its headline with a rival carries two more facts than one that does
   not, and at 836px of dialog each of two cards gets 411px — a line of 七 values would have run out of box.
   Both rivals gain the counts together, and `.src` stretches them to one height, so the second row costs
   the strip's own card nothing it was not already going to pay. */
.sc-meta { margin: 2px 0 0; display: flex; gap: 4px 14px; flex-wrap: wrap; font-size: 13px; color: var(--text-dim); font-variant-numeric: tabular-nums; }

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
/* The frame on the audio row is tight around the row's own text rather than its full width: a thousand-pixel box
   drawn around 「英语 · TRUEHD · 7.1」 reads as a table row selected, not as one track pointed at. */
.trk.on .tk { display: inline-flex; max-width: 100%; padding: 1px 8px; margin: 0 -8px; border-radius: 8px; outline: 1.5px solid color-mix(in srgb, var(--brand) 55%, transparent); outline-offset: 0; }
.tk {
  margin: 0; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  font-size: 13px; font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums;
}
.tk-tag { flex: none; padding: 0 6px; border-radius: 999px; background: var(--chip); color: var(--text-dim); font-size: 13px; font-weight: 500; }
/* The row the player will have open — the 首选语言 pick, or the file's own default when the preference found
   nothing — is framed rather than labelled. A word beside every marked row would print 「将使用」 on the
   default of every file that carries no preference at all, which is most of them; a frame says 「this one」
   and leaves the reading to the row's own text. It draws outside the box, so a frame never re-wraps the list
   it sits in: the audio rows keep their 7px gap and the chips their slashes. */
/* Same frame on the subtitle chip. The chip steps up to the reading weight too, because a framed box sitting
   dim beside its siblings would still read as the one nobody is looking at. */
.labs .v.on { color: var(--text); font-weight: 600; border: 1.5px solid color-mix(in srgb, var(--brand) 55%, transparent); border-radius: 999px; padding: 0 7px; margin: 0 -7px; }
.labs b.on { color: var(--text); outline: 1.5px solid color-mix(in srgb, var(--brand) 55%, transparent); outline-offset: 3px; border-radius: 8px; }
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
.labs .sep { margin: 0 8px; color: var(--text-dim); font-weight: 400; }
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
/* The one line that stands where a list would be, at the weight of the list's own qualifiers. */
.labs.none { color: var(--text-dim); font-weight: 500; }

/* The block ends on the one line about the file that no other surface answers: when the server took it in.
   Which release this is moved up into the version strip, where each version can say it for itself. */
.foot { display: flex; justify-content: flex-end; gap: 18px; margin: 16px 0 0; font-size: 13px; color: var(--text-dim); }
.added { flex: none; font-variant-numeric: tabular-nums; }
</style>
