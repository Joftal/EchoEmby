import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cachePath } from './root';

/** How many items keep a remembered 观看状态. An account's episode count was 82,211 on the gateway, but a
 *  row here is written only for something the app actually asked about, so this ceiling is about years of
 *  use rather than about the library. */
const MAX_ROWS = 20_000;
const DAY_MS = 86_400_000;
const KEEP_MS = 120 * DAY_MS;

interface Row {
  /** When this observation was made. The newest one wins: a stored answer older than this row gets it written
   *  back over its own UserData, which is how a cached page still shows the right 「看过」 after a playback. */
  at: number;
  u: Record<string, unknown>;
}

/** 观看状态 is the one part of an Emby answer that is both small and personal, so it is kept on its own and
 *  grafted back onto whatever the disk answered. Without this split every cached row would show the progress
 *  the page had when it was first written — a shelf of films the viewer already finished, each still parked
 *  at 0:00 — and the honest fix would be not to cache at all. */
class UserDataStore {
  private rows: Map<string, Row> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  private get file(): string {
    return cachePath('emby-cache', 'userdata.json');
  }

  private load(): Map<string, Row> {
    if (this.rows) return this.rows;
    const map = new Map<string, Row>();
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { rows?: Record<string, Row> };
      const cutoff = Date.now() - KEEP_MS;
      for (const [k, v] of Object.entries(raw?.rows ?? {})) {
        if (!v || !(v.at > cutoff) || !v.u) continue;
        map.set(k, { at: Number(v.at), u: v.u });
      }
    } catch {
      // No file yet, or one from a build that stored something else: start over.
    }
    this.rows = map;
    return map;
  }

  /** Remember every 观看状态 in a response. Called on the way out of the client, before the answer is stored,
   *  so a stored page never carries a state older than the one we have already seen. */
  harvest(userId: string, body: unknown): void {
    eachItem(body, (it) => {
      const u = (it as { UserData?: unknown }).UserData;
      if (!u || typeof u !== 'object') return;
      const id = String((it as { Id?: unknown }).Id);
      this.set(userId + ':' + id, u as Record<string, unknown>);
    });
  }

  /** Put the remembered state back on a response that came off the disk. */
  apply<T>(userId: string, body: T): T {
    const rows = this.load();
    eachItem(body, (it) => {
      const row = rows.get(userId + ':' + String((it as { Id?: unknown }).Id));
      if (!row) return;
      (it as { UserData?: unknown }).UserData = { ...(row.u as object) };
    });
    return body;
  }

  /** Items in an answer whose learned state is missing or older than `staleMs`, up to `cap`. This is the one
   *  question a cached page has to ask the server: 观看状态 changes on the other device too, and grafting a
   *  three-day-old row back onto a twelve-hour-old answer would show progress that moved on somewhere else. */
  staleIds(userId: string, body: unknown, staleMs: number, cap = 60): string[] {
    const rows = this.load();
    const ids: string[] = [];
    const now = Date.now();
    eachItem(body, (it) => {
      if (ids.length >= cap) return;
      // Only rows that carry a state are worth a round trip; a grid of names has nothing to correct.
      const u = (it as { UserData?: unknown }).UserData;
      if (!u || typeof u !== 'object') return;
      const id = String((it as { Id?: unknown }).Id);
      if (ids.includes(id)) return;
      const row = rows.get(userId + ':' + id);
      if (row && now - row.at < staleMs) return;
      ids.push(id);
    });
    return ids;
  }

  /** A local change the server has not been asked about yet: play/stop, favorite, mark played. */
  patch(userId: string, itemId: string, partial: Record<string, unknown>): void {
    const key = userId + ':' + itemId;
    const rows = this.load();
    const prev = rows.get(key);
    this.set(key, { ...(prev?.u ?? {}), ...partial }, rows);
  }

  private set(key: string, u: Record<string, unknown>, rows = this.load()): void {
    rows.set(key, { at: Date.now(), u });
    if (rows.size > MAX_ROWS) {
      const order = [...rows.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [k] of order.slice(0, rows.size - MAX_ROWS)) rows.delete(k);
    }
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 1500);
  }

  flush(): void {
    if (!this.dirty) return;
    const rows = this.rows ? Object.fromEntries(this.rows) : {};
    this.dirty = false;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const body = JSON.stringify({ v: 1, rows });
      const tmp = this.file + '.' + process.pid + '.tmp';
      writeFileSync(tmp, body, 'utf8');
      renameSync(tmp, this.file);
    } catch {
      // A profile that cannot be written still plays; it just re-learns the states on the next visit.
    }
  }

  clear(): void {
    this.rows = new Map();
    this.dirty = true;
    this.flush();
  }

  /** After the folder moved or the rows were thrown away: the next read starts from the file that is there. */
  reset(): void {
    this.rows = null;
    this.dirty = false;
  }
}

/** Items arrive either as a bare array (Items/Latest) or inside `Items`; a detail answer is a single item. */
function eachItem(body: unknown, fn: (item: object) => void): void {
  if (!body || typeof body !== 'object') return;
  const one = body as { Id?: unknown; Items?: unknown; Type?: unknown; Name?: unknown };
  if (Array.isArray(body)) {
    for (const it of body) take(it, fn);
    return;
  }
  if (Array.isArray(one.Items)) {
    for (const it of one.Items) take(it, fn);
    return;
  }
  take(one, fn);
}

function take(it: unknown, fn: (item: object) => void): void {
  if (!it || typeof it !== 'object') return;
  const item = it as { Id?: unknown; Type?: unknown; Name?: unknown };
  if (!item.Id) return;
  if (!item.Type && !item.Name) return;
  fn(item);
}

export const userDataStore = new UserDataStore();
app.on('will-quit', () => userDataStore.flush());
