import type { Directive } from 'vue';

/** A photo whose bytes are still in flight cannot be transitioned into: the first computed style that has
 *  any pixels in it is already the end state, so it appears in one frame. `v-reveal` holds the element at
 *  zero until `load` fires, which gives the fade something to start from. Anything the cache has already
 *  painted is skipped outright, so a url that was on screen a moment ago never flashes. */
export const vReveal: Directive<HTMLImageElement> = {
  mounted(el) {
    if (el.complete) return;
    el.classList.add('rv');
    el.addEventListener('load', () => el.classList.add('on'), { once: true });
    el.addEventListener('error', () => el.classList.remove('rv'), { once: true });
  },
};
