import type { LibraryItem } from '../../shared/types';
import { episodePosition, seenLabel, stoppedAtMs } from './format';

/** What a hero's play button stands for: the item it will hand the player, and the sentence under the
 *  label. Null means nothing is in progress, and the button goes back to saying 「播放」. */
export interface ResumeTarget {
  /** Not always the hero's own card: a Series resumes into the episode that stopped. */
  item: LibraryItem;
  caption: string;
}

const PLAYABLE = ['Movie', 'Episode', 'Video'];

/** How far in, in the words the hero has room for: 「第 1 季 · 第 2 集 · 看到 27:06」. The same
 *  `seenLabel` the episode card's own chip prints, so one episode cannot wear two of them. */
function target(it: LibraryItem): ResumeTarget {
  const where = it.type === 'Episode' ? episodePosition(it.parentIndexNumber, it.indexNumber) : '';
  const seen = seenLabel(it.userData, it.runTimeTicks);
  return { item: it, caption: where ? `${where} · ${seen}` : seen };
}

/** The row a hero's button should resume, or null when nothing has been started.
 *  `candidates` are the rows the page already holds for this title — the lobby's 继续观看 row, the
 *  detail page's season — because a Series or Season card carries no position of its own (measured: its
 *  UserData answers UnplayedItemCount and 8 rows, nothing about where the viewer stopped). */
export function resumeTarget(item: LibraryItem | null, candidates: LibraryItem[] = []): ResumeTarget | null {
  if (!item) return null;
  if (PLAYABLE.includes(item.type)) return stoppedAtMs(item.userData, item.runTimeTicks) > 0 ? target(item) : null;
  // Three ways an episode hangs off the card above it: its series, the season it sits in, or the name
  // the gateway spells the same in both places when the ids do not come back.
  const hit = candidates.find(
    c =>
      c.type === 'Episode' &&
      stoppedAtMs(c.userData, c.runTimeTicks) > 0 &&
      (c.seriesId === item.id || c.seasonId === item.id || (!!c.seriesName && c.seriesName === item.name)),
  );
  return hit ? target(hit) : null;
}
