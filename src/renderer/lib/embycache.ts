import { reactive } from 'vue';
import type { IpcResult, LibraryItem } from '../../shared/types';

/** What the server said, kept for the rest of the look rather than re-asked.
 *
 *  The outside sources are already on disk (tmdb.json, imdb.json, …), so a title's ratings cost nothing
 *  to re-read; Emby JSON was the one layer that paid every time. Measured on 浴血黑帮: the first entry
 *  held the page on a skeleton for 2.0-2.5s of serial round trips, and leaving and coming back cost
 *  exactly the same again, because nothing between the two visits remembered anything. */
const TTL = 10 * 60_000;

interface Slot {
  /** When this answer arrived. Fixed rather than sliding: an actively read page must not keep an entry
   *  alive forever, and a library that gained an episode is answered at the next app start regardless. */
  at: number;
  value: unknown;
  /** Handed to every caller that asks while the first trip is still out, so one frame that wants the
   *  same list twice (the detail page and the player's episode panel both ask for a season) sends one
   *  request. The main process builds a fresh client per call and has no dedup of its own. */
  pending: Promise<IpcResult<unknown>> | null;
}

const slots = new Map<string, Slot>();

/** Item ids are per-server and collide across them, and every key here is built from an id — an entry
 *  that survived a switch would answer for one library with another server's item. The store owns
 *  switching and re-scopes us along with its own caches. */
let scope = '';

export function rescope(newScope: string): void {
  if (newScope === scope) return;
  const previous = scope;
  scope = newScope;
  // A real switch: those answers belong to another library.
  if (previous) {
    slots.clear();
    return;
  }
  // Nothing was known when these were taken — a deep link paints its detail page while `getConfig` is
  // still out, so the answer lands under the empty scope. The account that arrives is the one the page
  // asked about, so they are re-keyed rather than dropped: dropping them costs the page its own answer
  // and leaves a write-back with nothing to patch.
  for (const [key, slot] of [...slots]) {
    slots.delete(key);
    slots.set(newScope + key, slot);
  }
}

export function clearEmbyCache(): void {
  slots.clear();
}

/** Apply a change the server has already accepted to every copy of that item this cache holds.
 *
 *  A cached answer is a snapshot of a thing that keeps moving: the player writes a new position to the
 *  server every few seconds, and the copy taken before the film started would go on saying 已播 29 分钟
 *  for the rest of the TTL. Mutating in place is enough — the store hands the same object to every page
 *  that asks, and Vue's proxy reads through to it — so the fix is to write the number, not to re-ask. */
export function patchItem(id: string, edit: (item: LibraryItem) => void): void {
  for (const slot of slots.values()) {
    const v = slot.value;
    if (!v || typeof v !== 'object') continue;
    const list = Array.isArray(v) ? v : [v];
    for (const x of list) {
      if (x && typeof x === 'object' && (x as LibraryItem).id === id) edit(x as LibraryItem);
    }
  }
}

/** `params` is only the cache key; `load` is the request it replaces. Keep them in step — a caller that
 *  derives a second request from the same params must pass a different key or it reads the first answer. */
export function embyCached<T>(endpoint: string, params: unknown, load: () => Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  const key = `${scope}|${endpoint}|${params === undefined ? '' : JSON.stringify(params)}`;
  const hit = slots.get(key);
  if (hit?.pending) return hit.pending as Promise<IpcResult<T>>;
  if (hit && Date.now() - hit.at < TTL) return Promise.resolve({ ok: true, data: hit.value as T });

  const slot: Slot = { at: 0, value: undefined, pending: null };
  slots.set(key, slot);
  const pending = load().then(
    r => {
      slot.pending = null;
      // A failed answer is not a fact about the library, so it must not be held: the next caller asks
      // again. An entry that never succeeded is dropped rather than left to expire on its own.
      if (r.ok) {
        slot.at = Date.now();
        // Held as a reactive proxy, not as the plain JSON the bridge handed over. A page keeps this very
        // answer, and a write-back that mutates the raw object would change the data without telling the
        // page — Vue only notifies on writes made through the proxy. reactive() returns the one it has
        // already made for this target, so the page and the patch share it.
        const v = r.data;
        r.data = (v && typeof v === 'object' ? reactive(v as object) : v) as T;
        slot.value = r.data;
      } else {
        slots.delete(key);
      }
      return r as IpcResult<unknown>;
    },
    e => {
      slot.pending = null;
      slots.delete(key);
      throw e;
    },
  );
  slot.pending = pending;
  return pending as Promise<IpcResult<T>>;
}
