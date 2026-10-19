import type { LibraryItem } from '../../shared/types';

/** What a click hands to the page it opens: the art already on screen, and the row the card was drawn from,
 *  so the page can paint before the server answers. Module state rather than a store: a handoff lives for
 *  the few hundred ms between the click and the first paint. */

/** Both ends are the same shape by construction — the hero plate is 2:3 and so is a poster card's frame —
 *  so a source that is not 2:3 is not the same picture, and the plate would crop it. A 在看 still is 16:9:
 *  those cards hand over their row, which is the same data at any shape, but not their frame, because the
 *  server's own poster is a better crop than a landscape still squeezed into a portrait box. */
const PLATE_ASPECT = 2 / 3;
const MAX_ASPECT_DIFF = 0.06;

/** The art under the pointer, kept by item id so an item opened any other way — a deep link, a rail button,
 *  the hero's own 播放 — cannot inherit somebody else's poster. */
let seedId = '';
let seedUrl = '';
/** The row behind the last click, kept apart from the art because a card with no picture is still a card
 *  with data: the 在看 row is mostly episodes whose frames never loaded, and their pages can be painted
 *  from the row just the same. */
let seedItem: LibraryItem | null = null;
/** What kind of page the last click opens, even when it cannot seed it. An Episode card opens its Season:
 *  the row is not the page's item, but it does say the page will grow a season rail, and that is the
 *  tallest thing on the page. */
let seedType = '';
/** Which page that type belongs to, kept apart from it because a deep link that follows a click must not
 *  borrow the clicked card's shape. */
let seedTypeId = '';

/** Remember the rendered art under the pointer so the page it opens can paint from it instead of waiting
 *  out a round trip. Reads the image, not the item: a card whose art never loaded has nothing to hand over. */
export function begin(img: HTMLImageElement | null | undefined, id: string, row?: LibraryItem | null): void {
  // An Episode card opens its Season page, so the row only qualifies when it is the page being opened.
  seedItem = row && row.id === id ? row : null;
  seedType = row ? (row.id === id ? row.type : row.type === 'Episode' ? 'Season' : '') : '';
  seedTypeId = row ? id : '';

  const url = img ? img.currentSrc || img.src : '';
  const r = img?.getBoundingClientRect();
  const sameShape = !!r && !!r.width && !!r.height && Math.abs(r.width / r.height - PLATE_ASPECT) / PLATE_ASPECT <= MAX_ASPECT_DIFF;
  seedId = url && sameShape ? id : '';
  seedUrl = seedId ? url : '';
}

/** The poster this item was opened from, or '' when it was not opened from a card. */
export function seedFor(id: string): string {
  return seedId === id ? seedUrl : '';
}

/** The row this item was clicked as, or null. A row carries everything the hero shows except the cast,
 *  the tagline and the file's technical block, so the page starts from it and lets the answer refine it. */
export function seedItemFor(id: string): LibraryItem | null {
  return seedItem && seedItem.id === id ? seedItem : null;
}

/** What kind of page this id was clicked open as — the clicked row's own type, or Season when an Episode
 *  card opened its parent. '' when the page was not opened by a click, which is the case that has to wait
 *  for the server to say what it is looking at. */
export function seedTypeFor(id: string): string {
  return seedTypeId === id ? seedType : '';
}

/** A recommendation the library does not hold has no row to hand over, so the card hands over what it was
 *  drawn with instead: its own frame and the two lines under it. The work page those open is keyed by an
 *  outside id and its first answer is a round trip to TMDB, which is exactly the wait this is for. */
interface WorkSeedRow {
  url: string;
  name: string;
  year: string;
}
let workSeedKey = '';
let workSeed: WorkSeedRow | null = null;

export function beginWork(img: HTMLImageElement | null | undefined, key: string, name: string, year: string): void {
  workSeedKey = key;
  workSeed = { url: img ? img.currentSrc || img.src : '', name, year };
}

/** What the card this work page was opened from printed. Null when the page was not opened from a card. */
export function workSeedFor(key: string): WorkSeedRow | null {
  return workSeedKey === key ? workSeed : null;
}

/* 播放 is a separate note from the art because it is an intent, not data, and only one page can carry it
   out: a `Series` names no media source, so the click that means "start this" has to travel through the
   page that knows which episode to open. */
let playId = '';

/** Mark the page this id opens as the one the viewer meant to start watching. */
export function beginPlay(id: string): void {
  playId = id;
}

/** True once, for the page this click opened, and only while its id is still on the way. Read at mount, so
 *  returning from the player never starts a second show. */
export function takeAutoplay(id: string): boolean {
  if (playId !== id) return false;
  playId = '';
  return true;
}
