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
  const pct = Math.min(100, u.playedPercentage || 0);
  const ms = u.positionMs || (pct > 0 ? Math.round((ticksToMs(runTimeTicks) * pct) / 100) : 0);
  // Under a second there is no stop to print: 播完 rolls straight into the next episode and that switch
  // flushes the one that just began, which measured pos=33 - a card reading 「看到 0:00」 under 继续播放.
  return ms >= 1000 ? ms : 0;
};

/** How far through a row the viewer got, as 0..1, off whichever of the two fields this server answered
 *  with. The percentage is the sparse one — measured over 200 raw 在看 rows it appears on 3, while 15 of
 *  this page's 94 folded rows carry an offset — so the offset over the row's own runtime is the number a
 *  bar should read, and the percentage only stands in for the rows this fork answers that way instead. */
export const watchedRatio = (u?: { playedPercentage?: number; positionMs?: number }, runTimeTicks?: number): number => {
  const ms = stoppedAtMs(u, runTimeTicks);
  const full = ticksToMs(runTimeTicks);
  if (ms > 0 && full > 0) return Math.min(1, ms / full);
  return Math.min(1, (u?.playedPercentage || 0) / 100);
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

/** Emby names a track's language with an ISO-639-2 code (`jpn`, `chi`, `und`), which is not a thing a viewer
 *  reads. This is the one table that spells those codes out: the player's track menu, the 技术信息 card and
 *  the 资源库 language filter all read through `langName`, so a viewer who ticks 「日语」 to find a title does
 *  not then read 「日文」 inside it. The keys below are the set these two gateways actually answer with
 *  (measured over 60 files: kor·chi·jpn·und·eng·spa·fre·ger·ita·pol·por·rus·tha·ind·may·fil·ara·bul·cze·
 *  hun·swe·dut·fin·rum·gre·hin·tur·nob·dan), and a code that is not here prints as itself rather than as a
 *  guess. */
const LANGS: Record<string, string> = {
  zho: '中文', chi: '中文', chs: '中文（简）', zht: '中文（繁）', cht: '中文（繁）', zh: '中文', yue: '粤语',
  eng: '英语', en: '英语', jpn: '日语', kor: '韩语', fre: '法语', fra: '法语', ger: '德语', deu: '德语',
  spa: '西班牙语', ita: '意大利语', rus: '俄语', por: '葡萄牙语', tha: '泰语', vie: '越南语', und: '无语言',
  ind: '印尼语', may: '马来语', fil: '菲律宾语', ara: '阿拉伯语', bul: '保加利亚语', cze: '捷克语',
  hun: '匈牙利语', swe: '瑞典语', dut: '荷兰语', fin: '芬兰语', rum: '罗马尼亚语', gre: '希腊语',
  hin: '印地语', tur: '土耳其语', nob: '挪威语', dan: '丹麦语', pol: '波兰语',
};

export const langName = (code?: string): string => {
  if (!code) return '';
  const key = code.toLowerCase();
  if (key.startsWith('zh-hant')) return '中文（繁）';
  if (key.startsWith('zh-hans')) return '中文（简）';
  return LANGS[key] || code;
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

/** 「45分钟」 / 「1小时30分」 from whole minutes. The server bills a file in ticks and TMDB bills an episode
 *  in minutes, and a card must be able to print either without two spellings of the same length. */
export const fmtMinutes = (mins?: number): string => {
  const m = Math.round(Number(mins) || 0);
  if (!m) return '';
  return m >= 60 ? `${Math.floor(m / 60)}小时${m % 60}分` : `${m}分钟`;
};

export const fmtRuntime = (ticks?: number): string => {
  const ms = ticksToMs(ticks);
  if (!ms) return '';
  return fmtMinutes(Math.round(ms / 60000));
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

/** What one of this machine's servers is called. The name typed here comes first because every gateway
 *  answers with 「OkEmby」 as its own server name, and two of them have to be told apart; the host is what
 *  is left when neither was ever filled in. The rail's account row and a card's corner badge both read
 *  through here, so the same server never carries two spellings. */
export const accountName = (a: { label?: string; serverName?: string; baseUrl: string }): string =>
  a.label || a.serverName || a.baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
