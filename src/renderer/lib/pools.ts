import type { CalendarPool } from '../../shared/types';

/** The 追剧日历's档, in the order its chips read. The named languages run near-to-far (国产 → 国创 → 日番
 *  → 日剧 → 韩剧 → 美剧) and 其他 keeps the last seat, because it holds whatever language this ladder does not
 *  name rather than another region. 日番 and 日剧 are the same language split by medium, which is the split
 *  the words already make: 番 is animation, 剧 is everything live-action.
 *
 *  The档 used to be painted: one colour keyed the chip's dot, the day card's dot and the 「还没排上」 row's
 *  dot, from this one table so the three could not disagree. All three marks are gone now — a chip says its
 *  own name and carries its count, and a colour with nothing left to key off is a second way of saying what
 *  the words already say. */
export const CAL_POOLS: { key: CalendarPool; label: string }[] = [
  { key: 'cn', label: '国产剧' },
  { key: 'cnova', label: '国创' },
  { key: 'jp', label: '日番' },
  { key: 'jplive', label: '日剧' },
  { key: 'kr', label: '韩剧' },
  { key: 'en', label: '美剧' },
  { key: 'other', label: '其他' },
];

export const poolLabel = (p: CalendarPool | ''): string => CAL_POOLS.find((x) => x.key === p)?.label || '';
