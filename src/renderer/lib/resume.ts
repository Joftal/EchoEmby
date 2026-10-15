import type { LibraryItem } from '../../shared/types';
import { episodePosition, fmtElapsed, ticksToMs } from './format';

/** What a hero's play button stands for: the item it will hand the player, and the sentence under the
 *  label. Null means nothing is in progress, and the button goes back to saying 「播放」. */
export interface ResumeTarget {
  /** Not always the hero's own card: a Series resumes into the episode that stopped. */
  item: LibraryItem;
  caption: string;
}

const PLAYABLE = ['Movie', 'Episode', 'Video'];

/** Where this row stopped, from whichever of the two fields the server chose to send. Measured on the
 *  resume query: 2 of its 8 rows carry a percentage, 6 carry a position, and the position is the one an
 *  Episode ever gets — so a rule that read only the percentage would call most of them fresh. */
function stoppedMs(it: LibraryItem): number {
  const u = it.userData;
  if (!u) return 0;
  if (u.positionMs) return u.positionMs;
  const pct = Math.min(100, u.playedPercentage || 0);
  return pct > 0 ? Math.round((ticksToMs(it.runTimeTicks) * pct) / 100) : 0;
}

function target(it: LibraryItem): ResumeTarget {
  const ms = stoppedMs(it);
  const where = it.type === 'Episode' ? episodePosition(it.parentIndexNumber, it.indexNumber) : '';
  return { item: it, caption: where ? `${where} · 已播 ${fmtElapsed(ms)}` : `已播 ${fmtElapsed(ms)}` };
}

/** The row a hero's button should resume, or null when nothing has been started.
 *  `candidates` are the rows the page already holds for this title — the lobby's 继续观看 row, the
 *  detail page's season — because a Series or Season card carries no position of its own (measured: its
 *  UserData answers UnplayedItemCount and 8 rows, nothing about where the viewer stopped). */
export function resumeTarget(item: LibraryItem | null, candidates: LibraryItem[] = []): ResumeTarget | null {
  if (!item) return null;
  if (PLAYABLE.includes(item.type)) return stoppedMs(item) > 0 ? target(item) : null;
  // Three ways an episode hangs off the card above it: its series, the season it sits in, or the name
  // the gateway spells the same in both places when the ids do not come back.
  const hit = candidates.find(
    c =>
      c.type === 'Episode' &&
      stoppedMs(c) > 0 &&
      (c.seriesId === item.id || c.seasonId === item.id || (!!c.seriesName && c.seriesName === item.name)),
  );
  return hit ? target(hit) : null;
}
