/** Some Chinese releases append the uploader's own signature to every track name in the file, and head it
 *  with a character from the Fullwidth Forms currency block. 阿甘正传 (1994) on nyamedia is the case that
 *  brought this up: all 9 subtitle names and all 5 audio names there end in 「￡cXcY」, which the reader
 *  sees as 乱码. It is not a decode we got wrong — the gateway answers those exact codepoints
 *  (`U+FFE1 63 58 63 59`) while the rest of each name is clean UTF-8, so the file really does carry it.
 *
 *  Two things make it safe to cut at the first one: nothing in that block ever means anything inside a
 *  track name, and a tail that every track in the file shares distinguishes no track at all.
 *
 *  Both track lists carry the same tag — the server's `MediaStreams[].Title` and mpv's `track-list[].title`
 *  read the same container field — so both mapping points call this. */
const SIGNATURE_HEAD = /[\uFFE0-\uFFE6]/;
/** What the signature was glued on with, when the uploader left a separator behind. */
const DANGLING = /[\s_\-/&·.]+$/;

export const cleanTrackTitle = (raw?: string): string | undefined => {
  if (!raw) return undefined;
  const cut = raw.search(SIGNATURE_HEAD);
  if (cut < 0) return raw;
  return raw.slice(0, cut).replace(DANGLING, '') || undefined;
};
