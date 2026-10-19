import type { LibraryItem, WatchedRecord } from '../../shared/types';
import { episodePosition, seenLabel, stoppedAtMs } from './format';

/** What a hero's play button stands for: the row it hands the player, and the sentence under the label.
 *  Null means this page holds no row to play — the button then opens the title's own page and lets that
 *  page resolve its first episode, so a slide stops being clickable only when nothing can play it. */
export interface ResumeTarget {
  /** Not always the hero's own card: a Series resumes into the episode that stopped. */
  item: LibraryItem;
  /** Whether the server said *how far* the viewer got. 「继续播放」 is only honest with a position behind
   *  it, and a row can still name an episode while carrying 0: 在看's second ask is a title the resume
   *  endpoint holds no offset for, and a gateway writes the number a *start* report carries back into the
   *  item about a minute later, so an open that reported 0 leaves a real stop erased (measured on nyamedia:
   *  187396 → 0). Those buttons say 「播放」 over the episode they will really open. */
  resumed: boolean;
  /** 「第 1 季 · 第 2 集 · 看到 27:06」, and only the halves this server answered. The same `seenLabel` the
   *  episode card's own chip prints, so one episode cannot wear two of them. */
  caption: string;
}

/** The shapes the player can be handed a file for. A `Series` is not one of them — it names no media
 *  source — and neither is a `Season`, which is why the lobby reaches an episode through its page.
 *  One list on purpose: this gate read twice made a slide lose its button on one host and not the other. */
export const PLAYABLE = ['Movie', 'Episode', 'Video'];

/** The page types whose hero can hold a play button: the three above, plus the two that name an episode
 *  through their season list. A 合集/播放列表/资源库 page names no file at all, so its hero has no button
 *  rather than one that answers 「服务器出错了（HTTP 500）」. */
export const PLAYABLE_PAGE = [...PLAYABLE, 'Series', 'Season'];

const stopped = (it: LibraryItem): number => stoppedAtMs(it.userData, it.runTimeTicks);

/** Write the stop the server just took onto a row that is showing this item.
 *  One number reaches the screen through two fields — the exact offset and the gateway's rounded
 *  percentage — and a page holding only the second would print a 「看到」 that disagrees with the hero over
 *  it. Both are written here so no surface has to know which one this server chose to answer with. */
export function applyStop(it: LibraryItem, w: WatchedRecord): void {
  const pct = w.durationMs > 0 ? Math.min(100, (w.positionMs / w.durationMs) * 100) : 0;
  it.userData = { ...it.userData, positionMs: w.positionMs, playedPercentage: Math.round(pct * 10) / 10 };
}

function target(it: LibraryItem, seasonNamed = false): ResumeTarget {
  // A Season page already prints its own season above the button, so restating it there buys nothing.
  const where = it.type === 'Episode' ? episodePosition(seasonNamed ? null : it.parentIndexNumber, it.indexNumber) : '';
  return {
    item: it,
    resumed: stopped(it) > 0,
    caption: [where, seenLabel(it.userData, it.runTimeTicks)].filter(Boolean).join(' · '),
  };
}

/** Rows the *same* server answers twice — the 在看 row and a Latest row are two objects over one item —
 *  so membership is read by id, not by identity. */
const inSet = (list: LibraryItem[], it: LibraryItem): boolean => list.some(x => x.id === it.id);

/** The row a hero's button should play, or null when nothing on this page says which file to open.
 *  `candidates` are the rows the page already holds for this title — the lobby's 继续观看 row, the
 *  detail page's season — because a Series or Season card carries no position of its own (measured: its
 *  UserData answers UnplayedItemCount and 8 rows, nothing about where the viewer stopped).
 *  `flagged` is the half of those the server itself returned as in progress, and it is what lets a row
 *  count without an offset. A season's episode list must not be read that way: every one of its rows
 *  matches the same query, so 第 1 集 — never opened — would land under a button labelled 播放.
 *  `seasonNamed` drops the 「第 N 季」 half of the caption for the pages that already say it. */
export function resumeTarget(
  item: LibraryItem | null,
  candidates: LibraryItem[] = [],
  flagged: LibraryItem[] = candidates,
  seasonNamed = false,
): ResumeTarget | null {
  if (!item) return null;
  if (PLAYABLE.includes(item.type)) return stopped(item) > 0 || inSet(flagged, item) ? target(item) : null;
  // Two ways an episode hangs off the card above it by id, and a third by name that only speaks when the
  // row carries neither id: measured here, 500 Series rows hold 20 duplicated names, and 「凡人修仙传」 is
  // two separate folders (219367, 217153) — so a page keyed by name borrowed the other folder's stopped
  // episode and both pages printed the same 「继续播放 第 1 季 · 第 195 集」 over it.
  const hit = candidates.find(
    c =>
      c.type === 'Episode' &&
      (stopped(c) > 0 || inSet(flagged, c)) &&
      (c.seriesId === item.id ||
        c.seasonId === item.id ||
        (!c.seriesId && !c.seasonId && !!c.seriesName && c.seriesName === item.name)),
  );
  return hit ? target(hit, seasonNamed) : null;
}
