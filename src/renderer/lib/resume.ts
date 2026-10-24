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
 *  `candidates` are the rows the page already holds for this title — the lobby's 继续观看 row, since the
 *  lobby asks the work-level question of where the viewer last stopped. A Series or Season card carries
 *  no position of its own (measured: its UserData answers UnplayedItemCount and 8 rows, nothing about
 *  where the viewer stopped), so those pages hand the stopped episode itself in `candidates` — and
 *  `seasonTarget` is only the fallback for a season that does not hold that stop.
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
  if (PLAYABLE.includes(item.type)) return stopped(item) > 0 || inSet(flagged, item) ? target(item, seasonNamed) : null;
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

/** A row the server bills as watched is not a stop. It answers `PlayedPercentage: 100` with position 0, and
 *  `stoppedAtMs` multiplies that into the row's whole runtime — so a button that read it as a stop would say
 *  「继续播放 · 看到 41:00」 and open an episode at its own last frame. One step under 100 because a gateway
 *  that rounds its percentage up from 99.6 is still answering "watched". */
const WATCHED = 99;

/** Whether a row says the viewer is still *inside* it, which is the one question every surface that names a
 *  progress answers: the 在看 shelf, a season's button and the page's work-scoped ask. Two shapes are not a
 *  stop — a row the fork marks Played with its offset reset (the shelf drops these as `stalled`, main
 *  client.ts:552), and the watched-at-100 row above. Measured over the whole resumable list on both hosts
 *  (24 rows bangumi, 6 OkEmby) neither shape is in it today; the rule is here so the three surfaces cannot
 *  each invent their own answer when one of them appears. */
export const isStoppedRow = (it: LibraryItem): boolean => {
  if (it.userData?.played && !it.userData.positionMs) return false;
  if ((it.userData?.playedPercentage || 0) >= WATCHED) return false;
  return stopped(it) > 0;
};

/** A row the viewer has not reached the end of, whether or not the server kept a number for how far they
 *  got. `isStoppedRow` cannot answer that question for a row whose offset the gateway has reset — measured
 *  on 金装律师, all 12 of its resumable rows answer positionMs 0 — and the episode the 在看 entry named is
 *  still the one to open. Reads the same `WATCHED` line so a row billed as watched at 100% cannot be the one. */
export const isUnfinishedRow = (it: LibraryItem): boolean =>
  !it.userData?.played && (it.userData?.playedPercentage || 0) < WATCHED;

/** The furthest-along episode in a season that was started and not finished, or null when the season holds
 *  no such row. Recency is deliberately not the rule: `LastPlayed` is not returned by these servers, and the
 *  question a season's button answers is 「这一季看到哪了」, which is the largest number rather than the
 *  newest write — re-watching 第 1 集 leaves the button on 第 8 集 on purpose. */
function seasonStopped(rows: LibraryItem[]): LibraryItem | null {
  let best: LibraryItem | null = null;
  for (const e of rows) {
    if (!isStoppedRow(e)) continue;
    if (!best || (e.indexNumber ?? -1) > (best.indexNumber ?? -1)) best = e;
  }
  return best;
}

/** The target for one season, read off the rows that season holds: where the viewer got to, else its first
 *  episode. Null when neither is in hand — the rows are still on their way, or this server has no files for
 *  the season — which is the caller's cue to say 播放 without naming an episode, or that nothing here opens.
 *  The 「第 N 季」 half is never printed: this button sits under a heading that has already named the season.
 *  `flagged` plays no part: a season's rows are the whole season, so membership in the 在看 query says
 *  nothing about the one on screen. */
export function seasonTarget(rows: LibraryItem[]): ResumeTarget | null {
  const stop = seasonStopped(rows);
  if (stop) return target(stop, true);
  const first = rows.find(e => PLAYABLE.includes(e.type)) || null;
  if (!first) return null;
  // A first row the server already bills as watched carries a full-runtime position, and this button opens
  // it at 0 — so it names the episode without borrowing the number.
  return { item: first, resumed: false, caption: episodePosition(null, first.indexNumber) };
}
