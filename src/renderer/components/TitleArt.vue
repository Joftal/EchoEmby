<script setup lang="ts">
import { computed, ref, watch } from 'vue';

/** The hero title slot, shared by the lobby and the detail page. It walks a ranked list of title
 *  treatments rather than trusting one URL: TMDB's page can advertise a logo its CDN then refuses to
 *  serve, and a server-side Logo tag can outlive the file behind it. Each failure hands the slot to the
 *  next candidate, and an empty list is where the text title comes back.
 *
 *  The band is a fixed height on purpose. Measured against this library's own art, treatments run from
 *  0.8:1 stacked logos to 12:1 wordmarks, and an unbounded slot moves the metadata row under the title
 *  by tens of pixels from one slide to the next. */
const props = defineProps<{ urls: string[]; name: string }>();

const i = ref(0);
watch(
  () => props.urls.join('|'),
  () => (i.value = 0),
);
const src = computed(() => props.urls[i.value] || '');
</script>

<template>
  <div class="title">
    <img v-if="src" :key="src" :src="src" :alt="name" decoding="async" @error="i++" />
    <h1 v-else>{{ name }}</h1>
  </div>
</template>

<style scoped>
/* Three surfaces read this slot — the lobby hero, the detail hero and the player's top bar — and they
   want different geometry, so the band's size, the gap under it and the fallback type are all the
   parent's to set. The defaults are the hero's. */
.title {
  display: flex;
  align-items: flex-end;
  min-height: var(--title-h, clamp(52px, 6.8vw, 86px));
  margin-bottom: var(--title-gap, 6px);
}
.title img {
  /* A candidate the CDN refuses hands the slot to the next one; the template keys the node on its src so
     this fade plays per try instead of a hard cut from one treatment to another. */
  animation: fade-in 0.34s var(--ease) both;
  max-width: var(--title-w, min(100%, 520px));
  max-height: var(--title-h, clamp(52px, 6.8vw, 86px));
  object-fit: contain;
  object-position: left bottom;
  /* Two treatments in this library are near-black and would disappear into the hero's ramp; a hairline
     of white keys them off without becoming the bright plate the hero has been asked to avoid. */
  filter: drop-shadow(0 2px 12px rgba(6, 8, 14, 0.5)) drop-shadow(0 0 1px rgba(255, 255, 255, 0.6));
}
h1 {
  margin: 0;
  font-size: var(--title-fs, clamp(28px, 3.6vw, 44px));
  font-weight: 700;
  line-height: 1.12;
  letter-spacing: -0.5px;
  color: #fff;
  text-shadow: 0 2px 18px rgba(0, 0, 0, 0.4);
  display: -webkit-box;
  -webkit-line-clamp: var(--title-clamp, 2);
  line-clamp: var(--title-clamp, 2);
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
