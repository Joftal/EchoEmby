/** Which row of a season's list the episode being watched is.
 *
 *  Ids answer it first. When they do not, the position number does, because the server can hold two rows
 *  for one episode: measured 2026-10-28 on OkEmby's 哺乳动物星球 S01, 第 1 集 is `324688` 「Dark」 to the
 *  shelf endpoints and `61682` 「隐秘暗夜」 to `/Shows/{series}/Episodes` — same SeriesId, same SeasonId,
 *  same IndexNumber, and only the second is ever in the list. An id-only answer therefore left a player
 *  opened from a 在看 row with no 上一集/下一集 and no 选集 cell marked.
 *
 *  `sameSeason` is the caller's guarantee that these rows all belong to the season `playing` is in. The
 *  player has it for free (it listed that one season); the panel must say no while its chip is on another.
 */
export interface EpisodeRow {
  id: string;
  indexNumber?: number;
}

export function episodeSlot(rows: EpisodeRow[], playing: EpisodeRow, sameSeason: boolean): number {
  const byId = rows.findIndex(r => r.id === playing.id);
  if (byId >= 0) return byId;
  if (!sameSeason || playing.indexNumber == null) return -1;
  return rows.findIndex(r => r.indexNumber === playing.indexNumber);
}
