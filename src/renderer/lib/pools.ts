import type { CalendarPool } from '../../shared/types';

/** The 追剧日历's档, in the order its chips read. The named languages run near-to-far (国产 → 国创 → 日番
 *  → 韩剧 → 美剧) and 其他 keeps the last seat, because it holds whatever language this ladder does not
 *  name rather than another region.
 *
 *  One table because one colour paints three surfaces — the chip's dot, the day card's dot and the
 *  「还没排上」 row's dot — and a colour written twice is a colour that can disagree. It already had: 其他
 *  had no rule in the card's CSS and fell back to `--text-faint` while its chip was `#6b6b78`. */
export const CAL_POOLS: { key: CalendarPool; label: string; color: string }[] = [
  { key: 'cn', label: '国产剧', color: '#2f6bed' },
  { key: 'cnova', label: '国创', color: '#b8611a' },
  { key: 'jp', label: '日番', color: '#7b4bd1' },
  { key: 'kr', label: '韩剧', color: '#b03a67' },
  { key: 'en', label: '美剧', color: '#1f7a63' },
  { key: 'other', label: '其他', color: '#6b6b78' },
];

const find = (p: CalendarPool | ''): { label: string; color: string } | undefined => CAL_POOLS.find((x) => x.key === p);

export const poolColor = (p: CalendarPool | ''): string => find(p)?.color || '';
export const poolLabel = (p: CalendarPool | ''): string => find(p)?.label || '';
