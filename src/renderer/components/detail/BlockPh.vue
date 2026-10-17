<script setup lang="ts">
/** The room a block will occupy once its data arrives. `kind` picks the height measured off the real
 *  thing — the season rail lands at 370px, the file's technical block at 540px — and both of those are
 *  the tallest arrivals on the page and both land in the middle of it: without the room taken, every
 *  block below jumps down the screen while the reader is already looking at them.
 *
 *  Which of them belongs on this page is decided by the item's type, and the card that was clicked knows
 *  the type before the server answers (see lib/handoff), so this is claimed on the first frame rather
 *  than guessed at.
 *
 *  The chrome is copied from the components these stand in for rather than eyeballed. The rail carries
 *  the HScroller's own `margin-left`, its 16px top, the `--tuck` inset on its header and the 6/20 padding
 *  of its track: the row used to start at the band's left edge — 214px left of the content line, its
 *  first card sliced in half by the window — and its lines were a third of the height of the text they
 *  replaced, so a card grew 73px the moment the episodes came in. */
defineProps<{ kind: 'rail' | 'tech' }>();
</script>

<template>
  <div class="block ph" :class="kind === 'rail' ? 'hrow ph-rail' : 'ph-tech'" aria-hidden="true">
    <div class="hd"></div>
    <div v-if="kind === 'rail'" class="row">
      <div v-for="m in 4" :key="m" class="col">
        <i class="fr"></i>
        <i class="ln t1"></i>
        <i class="ln t2"></i>
        <span class="ov"><i class="ln"></i><i class="ln"></i><i class="ln w"></i></span>
      </div>
    </div>
    <template v-else>
      <i class="src"></i>
      <span class="tc"><i></i><i></i></span>
      <i class="add"></i>
    </template>
  </div>
</template>

<style scoped>
/* .flow > .block owns the margin and the arrival; these are the skeleton shapes inside. The parent's
   scoped rules stop at this component's root, so they are drawn again here rather than borrowed from
   DetailView's .skb blocks. */
.hd,
.fr,
.ln,
.src,
.tc i,
.add {
  display: block;
  border-radius: 6px;
  background: var(--shimmer);
  background-size: var(--sk-tile) 100%;
  animation: sh 1.3s linear infinite;
}
.hd {
  width: 190px;
  height: 28px;
}

/* — the season rail, laid out the way the HScroller lays out its own band — */
.ph-rail {
  min-height: 370px;
  margin-left: calc(var(--gutter) - var(--tuck) - var(--rail-x));
  padding: 16px 0 4px;
}
/* The real header is either a 34px season picker or an h2 that drags its own 14px bottom margin into the
   flex row and lands at 41.9 — never the 27.9 a plain row header measures. 34 is the modal of the six
   shows measured here: 16 + 34 + 11 + 6 + the 279 card + 20 + 4 is 370, and the rows come in at
   358.3 / 369.9 / 377.8 / 399.5. The short and the tall of those are one-line and two-line episode
   titles, which no placeholder can predict; claiming the middle is what keeps 演职员 and everything
   under it from moving when the episodes land. */
.ph-rail .hd {
  height: 34px;
  margin-left: var(--tuck);
  margin-bottom: 11px;
}
.row {
  display: flex;
  gap: 14px;
  padding: 6px var(--side) 20px var(--tuck);
  overflow: hidden;
}
.col {
  display: flex;
  flex: none;
  flex-direction: column;
  width: 280px;
}
/* The frame is the .ethumb box: 16/9 of the card's 280px, rounded like the plate. */
.fr {
  width: 280px;
  aspect-ratio: 16 / 9;
  border-radius: var(--radius);
}
/* Under it, the three parts of .einfo at their own line boxes — a 14px/1.55 title after 11px, the 13px
   meta row after 6, and the 13px/1.5 overview clamped to three lines after 4. */
.t1 {
  width: 210px;
  height: 22px;
  margin-top: 11px;
}
.t2 {
  width: 120px;
  height: 20px;
  margin-top: 6px;
}
.ov {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  height: 58.5px;
  margin-top: 4px;
}
.ov .ln {
  width: 100%;
  height: 19px;
}
.ov .w {
  width: 72%;
}

/* — the file's technical block, stacked the way that section stacks itself — */
.ph-tech {
  min-height: 540px;
}
.ph-tech .hd {
  margin-bottom: 14px;
}
.src {
  width: 210px;
  height: 111px;
  margin-bottom: 18px;
  border-radius: var(--radius);
}
.tc {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-bottom: 18px;
}
.tc i {
  width: 380px;
  height: 331px;
  border-radius: var(--radius);
}
.add {
  width: 200px;
  height: 20px;
}
</style>
