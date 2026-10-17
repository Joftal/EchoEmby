<script setup lang="ts">
import { computed } from 'vue';

/** The hero as it arrives, before the server has answered.
 *
 *  Both pages that own a hero handed the swap a rectangle painted with the page's own pale shimmer,
 *  so the transition finished onto something that looked like an empty window — the loading state read as
 *  a failure. This is the shape of what is coming instead: the hero's dark ramp with no photo in it, the
 *  plate holding whatever art the card already had on screen, and bars where the title, the meta line, the
 *  badges, the overview and the buttons will sit.
 *
 *  One component rather than two copies because this plate has to be the hero's box to the pixel: the real
 *  hero lands in the same slot, and a few px of difference between the two is a jump you can see the moment
 *  the transition ends. The one thing the two pages do not share is the row order: the lobby puts its score
 *  strip under the synopsis, the detail page puts it above, and the copy column is pinned to the bottom of
 *  the box, so drawing the wrong order parks the badges a hundred px from where they land.
 *  The ramp is the detail page's; the lobby's is a touch lighter, and nothing can tell once the art lands. */
const props = withDefaults(defineProps<{ poster?: string; layout?: 'detail' | 'lobby' }>(), { layout: 'detail' });
/** The lobby's synopsis is clamped to two lines and the detail page's to four; the paragraph draws the
 *  number of bars the page it stands in for will really fill. */
const lines = computed(() => (props.layout === 'lobby' ? 2 : 4));
</script>

<template>
  <section class="hero" :class="{ lobby: layout === 'lobby' }">
    <div class="copy">
      <div class="art">
        <img v-if="poster" :src="poster" alt="" />
      </div>
      <div class="text">
        <i class="sl t"></i>
        <i class="sl l"></i>
        <span class="sls"><i class="sl b"></i><i class="sl b"></i><i class="sl b"></i></span>
        <span class="ov"><i v-for="n in lines" :key="n" class="sl o"></i></span>
      </div>
      <div class="cta">
        <i class="sl p"></i>
        <i class="sl ic"></i>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hero {
  position: relative;
  /* The real hero's box, its gutter and its rail tween, so the rows below do not move when this one is
     replaced. */
  height: clamp(460px, 61vh, 620px);
  margin-left: var(--gutter);
  margin-bottom: 4px;
  overflow: hidden;
  transition: margin-left var(--rail-dur) var(--rail-ease);
  background: linear-gradient(
    to top,
    rgba(6, 8, 14, 0.86) 0,
    rgba(6, 8, 14, 0.82) 120px,
    rgba(6, 8, 14, 0.5) max(240px, 42%),
    rgba(6, 8, 14, 0.12) max(400px, 72%),
    transparent 100%
  );
}
.copy {
  position: absolute;
  left: 32px;
  right: var(--side);
  bottom: 28px;
  display: flex;
  align-items: flex-end;
  gap: 20px;
}
/* Copy of the hero plate's own box: same height clamp, same 2 / 3, same rounding. The real hero takes this
   slot at the end of the transition, so any difference between the two boxes is a jump you can see.
   It is drawn whether or not the art is in hand: the copy column is laid out left-to-right beside it, so a
   placeholder that skipped the plate started its text 270px further left than the hero that replaced it —
   which is exactly what a cold deep link does, because nothing is cached for an item nobody clicked. */
