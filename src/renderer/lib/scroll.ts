import { nextTick } from 'vue';
import { railHome } from './looprail';

/** Put a page back at its own beginning now that a different window owns the scroller.
 *
 *  Nothing else does it. Every 资源库 shelf is the same BrowseView instance answering a different query, and
 *  the arriving window is fetched while the outgoing one is still holding the height: the offset only ever
 *  moves as far as the new content clamps it, which is a position rather than a beginning — measured, a 在看
 *  read down to 1200px landed on 收藏 at 197px. The horizontal bands are reset with it: a new window whose
 *  list happens to be as wide as the old one would otherwise open holding the previous one's offset. A
 *  looping band keeps copies of its own end in front of its first card, so where it begins is the loop's
 *  answer rather than 0.
 *
 *  The ask waits for the patch so the reader never sees the list they are still looking at jump. */
export function resetPageScroll(el: HTMLElement | null): void {
  void nextTick(() => {
    if (!el) return;
    el.scrollTop = 0;
    // Instant, because `.track` scrolls smoothly by rule and a new window's band gliding in from where the
    // last one left it is exactly the residue this function exists to remove.
    for (const t of Array.from(el.querySelectorAll<HTMLElement>('.hrow .track'))) t.scrollTo({ left: railHome(t), behavior: 'instant' });
  });
}
