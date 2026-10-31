import { app, BrowserWindow, powerMonitor } from 'electron';

/** When the first pass runs after a launch. Long enough that the lobby has painted and its own probe has
 *  already run — this pass exists for the pages opened later, not for the first screen. */
const FIRST_MS = 8_000;

/** Visible: ten minutes, which is the same window the main process memo already uses, so the pass always
 *  finds the memo expired and asks the server rather than itself. Hidden: three times that. */
const VISIBLE_MS = 10 * 60_000;
const HIDDEN_MS = 30 * 60_000;

/** A server that stops answering is not a server whose libraries changed: nothing is retired, and the ask
 *  comes back later instead of being retried in a tight loop. */
const BACKOFF_MS = [1, 2, 5, 10].map(minutes => minutes * 60_000);

/** Overrides for a machine under test: a five-second pass is the only way to watch a round happen. */
function envMs(name: string): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

type Ask = () => Promise<string[]>;

let ask: Ask | null = null;
let timer: NodeJS.Timeout | null = null;
let fails = 0;
let armed = false;

function stop(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

function wait(): number {
  const forced = envMs('ECHOEMBY_WATCH_MS');
  if (forced) return forced;
  const onScreen = BrowserWindow.getAllWindows().some(w => !w.isDestroyed() && w.isVisible());
  return onScreen ? VISIBLE_MS : HIDDEN_MS;
}

function schedule(ms: number): void {
  stop();
  timer = setTimeout(() => void pass(), ms);
}

async function pass(): Promise<void> {
  timer = null;
  let changed: string[] = [];
  try {
    changed = (await ask?.()) ?? [];
    fails = 0;
  } catch {
    fails += 1;
  }
  if (process.env.ECHOEMBY_CACHE_LOG) console.log('[cache] watch pass: %d moved', changed.length);
  if (changed.length) announce(changed);
  schedule(fails ? BACKOFF_MS[Math.min(fails, BACKOFF_MS.length) - 1] : wait());
}

/** Every window is told, not only the one in front: the player's own overlay window reads the same answers,
 *  and a window that is hidden right now should not come back holding rows the pass already retired. */
function announce(libraries: string[]): void {
  const at = Date.now();
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
    w.webContents.send('cache:stale', { libraries, at });
  }
}

/** 关键数据的自动更新: one small ask per library, on a schedule, so a new episode or a newly added title shows
 *  up without anyone pressing 刷新.
 *
 *  The signal is the same one the launch probe already uses — a library's newest row date — because this
 *  server has no content version to compare and its socket endpoint answers 404 (measured 2026-10-31). A
 *  round is 13 asks and 19 KB; at ten minutes that is 2.7 MB a day, which is less than one poster.
 *
 *  Three rules keep it from being noisy: a failed ask retires nothing and backs off; a pass with no change
 *  writes nothing; and a change only drops that library's answers plus the show that moved, so an unrelated
 *  page never loses its cache. */
export function startFreshWatch(asker: Ask): void {
  if (armed) return;
  armed = true;
  ask = asker;
  // Waking up is the moment a stale page is most likely: the machine slept through several rounds.
  powerMonitor.on('resume', () => {
    if (armed) schedule(envMs('ECHOEMBY_WATCH_FIRST_MS') || 2_000);
  });
  powerMonitor.on('suspend', stop);
  app.on('will-quit', () => {
    armed = false;
    stop();
  });
  schedule(envMs('ECHOEMBY_WATCH_FIRST_MS') || FIRST_MS);
}

/** Balanced with 设置's own switch: while it is off nothing is asked at all. */
export function stopFreshWatch(): void {
  armed = false;
  stop();
}
