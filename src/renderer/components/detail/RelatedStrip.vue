<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import type { RelatedCard } from '../../lib/related';
import { begin, beginWork } from '../../lib/handoff';
import { vReveal } from '../../lib/reveal';
import HScroller from './HScroller.vue';

/** The 「相似作品」 band, and every card in it opens a page.
 *
 *  A card's corner names the server that can play it, so the band reads as a shelf of this viewer's own
 *  libraries rather than as TMDB's list — and the day two accounts are on the app, the two names are what
 *  tell a card's pages apart. A card the server has no row for prints nothing: it still opens a page, built
 *  from TMDB's record (its seasons, its episodes, its credits, its art, no file), but there is no server to
 *  name. While the ask is in flight no corner is drawn either, because a question and an absence look the
 *  same for the length of one request and only one of them is a promise. */
const props = defineProps<{ cards: RelatedCard[] }>();

/** A band drawn entirely out of the genre pool is not a set of look-alikes: it is what else this server
 *  has in the same three genres, ranked by how well they are liked. Say that instead of borrowing a
 *  promise TMDB never made. */
const title = computed(() => (props.cards.every(c => c.source === 'pool') ? '同类高分' : '相似作品'));

const router = useRouter();

/** The handoff is what lets the page arrive painted. For a library card it carries the row itself, so the
 *  hero has its name, its rating and its synopsis on the first frame; for a work the server does not hold
 *  there is no row, and the plate alone is worth handing over — same picture, same 2:3 box. */
function press(card: RelatedCard, ev: MouseEvent): void {
  const img = (ev.currentTarget as HTMLElement).querySelector('img');
  if (card.item) begin(img, card.item.id, card.item);
  beginWork(img, card.key, card.name, card.year);
  void router.push(card.to);
}
</script>

<template>
  <HScroller v-if="cards.length" class="block" :title="title" :count="cards.length">
    <button v-for="c in cards" :key="c.key" type="button" class="sim" @click="press(c, $event)">
      <div class="sposter">
        <img v-reveal v-if="c.poster" :src="c.poster" alt="" loading="lazy" decoding="async" />
        <span v-else class="ph">{{ c.name.slice(0, 1) }}</span>
        <span v-if="c.item && c.server" class="have">{{ c.server }}</span>
      </div>
      <p class="stitle">{{ c.name }}</p>
      <p class="smeta"><span v-if="c.vote" class="srate">★ {{ c.vote.toFixed(1) }}</span><span v-if="c.year">{{ c.year }}</span></p>
    </button>
  </HScroller>
</template>

<style scoped>
.sim {
  flex: none;
  width: 150px;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: transform var(--hov) var(--ease-out);
}
.sim:hover {
  transform: translateY(-3px);
}
.sim:active {
  transform: scale(0.982);
}
.sposter {
  position: relative;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg-elev-2);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
}
.sposter img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.sposter .ph {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 34px;
  font-weight: 700;
  color: var(--text-faint);
  background: linear-gradient(150deg, var(--bg), var(--bg-elev-2));
}
/* The card's own answer sits on the art rather than under the title: a line below would have to be
   reserved before the server replies, and an empty line that fills in is the layout move this band has
   been kept free of. It is not a hover prize either — it is drawn the moment the answer is in hand.
   The width is the server's name, so the box is the text's own width up to the poster's inset and an
   account with a long name loses its tail rather than pushing past the frame. */
.have {
  position: absolute;
  left: 7px;
  bottom: 7px;
  max-width: calc(100% - 14px);
  padding: 3px 7px;
  border-radius: 7px;
  font-size: 13px;
  font-weight: 650;
  color: #fff;
  background: rgba(9, 11, 18, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.28);
  backdrop-filter: blur(8px);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stitle {
  margin: 8px 0 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.smeta {
  margin: 2px 0 0;
  display: flex;
  gap: 8px;
  font-size: 13px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.smeta .srate {
  color: #b8860b;
  font-weight: 650;
}
</style>
