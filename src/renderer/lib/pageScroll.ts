import { ref } from 'vue';

/** Scroll events on an element do not bubble, but they do travel through the capture phase, so one
 *  listener on the document sees every box in the app. */
export const topVisible = ref(false);

const SCROLLABLE = /^(auto|scroll)$/;

function scrolls(el: HTMLElement): boolean {
  return el.scrollHeight > el.clientHeight + 8 && SCROLLABLE.test(getComputedStyle(el).overflowY);
}

/** Every page owns its own box (HomeView/Detail/Browse use .page, Settings uses .scroll, the danmaku
 *  console uses .body), and some of those boxes sit inside others that scroll their own lists. Walking
 *  up keeps the button tied to the page the reader is scrolling, not to a 300px list inside it. */
export function outermostScroller(from: EventTarget | null): HTMLElement | null {
  if (!(from instanceof HTMLElement)) return null;
  let found: HTMLElement | null = null;
  for (let el: HTMLElement | null = from; el && el !== document.body; el = el.parentElement) {
    if (scrolls(el)) found = el;
  }
  return found;
}

/** After a navigation there is no scroll event to read, so the page box has to be found: the outermost
 *  scrollable container of the page that is currently on screen. */
export function pageScroller(): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>('.page, .scroll, .body'));
  let found: HTMLElement | null = null;
  for (const el of all) {
    if (!scrolls(el)) continue;
    if (!found || found.contains(el)) found = el;
  }
  return found;
}
