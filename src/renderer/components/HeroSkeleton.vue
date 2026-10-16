<script setup lang="ts">
/** The hero as it arrives, before the server has answered.
 *
 *  Both pages that own a hero handed the page wipe a rectangle painted with the page's own pale shimmer,
 *  so the transition finished onto something that looked like an empty window — the loading state read as
 *  a failure. This is the shape of what is coming instead: the hero's dark ramp with no photo in it, the
 *  plate holding whatever art the card already had on screen, and bars where the title, the meta line, the
 *  badges, the overview and the buttons will sit.
 *
 *  One component rather than two copies because the plate is a landing target: the shared-element flight
 *  aims at `.hero .art`, so the skeleton's geometry has to be the real hero's to the pixel, in both pages.
 *  The ramp is the detail page's; the lobby's is a touch lighter, and nothing can tell once the art lands. */
defineProps<{ poster?: string }>();
</script>

<template>
  <section class="hero">
    <div class="copy">
      <div v-if="poster" class="art">
        <img :src="poster" alt="" />
      </div>
      <div class="text">
        <i class="sl t"></i>
        <i class="sl l"></i>
        <span class="sls"><i class="sl b"></i><i class="sl b"></i><i class="sl b"></i></span>
        <i class="sl o"></i><i class="sl o"></i><i class="sl o"></i>
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
/* Copy of the hero plate's own box: same clamp, same 2 / 3, same rounding. */
.art {
  width: clamp(120px, 14vw, 196px);
  flex: none;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius);
  overflow: hidden;
  background: rgba(255, 255, 255, 0.07);
}
.art img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.text {
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
  background-size: 220% 100%;
  animation: sh 1.3s linear infinite;
}
.t {
  width: min(62%, 340px);
  height: 32px;
  margin-bottom: 14px;
  border-radius: 8px;
}
.l {
  width: min(44%, 220px);
  height: 13px;
  margin-bottom: 14px;
}
.sls {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}
.b {
  width: 46px;
  height: 18px;
}
.o {
  width: 100%;
  height: 13px;
  margin-bottom: 9px;
}
.o:last-child {
  width: 58%;
  margin-bottom: 0;
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
