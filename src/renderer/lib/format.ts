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
 *  「Episode 3」 - which the position in front of them already says. */
export const isPositionOnlyName = (name: string): boolean => {
  const t = name.trim();
  return /^第\s*[\d一二三四五六七八九十百千]+\s*[集话話]\s*$/.test(t) || /^\d+$/.test(t) || /^episode\s*\d+$/i.test(t);
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
 *  The names come in the order every other text surface on this page uses (TMDB in Chinese, then the
 *  server's own row, then TMDB in whatever else it filed), and a name that only repeats the position is
 *  dropped: measured here, 235 of the library's 1437 episodes are titled 「第 2 集」, 「27」 or 「Episode 3」. */
export const episodeHead = (episode: number | null | undefined, ...names: (string | undefined)[]): string => {
  const pos = episode == null ? '' : `第 ${episode} 集`;
  const named = names.map(n => (n || '').trim()).find(n => !!n && !isPositionOnlyName(n) && n !== pos) || '';
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
