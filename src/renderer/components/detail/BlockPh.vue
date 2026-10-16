<script setup lang="ts">
/** The room a block will occupy once its data arrives. `kind` picks the height measured off the real
 *  thing — the season rail lands at 370px, the file's technical block at 487px — and both of those are
 *  the tallest arrivals on the page and both land in the middle of it: without the room taken, every
 *  block below jumps down the screen while the reader is already looking at them.
 *
 *  Which of them belongs on this page is decided by the item's type, and the card that was clicked knows
 *  the type before the server answers (see lib/handoff), so this is claimed on the first frame rather
 *  than guessed at. */
defineProps<{ kind: 'rail' | 'tech' }>();
</script>

<template>
  <div class="block ph" :class="kind === 'rail' ? 'hrow ph-rail' : 'ph-tech'" aria-hidden="true">
    <div class="hd"></div>
    <div v-if="kind === 'rail'" class="row">
      <div v-for="m in 4" :key="m" class="col">
        <i class="fr"></i>
        <i class="ln w1"></i>
        <i class="ln w2"></i>
      </div>
    </div>
    <div v-else class="grid"><i v-for="m in 14" :key="m"></i></div>
  </div>
</template>

<style scoped>
/* .flow > .block owns the margin and the arrival; these are the shimmer pieces inside. The parent's
   scoped rules stop at this component's root, so the skeleton shapes are drawn again here rather than
   borrowed from DetailView's .skb blocks. */
.ph-rail {
  min-height: 370px;
}
.ph-tech {
  min-height: 487px;
}
.hd,
.fr,
.ln,
.grid i {
  border-radius: 6px;
  background: var(--shimmer);
  background-size: 220% 100%;
  animation: sh 1.3s linear infinite;
}
.hd {
  width: 190px;
  height: 20px;
  margin-bottom: 14px;
}
.row {
  display: flex;
  gap: 14px;
}
.col {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 10px;
}
.fr {
  width: 280px;
  aspect-ratio: 16 / 9;
  border-radius: var(--radius);
}
.ln {
  height: 15px;
}
.w1 {
  width: 210px;
}
.w2 {
  width: 120px;
  height: 13px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px 24px;
}
.grid i {
  height: 16px;
}
</style>
