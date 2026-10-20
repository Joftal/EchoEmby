import { libraryWorks, type WorkKind } from './related';
import { usePlayerStore } from '../stores/player';

/** Ask for a work page's own answers while the pointer is still on the card that opens it.
 *
 *  A work page is built out of three answers the card in front of the reader never asked for: TMDB's record
 *  for the title (a recommendation card prints the number TMDB's list carried, so nothing has asked for the
 *  record itself), this server's rows for it, and its backdrops. Measured on 碧蓝之海's band, a cold click
 *  lands the hero 519 ms after the press and the episode band 1116 ms after it; the same card hovered 700 ms
 *  first lands them 27 ms and 574 ms after. The remaining wait is the season's own asks, which cannot be
 *  known before the title is chosen.
 *
 *  Hover rather than a sweep of the window: the pointer names the one title the reader is about to open, and
 *  a rail being scrolled past costs nothing. One ask per work per session — the pointer crosses the same card
 *  back and forth — and a second ask for a title already in flight joins it instead of going out again. */
const fired = new Set<string>();

function prefetchWork(kind: WorkKind, tmdbId: string): void {
  const id = String(tmdbId || '');
  if (!/^\d{1,8}$/.test(id)) return;
  const key = `${kind}:${id}`;
  // While the player is up, mpv is pulling a file through the same route these go out on.
  const player = usePlayerStore();
  if (fired.has(key) || player.session || player.busy) return;
  fired.add(key);
  void window.echoemby.meta.tmdb({ kind, tmdbId: id }).then(r => {
    // The library search runs on TMDB's name, so it can only be asked once that name has arrived. A work
    // TMDB has nothing to say about is the page's own dead end, and prefetching cannot fix it.
    const name = r?.ok && r.data ? r.data.name : '';
    if (!name) return;
    void libraryWorks(kind, id, name);
    void window.echoemby.meta.tmdbImages({ kind, tmdbId: id });
  });
}

/** The work a `/work/...` link is keyed by, read off a `kind:tmdbId` card key. */
export function prefetchKey(key: string): void {
  const [kind, id] = String(key || '').split(':');
  if (kind === 'movie' || kind === 'tv') prefetchWork(kind, id || '');
}
