import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';

/**
 * Places one card above the button that called it, and keeps it there while the card changes size.
 *
 * The card hangs from its own bottom edge, `GAP` + the arrow above the trigger, and is centred on the
 * trigger's middle - then pushed back inside the window when the button sits near an edge, which is most
 * of them: measured at the default 1236x660 the eight entries run from x=759 to x=1112, so a 460px card
 * centred on the last one would hang 194px off-screen. The arrow keeps pointing at the button either way,
 * which is what makes the offset read as deliberate rather than broken.
 *
 * Position is a transform and size is a scale, both measured from `offsetWidth`/`offsetHeight`. That
 * choice is the whole reason this file is short: those two properties report the layout box and ignore any
 * transform on the element, so a size can be read while a resize animation is still running. Animating
 * `width`/`height` instead would make the ResizeObserver fire on every frame of its own animation and the
 * next measurement would be a number the previous animation invented.
 */
const GAP = 7;
/** The arrow is part of the sheet, below the card, so the card floats one arrow-height over the button. */
const ARROW = 8;
const GUTTER = 12;
/** The card must not climb over the title strip at the top of the picture. */
const TOP_KEEPOUT = 54;
/** Below this the card has nowhere useful to scroll, so the padding and the arrow eat the rest. */
const MIN_ROOM = 96;

const clamp = (lo: number, v: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function useSheetGeometry(cardEl: Ref<HTMLElement | null>, anchor: Ref<{ x: number; top: number } | null>, onSize?: () => void) {
  /** Where the sheet sits: right and up from the window's bottom-left corner, which is its anchored corner. */
  const x = ref(0);
  const y = ref(0);
  const arrowX = ref(0);
  const room = ref(400);
  let observer: ResizeObserver | null = null;
  let was = { w: 0, h: 0 };

  function place(): void {
    const a = anchor.value;
    const el = cardEl.value;
    if (!a || !el) return;
    const w = el.offsetWidth;
    room.value = Math.round(Math.max(MIN_ROOM, a.top - GAP - ARROW - TOP_KEEPOUT));
    x.value = clamp(GUTTER, Math.round(a.x - w / 2), Math.max(GUTTER, window.innerWidth - GUTTER - w));
    y.value = Math.round(window.innerHeight - a.top + GAP);
    arrowX.value = clamp(18, Math.round(a.x - x.value), Math.max(18, w - 18));
  }

  /** Growing and shrinking both travel out of the arrow, which is where the card came from. The first
   *  measurement is not a change, and a box that measured 0 is the card appearing at all - that has its
   *  own enter transition.
   *
   *  Each axis is clamped to a fifth of stretch either way: between two menus of different shape
   *  (272x487 to 440x244 measured) the true ratio started the morph at 0.62x by 2.0x, and rows that
   *  spent a fifth of a second twice as tall as they are is what made switching menus look jumpy. The
   *  clamped settle plus the list's own fade-in reads as one move instead. */
  function morph(): void {
    const el = cardEl.value;
    if (!el) return;
    const next = { w: el.offsetWidth, h: el.offsetHeight };
    const prev = was;
    was = next;
    if (prev.w <= 0 || prev.h <= 0 || (prev.w === next.w && prev.h === next.h)) return;
    const sx = clamp(0.8, prev.w / next.w, 1.2);
    const sy = clamp(0.8, prev.h / next.h, 1.2);
    el.animate([{ transform: `scale(${sx}, ${sy})` }, { transform: 'none' }], {
      duration: 260,
      easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
    });
  }

  function track(): void {
    const el = cardEl.value;
    if (!el || observer) return;
    was = { w: el.offsetWidth, h: el.offsetHeight };
    observer = new ResizeObserver(() => {
      // The card resizing is the only reliable signal that its content changed, and the fade that says
      // 「there is more below」 has to be re-decided at the same moment or it outlives the overflow.
      onSize?.();
      morph();
      place();
    });
    observer.observe(el);
  }

  onMounted(() => {
    track();
    place();
  });
  onBeforeUnmount(() => observer?.disconnect());
  watch(anchor, () => {
    track();
    place();
  });

  return { x, y, arrowX, room, place };
}
