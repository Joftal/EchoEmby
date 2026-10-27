/** Which file a version is, in the one word its own name says about its shape.
 *
 *  The gateway puts a label in `MediaSources[].Name` when it has one — 挽救计划's two versions are literally
 *  「2160p」 and 「1080p」 — and the whole filename when it has not, which is every episode measured so far
 *  (「黑袍纠察队 - S03E08 - 第 8 集」). The card used to answer that with a length cap (`> 12` characters is
 *  not a label), and a cap cannot tell a filename from a label: it threw away the only two words in the
 *  corpus that name what a version *is* — 哺乳动物星球 S01E01's 「 - tv」 and 「 - mobile」, glued behind a
 *  23-character filename — while letting a 12-character alternate show title through as the head.
 *
 *  So this reads the shape words out and ignores everything else, which needs no knowledge of the item's
 *  title: a title is not a shape. Ranked, because a name can carry several (「2160p HDR WEB-DL」) and the
 *  strip has room for one — the resolution is the thing a reader picks between two files over, then the
 *  dynamic range, then how it was released, then the container, then the role.
 *
 *  Measured 2026-10-27 over both gateways' 23,027 version names: the shape vocabulary covers every token
 *  that is not a year, an episode code, a bare number, a CJK title or a release group's name. */
const SHAPE: [RegExp, number][] = [
  [/^\d{3,4}[ip]$/i, 0], // 2160p / 1080i / 720p
  [/^(4k|8k|2k|uhd|fhd)$/i, 0],
  [/^(sdr|hdr10\+?|hdr|dovi|dv|dolbyvision|dolby vision)$/i, 1],
  [/^(bluray|blu-?ray|bdrip|brrip|webrip|web-?dl|web|hdtv|dvdrip|dvd5?|remux|brdisk)$/i, 2],
  [/^(mkv|mp4|m4v|ts|m2ts|avi|mov|wmv|mpg|mpeg|iso|strm)$/i, 3],
  [/^(tv|mobile|sd)$/i, 4],
];
/** One version's word, or '' when its name says nothing about its shape — which is the caller's signal to
 *  fall back to the dynamic range, the one file fact no card below repeats. */
export const versionLabel = (name?: string): string => {
  if (!name) return '';
  let best = '';
  let bestRank = Infinity;
  for (const token of name.split(/[^A-Za-z0-9+.]+/)) {
    const w = token.replace(/^\.+|\.+$/g, '');
    if (!w) continue;
    for (const [re, rank] of SHAPE) {
      if (rank >= bestRank) continue;
      if (re.test(w)) {
        best = w;
        bestRank = rank;
        break;
      }
    }
  }
  return best;
};

/** One name per version, in the order the server listed them, for a surface that has room for a name and
 *  nothing beside it. The 播放资源 card can break a tie with the two files' track counts; the player's
 *  播放源 card has only its size, its bitrate and its range, so a word two versions share is qualified with
 *  its position here — and a version whose name says no shape at all (every episode, whose `Name` is the
 *  filename) is called by its position alone. Both surfaces reach these words through this one function, so
 *  the file a reader picked on the card is the file the player's panel names the same way. */
export const versionNames = (list: readonly { name?: string }[]): string[] => {
  const raw = list.map(s => versionLabel(s.name));
  return raw.map((v, i) => (!v ? `版本 ${i + 1}` : raw.filter(o => o === v).length > 1 ? `${v} 版本 ${i + 1}` : v));
};
