export const fmtClock = (ms: number): string => {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

export const ticksToMs = (ticks?: number): number => Math.round((ticks || 0) / 1e4);

/** The app's one progress read-out, 「看到 27:06」. The gateway never answers StartPositionTicks (measured:
 *  0 on every row, even right after a progress POST), so the position has to be rebuilt as percentage ×
 *  runtime — the same arithmetic Emby's own web client does. Coverage is the server's, not ours: 3 of the
 *  200 rows the 在看 query returns carry a percentage at all. */
export const seenLabel = (pct?: number, runTimeTicks?: number): string => {
  if (!pct || pct <= 0) return '';
  const ms = (ticksToMs(runTimeTicks) * Math.min(100, pct)) / 100;
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
