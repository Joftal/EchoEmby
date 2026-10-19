export const fmtClock = (ms: number): string => {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

export const ticksToMs = (ticks?: number): number => Math.round((ticks || 0) / 1e4);

/** How far a viewer got, in milliseconds, from whichever of the two fields this server chose to answer
 *  with. Measured on the resume query: 2 of its 8 rows carry a percentage, 6 carry a position, and the
 *  position is the one an Episode ever gets — a rule that read only the percentage would call most of them
 *  fresh. The position comes first because it is the exact offset the player POSTed, while a percentage is
 *  an integer the gateway rounded before sending it. */
export const stoppedAtMs = (u?: { playedPercentage?: number; positionMs?: number }, runTimeTicks?: number): number => {
  if (!u) return 0;
  if (u.positionMs) return u.positionMs;
  const pct = Math.min(100, u.playedPercentage || 0);
  return pct > 0 ? Math.round((ticksToMs(runTimeTicks) * pct) / 100) : 0;
};

/** The progress read-out, 「看到 27:06」 — the one wording every surface that answers how far a viewer got
 *  prints, off the one number above. The hero's button used to count whole minutes off the position while
 *  the card's chip multiplied a rounded percentage by the runtime, so the same episode said 「已播 29 分钟」
 *  under 继续播放 and 「看到 27:06」 on its own card. */
export const seenLabel = (u?: { playedPercentage?: number; positionMs?: number }, runTimeTicks?: number): string => {
  const ms = stoppedAtMs(u, runTimeTicks);
  return ms > 0 ? `看到 ${fmtClock(ms)}` : '';
};

/** Where the show is - 「第 1 季 · 第 2 集」 - the one wording every episode surface reads. A row that
 *  does not say which season it sits in drops that half rather than guessing. Counts (「8 集」、「3 季」)
 *  are not positions and stay bare. */
export const episodePosition = (season?: number | null, episode?: number | null): string => {
  if (episode == null) return '';
  return season != null ? `第 ${season} 季 · 第 ${episode} 集` : `第 ${episode} 集`;
};

/** Half the episodes on this server have no title of their own and come named 「第 2 集」, 「27」 or
 *  「Episode 3」 - which the position in front of them already says. `episodeTail` is the surface rule;
 *  this is the one it finishes on. */
const isPositionOnlyName = (name: string): boolean => {
  const t = name.trim();
  return /^第\s*[\d一二三四五六七八九十百千]+\s*[集话話]\s*$/.test(t) || /^\d+$/.test(t) || /^episode\s*\d+$/i.test(t);
};

/** Where a name spells its own position: each pattern yields the season (null when it names none) and the
 *  episode it claims. `(?<!\d)`/`(?!\d)` keep a resolution out of the list — 「1920x1080」 is not 20x108.
 *  Four digits on the episode because the long-running shows here are past 999: 名侦探柯南 rows come named
 *  「名侦探柯南 - S01E1277」, and a three-digit cap read no code at all, so the release group's label stayed
 *  on the card. The resolution pattern keeps its three — a 4-digit tail there is the picture, not an episode. */
const POSITION_CODES: [RegExp, (m: RegExpMatchArray) => [number | null, number]][] = [
  [/s(?:eason)?\s*(\d{1,2})[\s._\-–—x]*e(?:p(?:isode)?)?\s*(\d{1,4})(?!\d)/i, m => [+m[1], +m[2]]],
  [/(?<!\d)(\d{1,2})\s*[x]\s*(\d{1,3})(?!\d)/, m => [+m[1], +m[2]]],
  [/第\s*(\d{1,2})\s*季\s*第\s*(\d{1,4})\s*[集话話]/, m => [+m[1], +m[2]]],
  [/\bep\.?\s*(\d{1,4})\b/i, m => [null, +m[1]]],
  [/#\s*(\d{1,4})(?!\d)/, m => [null, +m[1]]],
  [/第\s*(\d{1,4})\s*[集话話]/, m => [null, +m[1]]],
  [/[【[(（]\s*(\d{1,4})\s*[】)\]）](?!\d)/, m => [null, +m[1]]],
];

/** What an episode's own name adds beyond the position the card already prints. Measured over the 3681
 *  episode rows both censuses pulled: 647 are 「第 57 集」 (the number alone), 51 more are 「ゆるキャン△ -
 *  S01E06」 (the number wearing the show's name), and 12 are 「第 3 集 鬼迷心窍」 (the number in front of a
 *  real title). A code is dropped only where it agrees with the row's own numbers, so a file named for a
 *  different episode keeps its words, and only what a drop leaves behind can be dropped for being the
 *  show's own name — 迷雾 第 16 集 and 都市男女爱情法 第 1 集 are episodes genuinely called that. */
const episodeTail = (name: string, season?: number | null, episode?: number | null, seriesName?: string): string => {
  let t = (name || '').trim();
  if (!t) return '';
  if (episode == null && season == null) return isPositionOnlyName(t) ? '' : t;
  const show = (seriesName || '').trim();
  const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
  for (let pass = 0; pass < 4; pass++) {
    let cut = false;
    for (const [code, read] of POSITION_CODES) {
      const m = t.match(code);
      if (!m || m.index == null) continue;
      const [cs, ce] = read(m);
      if (ce !== episode || (cs != null && season != null && cs !== season)) continue;
      t = (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).trim();
      cut = true;
      break;
    }
    // A name no code was taken out of is the episode's own and leaves as it came - the trimming below
    // would eat the brackets of 「[VCB-Studio] Yuru Camp [CM][Ma10p_1080p]」 for nothing.
    if (!cut) break;
    // Only the dangling ends of the cut come off - separators and a bracket the code emptied.
    t = t
      .replace(/[（(\[【]\s*[)）\]】]/g, ' ')
      .replace(/^\s*(?:[-–—·・:：|｜,，、/\\]\s*)+/, '')
      .replace(/\s*(?:[-–—·・:：|｜,，、/\\]\s*)+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t || (show && same(t, show))) return '';
  }
  return t && !isPositionOnlyName(t) ? t : '';
};

/** A season's name is worth printing only for what it says beyond its number, and several sources may
 *  hold a name for the same season: this library's own rows come first, then TMDB's, and the first one
 *  that says anything more than the position wins. Measured here: 「第1季 立志篇」 and 「最终季」 name the
 *  season the viewer is choosing, while 「季 3」, 「Season 1」 and the 「シーズン 12」 物语系列 files fourteen
 *  of its seasons under just spell the position a second way and are dropped — and 鬼灭's server rows say
 *  only 「第 1 季」, where TMDB has the 「立志篇」 the server never filled in. */
export const seasonTitle = (season?: number | null, ...names: (string | undefined)[]): string => {
  const beyond = (name?: string): string =>
    (name || '')
      .trim()
      .replace(/^第\s*[\d一二三四五六七八九十百千]+\s*[季部]\s*[:：\-·]?\s*/, '')
      .replace(/^(season|季|シーズン)\s*\d+\s*[:：\-·]?\s*/i, '')
      .trim();
  const sub = names.map(beyond).find(Boolean) || '';
  if (season == null) return names.map(x => (x || '').trim()).find(Boolean) || '';
  // TMDB files specials, OVA and 总集篇 as season 0; 「第 0 季」 is not a season anyone counts, so the row's
  // own name is printed bare.
  if (season === 0 && sub) return sub;
  return sub ? `第 ${season} 季 · ${sub}` : `第 ${season} 季`;
};

/** One episode's headline inside a season the page has already named above it: the number the row is
 *  ordered by, then what the episode is actually called. The 「第 1 季」 half used to sit here too and spent
 *  the line's whole width restating the season that is open, once per card.
 *  `episodeName` is the ladder this prints after, so a surface that already owns its own position wording
 *  (the 在看 card, which says the season too) can take the name without the number twice. */
export const episodeName = (
  at: { episode?: number | null; season?: number | null; seriesName?: string },
  ...names: (string | undefined)[]
): string => names.map(n => episodeTail(n || '', at.season, at.episode, at.seriesName)).find(Boolean) || '';

export const episodeHead = (
  at: { episode?: number | null; season?: number | null; seriesName?: string },
  ...names: (string | undefined)[]
): string => {
  const pos = at.episode == null ? '' : `第 ${at.episode} 集`;
  const named = episodeName(at, ...names);
  return pos && named ? `${pos} · ${named}` : pos || named;
};

/** 「14 分钟」 / 「2 小时 6 分」 from a millisecond span — how long something runs, not how far a viewer got.
 *  The resume read-out used to be its other customer and is now `seenLabel`, which is a clock. */
export const fmtElapsed = (ms: number): string => {
  const mins = Math.round(Math.max(0, ms) / 60000);
  if (!mins) return '';
  return mins >= 60 ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分` : `${mins} 分钟`;
};

export const fmtRuntime = (ticks?: number): string => {
  const ms = ticksToMs(ticks);
  if (!ms) return '';
  const mins = Math.round(ms / 60000);
  return mins >= 60 ? `${Math.floor(mins / 60)}小时${mins % 60}分` : `${mins}分钟`;
};

export const fmtDate = (iso?: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 入库时间 reads as a full stamp: 「2025年4月6日 02:39」. */
export const fmtDateTime = (iso?: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
};
