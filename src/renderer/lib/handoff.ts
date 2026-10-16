/** The clicked card's art flies into the detail hero. Module state rather than a store: a handoff lives
 *  for the few hundred ms between the click and the flight and nothing needs to react to it. */
export interface Handoff {
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
  pos: string;
}

let pending: Handoff | null = null;

/** Remember the art under the pointer so the page it opens into can grow out of it. Reads the rendered
 *  image, not the item: a card whose art never loaded has nothing to hand over. */
export function begin(root: HTMLElement | null): void {
  const img = root?.querySelector<HTMLImageElement>('img.show');
  if (!img) {
    pending = null;
    return;
  }
  const r = img.getBoundingClientRect();
  if (!r.width || !r.height) {
    pending = null;
    return;
  }
  // The radius is the frame's, not the image's: the frame is what clips the art, so it is the corner
  // the clone has to start with and lose on the way to the hero's square edge.
  const frame = img.parentElement || img;
  pending = {
    url: img.src,
    x: r.left,
    y: r.top,
    w: r.width,
    h: r.height,
    radius: parseFloat(getComputedStyle(frame).borderRadius) || 0,
    pos: getComputedStyle(img).objectPosition,
  };
}

export function take(): Handoff | null {
  const p = pending;
  pending = null;
  return p;
}
