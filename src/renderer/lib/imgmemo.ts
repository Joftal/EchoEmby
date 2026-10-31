/* Pictures this session has already painted, by URL.
 *  The card shimmer is bound to the image's own 「load」 event, so every navigation re-mounted every card and
 *  waited for every picture again — measured on 浏览: 60 cards rebuilt, 10 in view, 1500ms of shimmer on a page
 *  whose bytes all came from Chromium's HTTP disk cache. The load event is not the right question there; "have I
 *  seen this URL paint before, in this window" is. A URL carries the token, so a token change (or a server
 *  change of the item's art tag) is a new URL and is treated as unseen, which is what the shimmer is for.
 *  Capped: the first entry goes once the map is full, so a long session cannot grow this without bound. */
const MAX = 4000;
const seen = new Set<string>();

export function shownBefore(url: string): boolean {
  return !!url && seen.has(url);
}

export function noteShown(url: string): void {
  if (!url || seen.has(url)) return;
  seen.add(url);
  if (seen.size > MAX) {
    const first = seen.values().next();
    if (!first.done) seen.delete(first.value);
  }
}
