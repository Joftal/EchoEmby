import { nextTick } from 'vue';
import { railHome } from './looprail';

/** Put a page back at its own beginning now that a different title owns it.
 *
 *  Nothing else does it. A `/detail/*` → `/detail/*` switch hands the SAME component instance to the next
 *  title and keeps the outgoing one's height on screen while the new one is fetched, so the scroller never
 *  collapses and no clamp puts the offset back — measured, a page walked to 1147px landed on the next title
 *  at 74px. The horizontal bands are reset with it: a new title whose list happens to be as wide as the old
 *  one would otherwise open holding the previous show's offset. A looping band keeps copies of its own
 *  end in front of its first card, so where it begins is the loop's answer rather than 0.
 *
 *  The ask waits for the patch so the reader never sees the title they are still looking at jump. */
export function resetPageScroll(el: HTMLElement | null): void {
  void nextTick(() => {
    if (!el) return;
    el.scrollTop = 0;
    // Instant, because `.track` scrolls smoothly by rule and a new title's band gliding in from where the
    // last one left it is exactly the residue this function exists to remove.
    for (const t of Array.from(el.querySelectorAll<HTMLElement>('.hrow .track'))) t.scrollTo({ left: railHome(t), behavior: 'instant' });
  });
}
