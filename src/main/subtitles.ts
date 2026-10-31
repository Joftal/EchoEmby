/**
 * 本地字幕 — the subtitle files a viewer brings themselves.
 *
 * Two jobs live here, and both are about not trusting mpv to remember anything. The first is storage: a file
 * picked out of some folder on disk is copied under `userData/subtitles` and remembered against the item, so
 * the next viewing of that episode has it back without the picker. A copy rather than a link because the
 * original is usually on a removable drive, inside a download folder that gets cleaned, or itself named in a
 * way Windows refuses to reopen a week later.
 *
 * The second job is the position control. Most subtitle files say where a line goes in their own coordinates,
 * and for those mpv's `sub-pos` is a no-op (measured: a `\pos` line ignored `sub-pos=70` and also ignored
 * `sub-ass-force-margins=yes`, byte-identical screenshots). So moving such a subtitle means rewriting the
 * numbers in the file and handing the result to mpv again — that is `shiftedFile`.
 */
import { app } from 'electron';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

/** A picture track: mpv renders it, but only as an *external file* — `sub-add` answers 「error running
 *  command」 for a `.sup` (measured 2026-10-31), while `external-files` + a load lists it as
 *  `hdmv_pgs_subtitle`, ext:true. Everything else is text and travels through `sub-add` as before. */
export const isBitmap = (ext: string): boolean => ext === 'sup' || ext === 'pgs';

export interface LocalSubtitle {
  /** What the panel prints: the file's own name without its extension. */
  name: string;
  /** Absolute path of our copy. */
  file: string;
  ext: string;
  /** Picture, not text: it reaches mpv as an external file rather than through `sub-add`. */
  bitmap: boolean;
  /** True when the file writes its own coordinates, which is what makes the height control useless on it. */
  positioned: boolean;
  /** How far the copy has already been moved, in script pixels. Kept so 10px + 10px is 20, not 10. */
  dx: number;
  dy: number;
}

type Index = Record<string, LocalSubtitle>;

/** `accountId:itemId`. The id alone is not enough: the same number is a different film on another server. */
export const subtitleKey = (accountId: string, itemId: string): string => accountId + ':' + itemId;

const root = (): string => join(app.getPath('userData'), 'subtitles');
const indexFile = (): string => join(root(), 'index.json');

/** One write at a time: two imports finishing together would otherwise read the same index and the second
 *  would drop the first. */
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(job: () => Promise<T>): Promise<T> => {
  const next = queue.then(job, job);
  queue = next.then(() => undefined, () => undefined);
  return next;
};

