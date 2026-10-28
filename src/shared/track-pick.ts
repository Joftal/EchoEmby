import type { MediaStreamInfo } from './types';
import { langKey, parseLangPref, scriptOf, type LangPref } from './lang';

/** What a preferred language asks the player to open on, in the server's own addresses (`MediaStreamInfo`,
 *  whose `index` is the `ff-index` mpv will report for the same stream). `'off'` is 关闭字幕 and is only
 *  ever a subtitle answer; an absent field means «this preference picked nothing», which leaves mpv's own
 *  behaviour exactly as it was before the setting existed. */
export interface TrackPick {
  audio?: MediaStreamInfo;
  subtitle?: MediaStreamInfo | 'off';
}

/** A track a release group recorded over the film instead of with it. These sit inside the same language as
 *  the main mix — 死神来了2's file carries a `pl` commentary beside its `pl` dub — so a picker that only
 *  counted channels would hand a viewer the talking-over-the-film track on the one file where the dub is
 *  stereo and the commentary is 5.1. The words are the ones releases use: 评论, 解说, and the English
 *  `Commentary` every muxer that names one uses. 旁白 (narration) is here too: it is an alternate mix, never
 *  the film's own voice. */
const isCommentary = (t: MediaStreamInfo): boolean =>
  /评论|解说|旁白|commentary|comment\s*track/i.test(`${t.title || ''} ${t.displayTitle || ''}`);

/** Whether a track is a bit-exact encoding of the mix. A lossless track often carries no `BitRate` at all —
 *  the server cannot price a TrueHD stream in kbps — so this cannot be measured from the numbers and has to
 *  be read off the codec and the profile the server names. `DTS-HD` alone is the lossy core (that is
 *  `DTS-HD HRA`); only `MA` is the lossless layer. */
const isLossless = (t: MediaStreamInfo): boolean => {
  const codec = (t.codec || '').toLowerCase();
  const profile = (t.profile || '').toLowerCase();
  if (/truehd|flac|alac|lpcm|pcm/.test(codec)) return true;
  if (/truehd|flac|alac/.test(profile)) return true;
  return /dts[- ]?hd/.test(profile) && /\bma\b/.test(profile);
};

/** Codec tiers, as far as a viewer could hear them on one machine. Not a ranking of quality by name but of
 *  what these gateways actually serve: an E-AC3 5.1 at 768 kbps is the disc's main mix on most of this
 *  library, AC3 is the compatibility fallback beside it, and AAC/Opus are what a web release offers. */
const CODEC_TIER: Record<string, number> = { truehd: 6, flac: 6, alac: 6, lpcm: 6, pcm: 6, dts: 5, eac3: 4, ac3: 3, aac: 2, opus: 2, vorbis: 2, mp3: 1 };

/** How good one same-language audio track is, higher wins. The order is the one a viewer would state it in:
 *  not a commentary, then lossless, then the wider mix (a 5.1 mix carries the effects the stereo fold-down
 *  throws away), then the higher bitrate, then the newer codec, then the file's own default. Measured on the
 *  one shape that matters here — a disc file with a 5.1 TrueHD main mix beside a 2.0 AC3 compatibility
 *  track, 27 of these items in 32496's 60-audio-file sample — this answers the main mix on all of them. */
const audioScore = (t: MediaStreamInfo): number => {
  let s = 0;
  if (isCommentary(t)) s -= 1000;
  if (isLossless(t)) s += 500;
  // 2.0 = 50, 5.1 = 150, 7.1 = 200: worth more than 100 kbps of bitrate and less than losslessness.
  s += Math.min(t.channels || 0, 8) * 25;
  // Capped at 4 Mbps so one absurd header cannot outrank everything else, and divided by ten so a 768 kbps
  // mix beats a 640 kbps one by 12.8 points — a real difference, one channel's worth of gap.
  s += Math.min(t.bitRate || 0, 4_000_000) / 10_000;
  s += (CODEC_TIER[(t.codec || '').toLowerCase()] || 0) * 6;
  if (t.isDefault) s += 5;
  // An external track is a file beside the video rather than the disc's own mix; it loses ties, nothing more.
  if (t.isExternal) s -= 4;
  return s;
};

/** How readable one same-language subtitle is, higher wins. Forced first: a forced track carries only the
 *  lines the film speaks in another language, so a viewer who asked for 英语 subtitles on a Chinese film
 *  wants the full translation, not the four signs the disc was required to explain. Next 听障: both the
 *  server's flag and the words 听障/SDH/CC, because 440 of the 1,817 flagged rows say nothing in their title
 *  and the flag is the other half of the same fact. Then text over pictures: a PGS track cannot be restyled,
 *  cannot be read by the app's own font settings, and on a 1080p screen the disc's 4K-scale subtitles are not
 *  sharper than a rendered text track — so 中文（简）'s SRT wins over its PGS sibling when both name the same
 *  language. */
const subtitleScore = (t: MediaStreamInfo, pref: LangPref): number => {
  const words = `${t.title || ''} ${t.displayTitle || ''}`;
  let s = 0;
  if (t.isForced) s -= 200;
  if (t.isHearingImpaired || /\bsdh\b|听障|\bcc\b/i.test(words)) s -= 100;
  if (t.isTextSubtitle === false) s -= 60;
  if (pref.script) {
    const script = scriptOf(t.lang, words);
    // A track that says the other script is not what was asked for, but it is still Chinese subtitles: it
    // stays behind the right one and ahead of nothing.
    if (script === pref.script) s += 30;
    else if (script) s -= 30;
  }
  if (t.isDefault) s += 5;
  if (t.isExternal) s -= 3;
  return s;
};

/** The best of one kind, or undefined when nothing matched. Ties break on the server's own stream order, so
 *  two identical tracks always resolve the same way twice — a picker that answered differently between two
 *  plays of one file would be indistinguishable from a bug. */
const best = <T extends MediaStreamInfo>(rows: T[], score: (t: T) => number): T | undefined => {
  let pick: T | undefined;
  let top = -Infinity;
  for (const row of rows) {
    const s = score(row);
    if (s > top) {
      top = s;
      pick = row;
    }
  }
  return pick;
};

/** Which track of one version the 首选语言 settings open on. Two independent questions, one per kind, each
 *  answered only when a language was actually named: an empty preference must leave mpv exactly as it was,
 *  because the app has always let the file's own default win and that is what most files get right. */
export const pickTracks = (
  src: { audio: MediaStreamInfo[]; subtitle: MediaStreamInfo[] },
  prefs: { audioLang?: string; subLang?: string },
): TrackPick => {
  const out: TrackPick = {};

  const audio = parseLangPref(prefs.audioLang);
  if (audio && !audio.off && audio.key) {
    const rows = (src.audio || []).filter(t => t.index != null && langKey(t.lang) === audio.key);
    const pick = best(rows, audioScore);
    if (pick) out.audio = pick;
  }

  const sub = parseLangPref(prefs.subLang);
  if (sub?.off) out.subtitle = 'off';
  else if (sub && sub.key) {
    // An external .sup can never be selected — mpv decodes a bitmap subtitle only inside a container — so it
    // is not a candidate at all, rather than a winner that fails when it is handed the file.
    const rows = (src.subtitle || []).filter(t => t.index != null && langKey(t.lang) === sub.key && !(t.isExternal && t.isTextSubtitle === false));
    const pick = best(rows, t => subtitleScore(t, sub));
    if (pick) out.subtitle = pick;
  }

  return out;
};