.art {
  height: clamp(348px, 46vh, 430px);
  flex: none;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: var(--shadow);
  background-image: var(--shimmer-dark);
  background-size: var(--sk-tile) 100%;
  animation: sh 1.3s linear infinite;
}
.art img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.text {
  /* A column rather than the block the real copy sits in, because `order` is the only way to follow the
     lobby's row order without a second template. Flex ends margin collapsing, so every gap below is
     written out instead of borrowed from its neighbour. */
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  max-width: 640px;
}
.cta {
  flex: none;
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
}
.sl {
  display: block;
  border-radius: var(--r-badge);
  /* Light-on-dark: the page's pale sweep is invisible against this band, and a bar you cannot see reads
     as nothing loading. */
  background-image: var(--shimmer-dark);
  background-size: var(--sk-tile) 100%;
  animation: sh 1.3s linear infinite;
}
/* The four rows, measured off the real hero at this window: the title band's 86px is a floor rather than
   a bar (the art sits on the band's bottom edge, so a slimmer bar lands on the same line), the meta line
   is a 13.5px/1.55 box, the score strip draws at 20px, and the overview is a 14px/1.65 paragraph clamped
   to four lines = 92.4px. The gaps are the real ones — 6 under the band, 12 under the meta line, 14 under
   the strip, 18 under the paragraph.
   It matters that they add up, not just that they look right: `.copy` aligns its columns on their bottom
   edge, so every pixel the paragraph comes short moves the score row — the one the reader is looking at —
   down by the same amount. Three 13px bars stood in for a 92.4px paragraph and put the badges 51px below
   where they land. */
.t {
  width: min(62%, 340px);
  height: 40px;
  margin-bottom: 6px;
  border-radius: 8px;
}
.l {
  width: min(44%, 220px);
  height: 21px;
  margin-bottom: 12px;
}
.sls {
  display: flex;
  gap: 8px;
  height: 20px;
  margin-bottom: 14px;
}
.b {
  width: 46px;
  height: 20px;
}
.ov {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  height: 92.4px;
  margin-bottom: 18px;
}
.o {
  width: 100%;
  height: 15px;
}
.o:last-child {
  width: 58%;
}
.p {
  width: 120px;
  height: 48px;
  border-radius: 24px;
}
.ic {
  width: 44px;
  height: 44px;
  border-radius: 50%;
}
/* The lobby's copy, measured off the hero it replaces. Its score strip is the last row and 26 tall (the
   platform logos, not the detail page's bare 20 rating), its synopsis is two lines of 13.5/1.62 = 43.7, its
   meta row takes the 10px gap that the real title band's own 6px collapses up into, and its reading column
   stops at 560 instead of 640. The box is pinned at its bottom, so those four numbers put every row on top
   of its bar; the title keeps a 40px bar because the band it stands in for is 86 tall and rides its own
   bottom edge, and the bar rides the same edge. */
.lobby .text {
  max-width: 560px;
}
.lobby .t {
  margin-bottom: 10px;
}
.lobby .l {
  height: 20px;
  margin-bottom: 8px;
}
.lobby .ov {
  order: 3;
  height: 43.7px;
  margin-bottom: 10px;
}
.lobby .sls {
  order: 4;
  align-items: center;
  height: 26px;
  margin-bottom: 0;
}
.lobby .ic {
  width: 92px;
  height: 38px;
  border-radius: 19px;
}
/* The lobby shortens its synopsis to one line below a 700px-tall window, and the placeholder has to follow
   it: that paragraph sits above the pinned strip, so one still drawn two lines tall parks the strip 22px
   under where it lands. */
@media (max-height: 700px) {
  .lobby .ov {
    height: calc(1 * 13.5px * 1.62);
  }
  .lobby .ov .o:last-child {
    display: none;
  }
}
/* The way out, when the real hero arrives: this band stays where it was and fades, so the swap is a
   dissolve instead of a cut. It has to leave the flow or the two heroes stack and the first row gets
   pushed down and snapped back a beat later.
   Both rules name `.hero` as well: a child component's root carries the parent's scope id, so
   DetailView's own `.hero` rule reaches in here and would outrank a bare class on the transition. */
.hero.hero-swap-leave-active {
  position: absolute;
  top: 0;
  left: var(--gutter);
  right: 0;
  margin-left: 0;
  z-index: 2;
  pointer-events: none;
  transition: opacity 0.5s var(--ease);
}
.hero.hero-swap-leave-to {
  opacity: 0;
}
</style>