async function readIndex(): Promise<Index> {
  try {
    const raw = JSON.parse(await readFile(indexFile(), 'utf8'));
    if (!raw || typeof raw !== 'object') return {};
    const out: Index = {};
    for (const [k, v] of Object.entries<any>(raw)) {
      if (v && typeof v.file === 'string' && typeof v.name === 'string') {
        out[k] = {
          name: v.name,
          file: v.file,
          ext: String(v.ext || extname(v.file).slice(1)).toLowerCase(),
          bitmap: isBitmap(String(v.ext || extname(v.file).slice(1)).toLowerCase()),
          positioned: !!v.positioned,
          dx: Number(v.dx) || 0,
          dy: Number(v.dy) || 0,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

async function writeIndex(index: Index): Promise<void> {
  await mkdir(root(), { recursive: true });
  await writeFile(indexFile(), JSON.stringify(index, null, 2), 'utf8');
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** The file this item was last given, if it is still on disk. A remembered path whose file the viewer deleted
 *  out from under us is worse than no memory: the menu would offer a row that fails when clicked. */
export async function recall(accountId: string, itemId: string): Promise<LocalSubtitle | null> {
  const index = await readIndex();
  const hit = index[subtitleKey(accountId, itemId)];
  if (!hit) return null;
  if (!(await exists(hit.file))) return null;
  return hit;
}

export async function remember(accountId: string, itemId: string, entry: LocalSubtitle): Promise<void> {
  await serial(async () => {
    const index = await readIndex();
    index[subtitleKey(accountId, itemId)] = entry;
    await writeIndex(index);
  });
}

export async function forget(accountId: string, itemId: string): Promise<void> {
  await serial(async () => {
    const index = await readIndex();
    delete index[subtitleKey(accountId, itemId)];
    await writeIndex(index);
  });
}

/** True when the file decides where its lines land. Text formats only: a bitmap track has no coordinates to
 *  read, and mpv scales it with `sub-scale` but its position is the author's. */
export function positioned(ext: string, text: string): boolean {
  if (ext !== 'ass' && ext !== 'ssa') return false;
  return /\\(?:pos|move)\s*\(/i.test(text);
}

/** Copy the picked file in and describe it. The copy keeps a prefix of the original name because a folder of
 *  `a1b2c3d4.ass` files is unreadable when something goes wrong. */
export async function importFile(source: string): Promise<LocalSubtitle> {
  const ext = extname(source).slice(1).toLowerCase();
  // No whitelist: the picker shows every file in the folder (a viewer's subtitle often sits beside an .mkv),
  // so what cannot be read is answered when mpv refuses it, which names the real problem instead of a guess at
  // the extension.
  if (!ext) throw new Error('这个文件没有扩展名，看不出是不是字幕');
  const name = basename(source, extname(source));
  const safe = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'subtitle';
  const hash = createHash('sha1').update(source + '|' + Date.now()).digest('hex').slice(0, 8);
  await mkdir(root(), { recursive: true });
  const file = join(root(), hash + '-' + safe + '.' + ext);
  await copyFile(source, file);
  let isPositioned = false;
  if (ext === 'ass' || ext === 'ssa') {
    isPositioned = positioned(ext, await readFile(file, 'utf8'));
  }
  return { name, file, ext, bitmap: isBitmap(ext), positioned: isPositioned, dx: 0, dy: 0 };
}

/** Shift one override block's coordinates. `\move` carries six numbers, the last two a duration, so only its
 *  first four move. A vector `\clip(m 0 0 l …)` is translated pair by pair, because the mask has to travel
 *  with the text it hides — moving `\pos` alone would push the sign out of its own hole. */
function shiftArgs(tag: string, args: string, dx: number, dy: number): string | null {
  const parts = args.split(',').map((s) => s.trim());
  const nums = parts.map((s) => (/^-?\d+(?:\.\d+)?$/.test(s) ? Number(s) : NaN));
  if (nums.some((n) => Number.isNaN(n))) {
    return /^i?clip$/i.test(tag) ? shiftPath(args, dx, dy) : null;
  }
  const movable = tag === 'move' ? 4 : nums.length === 4 ? 4 : 2;
  if (nums.length < movable) return null;
  const out = nums.map((n, i) => {
    if (i >= movable) return parts[i];
    const moved = n + (i % 2 === 0 ? dx : dy);
    return String(Math.round(moved * 100) / 100);
  });
  return out.join(',');
}

/** Translate an ASS vector path. Every number in `m`/`l`/`n`/`b` is part of a coordinate pair, so the only
 *  thing to check is that each command ends on a whole pair; anything else (arcs, malformed groups) is
 *  refused instead of guessed at, and the caller leaves that argument untouched. */
function shiftPath(args: string, dx: number, dy: number): string | null {
  const tokens = args.match(/[a-z]|-?\d+(?:\.\d+)?/gi);
  if (!tokens || !tokens.length) return null;
  const out: string[] = [];
  let seen = 0; // numbers since the last command, to check the trailing pair
  for (const tok of tokens) {
    if (/^[a-z]$/i.test(tok)) {
      const c = tok.toLowerCase();
      if (c !== 'm' && c !== 'l' && c !== 'n' && c !== 'b') return null;
      if (seen % 2 !== 0) return null;
      seen = 0;
      out.push(tok);
      continue;
    }
    out.push(String(Math.round((Number(tok) + (seen % 2 === 0 ? dx : dy)) * 100) / 100));
    seen += 1;
  }
  if (seen % 2 !== 0) return null;
  return out.join(' ');
}

/** Rewrite `\pos`/`\move`/`\org`/`\clip` inside a file that writes its own coordinates. Returns the new
 *  text and how many clip paths were refused (those lines still move through their own `\pos`). */
export function shiftAss(text: string, dx: number, dy: number): { text: string; skipped: number } {
  let skipped = 0;
  const out = text.split(/\r?\n/).map((line) => {
    if (!/^\s*Dialogue\s*:/i.test(line)) return line;
    return line.replace(/\{([^}]*)\}/g, (_m, body: string) => {
      const shifted = body.replace(/\\(pos|org|move|iclip|clip)\s*\(([^)]*)\)/gi, (whole, tag: string, args: string) => {
        const next = shiftArgs(tag.toLowerCase(), args, dx, dy);
        if (next === null) {
          if (/^i?clip$/i.test(tag)) skipped += 1;
          return whole;
        }
        return '\\' + tag + '(' + next + ')';
      });
      return '{' + shifted + '}';
    });
  });
  return { text: out.join('\n'), skipped };
}

/** The copy with this shift baked in, written once per offset so dragging around does not litter the folder.
 *  Only formats that carry coordinates get here; an SRT is returned untouched (mpv's height control covers it). */
export async function shiftedFile(entry: LocalSubtitle, dx: number, dy: number): Promise<string> {
  if ((entry.ext !== 'ass' && entry.ext !== 'ssa') || (!dx && !dy)) return entry.file;
  const tag = (dx < 0 ? 'm' : '') + Math.abs(dx) + '_' + (dy < 0 ? 'm' : '') + Math.abs(dy);
  const file = entry.file.replace(/\.(ass|ssa)$/i, '-' + tag + '.ass');
  if (await exists(file)) return file;
  const { text } = shiftAss(await readFile(entry.file, 'utf8'), dx, dy);
  await writeFile(file, text, 'utf8');
  return file;
}
