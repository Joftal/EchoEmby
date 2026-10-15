import { session } from 'electron';

/** The app's own traffic, as far as Chromium's network stack can see it.
 *
 *  The player's download speed is already measured where it lands - mpv counts the bytes it has pulled
 *  through the loopback bridge - so this meter exists for everything that does not pass through the
 *  player: the poster grid, the episode strip, the danmaku list. Those are real bandwidth and the pill
 *  used to pretend they did not exist.
 *
 *  Electron 33's `webRequest` details carry no byte counter at all (measured: the only fields are id, url,
 *  method, timestamp, resourceType, ip, fromCache, statusLine, statusCode, responseHeaders, referrer,
 *  webContents, frame, error), so the size comes from the response's own `content-length`, which is the
 *  compressed body as it crossed the wire. Measured over a browse page and a playback: 18 of 18 poster
 *  responses carry it, 41 of 48 API ones do.
 *
 *  Only the resource types a document loads are counted. The Emby JSON API and the playback bridge both
 *  arrive as `other`, and a byte range that finishes would dump hundreds of megabytes into a three second
 *  window on top of the same bytes mpv is already reporting - so `other` is left out, and the API's
 *  ~15 KB/s goes missing with it. The two metadata clients that deliberately use node's TLS stack
 *  (imdb, csm) are outside webRequest's reach and call `addBytes` themselves.
 *
 *  Measured with both terms logged separately: while 牧神记 played at 12.5 MB/s of video, opening the
 *  浏览 grid put 264 KB/s into this term for the three seconds those posters took to land - 19 image
 *  responses completed, all 19 with a content-length, and the mpv term never moved. */
const WINDOW_MS = 3000;
const LOADED = new Set(['image', 'media', 'font', 'stylesheet', 'script', 'xhr']);

const events: { t: number; n: number }[] = [];

/** A body webRequest will never report. Zero and negative sizes are dropped, not pushed as noise. */
export function addBytes(n: number): void {
  if (n <= 0) return;
  const now = Date.now();
  while (events.length && now - events[0].t > WINDOW_MS) events.shift();
  events.push({ t: now, n });
}

/** Mean bytes per second over the last window. A fixed denominator is what makes a burst of posters show
 *  for three seconds and then fall away, instead of spiking for the one tick it took to arrive. */
export function appBytesPerSec(): number {
  const now = Date.now();
  while (events.length && now - events[0].t > WINDOW_MS) events.shift();
  let sum = 0;
  for (const e of events) sum += e.n;
  return sum / (WINDOW_MS / 1000);
}

function contentLength(headers: Record<string, string | string[]> | undefined): number {
  if (!headers) return 0;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'content-length') return Number([headers[k]].flat()[0]) || 0;
  }
  return 0;
}

export function startNetMeter(): void {
  session.defaultSession.webRequest.onCompleted(d => {
    if (!LOADED.has(d.resourceType) || d.fromCache || d.url.startsWith('file:')) return;
    addBytes(contentLength(d.responseHeaders));
  });
}
