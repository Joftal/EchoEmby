import { nextTick } from 'vue';

/** Put a page back at its own beginning now that a different title owns it.
 *
 *  Nothing else does it. A `/detail/*` → `/detail/*` switch hands the SAME component instance to the next
 *  title and keeps the outgoing one's height on screen while the new one is fetched, so the scroller never
 *  collapses and no clamp puts the offset back — measured, a page walked to 1147px landed on the next title
 *  at 74px. The horizontal bands are reset with it: a new title whose list happens to be as wide as the old
 *  one would otherwise open holding the previous show's offset.
 *
 *  The ask waits for the patch so the reader never sees the title they are still looking at jump. */
export function resetPageScroll(el: HTMLElement | null): void {
  void nextTick(() => {
    if (!el) return;
    el.scrollTop = 0;
    for (const t of Array.from(el.querySelectorAll<HTMLElement>('.hrow .track'))) t.scrollLeft = 0;
  });
}
