import type { LibraryItem } from '../../shared/types';

/** What a click hands to the page it opens: the art that flies into the hero's plate, and the row the card
 *  was drawn from so the page can paint from it before the server answers. Module state rather than a
 *  store: a handoff lives for the few hundred ms between the click and the flight. */
export interface Handoff {
  id: string;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
}

/** Both ends of a flight are the same shape by construction — the plate is 2:3 and so is a poster card's
 *  frame — so a source that is not 2:3 is not the same picture at another size, and no transform reaches it
 *  without stretching. A 在看 still is 16:9; the flight used to force the two together by animating
 *  object-position, a main-thread property measured at 11 frozen frames out of 24 with an 84ms worst frame.
 *  Those cards now open on the page move alone, which is why this file decides it and not the clone. */
const PLATE_ASPECT = 2 / 3;
const MAX_ASPECT_DIFF = 0.06;

let pending: Handoff | null = null;
/** The last art handed over, kept by item id. FlyArt consumes `pending` on the navigation that follows the
 *  click, and the detail page has to seed its plate from the same picture — reading `pending` there would
 *  race that consume, and an item opened without a click must not inherit somebody else's poster. */
let seed: Handoff | null = null;
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

/** Remember the rendered art under the pointer so the page it opens into can grow out of it. Reads the
 *  image, not the item: a card whose art never loaded has nothing to hand over. */
export function begin(img: HTMLImageElement | null | undefined, id: string, row?: LibraryItem | null): void {
  // An Episode card opens its Season page, so the row only qualifies when it is the page being opened.
  seedItem = row && row.id === id ? row : null;
  seedType = row ? (row.id === id ? row.type : row.type === 'Episode' ? 'Season' : '') : '';
  seedTypeId = row ? id : '';
  const r = img?.getBoundingClientRect();
  if (!img || !r || !r.width || !r.height) {
    pending = null;
    return;
  }
  if (Math.abs(r.width / r.height - PLATE_ASPECT) / PLATE_ASPECT > MAX_ASPECT_DIFF) {
    pending = null;
    return;
  }
  // The radius is the frame's, not the image's: the frame is what clips the art, so it is the corner the
  // clone has to start with and lose on the way to the plate's own rounding.
  const frame = img.parentElement || img;
  pending = {
    id,
    url: img.currentSrc || img.src,
    x: r.left,
    y: r.top,
    w: r.width,
    h: r.height,
    radius: parseFloat(getComputedStyle(frame).borderRadius) || 0,
  };
  seed = pending;
}

export function take(): Handoff | null {
  const p = pending;
  pending = null;
  return p;
}

/** The poster this item was opened from, or '' when it was not opened from a card. */
export function seedFor(id: string): string {
  return seed && seed.id === id ? seed.url : '';
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
