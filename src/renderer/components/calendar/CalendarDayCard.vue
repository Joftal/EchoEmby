<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import type { CalendarSlot } from '../../../shared/types';
import { episodeName } from '../../lib/format';
import { genreLabel } from '../../lib/genres';
import { poolColor } from '../../lib/pools';
import { vReveal } from '../../lib/reveal';

/** One update on the 追剧日历's day timeline: the work's poster on the left, the show and its kind beside
 *  it with the episode's own name under them, and the season's position on the bottom line with a bar that
 *  measures the same thing the numbers next to it count.
 *
 *  Every field here is already in `calendar.json` — the two TMDB replies that date a show also carry its
 *  poster, year, genres and season size — so a card costs no request of its own.
 *
 *  The bottom line states what it knows and stays quiet about what it does not: a clock is printed for a
 *  day that has passed too, because 「昨天 11:00」 is the answer to 「我是不是错过了」, and a 跳票 sentence
 *  rides beside the clock rather than behind it — Bilibili gives both for one row, and the pair is the
 *  useful reading (it was due at 11:00 and it slipped). */
const props = defineProps<{ slot: CalendarSlot; past: boolean }>();

const router = useRouter();

/** The work's poster, at the one size the app asks posters at: `w500` is what 收藏 and 首页 put on the same
 *  picture, so a title that has already been on either screen paints this card from their cache. */
const art = computed(() => (props.slot.poster ? `https://image.tmdb.org/t/p/w500${props.slot.poster}` : ''));
const to = computed(() => (props.slot.seriesId ? `/detail/${props.slot.seriesId}` : ''));
const meta = computed(() => {
  const s = props.slot;
  // The same fold every other genre line in the app uses: TMDB's `language=zh-CN` reply leaves
  // 「Sci-Fi & Fantasy」 in English, and the card would otherwise print half a sentence in two languages.
  const g = s.genres.map(genreLabel).slice(0, 3).join(', ');
  return [s.year ? `${s.year}` : '', g].filter(Boolean).join('  ');
});
const tail = computed(() =>
  episodeName({ episode: props.slot.episode, season: props.slot.season, seriesName: props.slot.name }, props.slot.episodeName),
);
/** The bar's subject is the season named beside it, so it is drawn only when that season has a count. A
 *  30-episode season gets one segment each; past that the segments fall under a device pixel and the bar
 *  is a fill, which is the same statement at a size the eye can actually read. */
const segs = computed(() => {
  const t = props.slot.seasonTotal;
  return t >= 2 && t <= 30 ? t : 0;
});
const pct = computed(() => {
  const t = props.slot.seasonTotal;
  if (!t) return 0;
  return Math.max(0, Math.min(100, (props.slot.episode / t) * 100));
});

function open(): void {
  if (to.value) void router.push(to.value);
}
</script>

<template>
  <component :is="to ? 'button' : 'div'" class="slot" :class="{ go: !!to, was: past }" @click="open">
    <span class="top">
      <span class="calpo" :class="{ ph: !art }">
        <img v-if="art" v-reveal :src="art" alt="" width="92" height="138" decoding="async" />
        <template v-else>{{ slot.name.slice(0, 1) }}</template>
      </span>
      <span class="bd">
        <b class="nm"><i class="dot" :style="{ background: poolColor(slot.pool) }"></i>{{ slot.name }}</b>
        <i v-if="meta" class="kind">{{ meta }}</i>
        <em v-if="tail" class="epn">{{ tail }}</em>

        <span class="foot">
          <span class="pos">
            第{{ slot.season }}季
            <b v-if="slot.seasonTotal">集<u>{{ slot.episode }}</u>/{{ slot.seasonTotal }}</b>
            <b v-else>集 {{ slot.episode }}</b>
          </span>
          <span v-if="segs" class="bar seg">
            <i v-for="n in segs" :key="n" :class="{ f: n <= slot.episode }"></i>
          </span>
          <span v-else-if="slot.seasonTotal" class="bar fill"><i :style="{ width: pct + '%' }"></i></span>
          <span v-if="slot.clock" class="clk"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15.5V11a6 6 0 1 0-12 0v4.5L4.5 18h15zM10 21h4" /></svg>{{ slot.clock }}</span>
          <span v-if="slot.delay" class="dly">{{ slot.delay }}</span>
        </span>
      </span>
    </span>
  </component>
</template>

<style scoped>
.slot {
  display: flex;
  flex-direction: column;
  /* A `<button>`'s UA sheet gives its flex items a cross-size of their own, which is how the header row
     measured 358 px inside a 326 px card and the bar below it 24 px instead of the free 120. Stretched,
     the row is the card. */
  align-items: stretch;
  width: 100%;
  padding: 10px;
  border-radius: var(--r-tile);
  text-align: left;
  color: inherit;
  background: var(--bg-elev);
  border: 1px solid var(--line);
  transition: background var(--hov) var(--ease), border-color var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
button.slot:hover {
  background: var(--bg-elev-2);
  border-color: var(--line-strong);
}
button.slot:active {
  transform: scale(0.99);
  transition-duration: 0.1s;
}
/* Yesterday's episode is a record, not a notification: same card, one step down in weight, so the eye
   lands on the ones still to come. */
.slot.was {
  background: none;
  border-color: transparent;
}
.slot.was .calpo,
.slot.was .nm {
  opacity: 0.62;
}

.top {
  display: flex;
  align-items: stretch;
  gap: 10px;
  min-width: 0;
}
/* The poster sets this card's height, so the frame takes the row's full cross-size as its own rule and the
   copy column stretches to meet it — which is what lets the status line sit at the bottom (`margin-top:
   auto` below) instead of hanging under the third text line with a hole beside the art. `align-self:
   flex-start` on the frame is what keeps it 2:3 rather than whatever the text measures. */
.calpo {
  display: grid;
  place-items: center;
  align-self: flex-start;
  flex: none;
  width: 92px;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg-elev-2);
}
.calpo img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.calpo.ph {
  font-size: 20px;
  font-weight: 650;
  color: var(--text-dim);
}
.bd {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.nm {
  font-size: 15px;
  font-weight: 600;
  line-height: 20px;
  color: var(--text);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
/* The pool dot rides inside the name line, because the name is the one line that must not wrap: as a flex
   sibling it would be the thing that gets squeezed and the title would ellipsis at half its length. */
.dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 6px;
  vertical-align: 0.12em;
  border-radius: 50%;
  /* The colour itself comes from lib/pools.ts, inline, because the chip's dot and the 「还没排上」 row's dot
     say the same thing and must not be painted from a second copy of the table. This is only the floor for
     a pool the table does not know. */
  background: var(--text-faint);
}
.kind {
  font-size: 13px;
  font-style: normal;
  line-height: 18px;
  color: var(--text-faint);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}
.epn {
  font-size: 13px;
  font-style: normal;
  line-height: 18px;
  color: var(--text-dim);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-top: auto;
}
.pos {
  flex: none;
  font-size: 13px;
  line-height: 18px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.pos b {
  margin-left: 6px;
  font-weight: 600;
  color: var(--text);
}
.pos u {
  text-decoration: none;
  border-bottom: 1.5px solid var(--accent);
  color: var(--text);
}
.bar {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 2px;
  min-width: 24px;
  height: 4px;
}
.bar i {
  display: block;
  flex: 1;
  height: 100%;
  border-radius: 1px;
  background: var(--line-strong);
}
.bar i.f {
  background: var(--text);
}
.bar.fill {
  display: block;
  position: relative;
  overflow: hidden;
  border-radius: 2px;
  background: var(--line-strong);
}
.bar.fill i {
  position: absolute;
  inset: 0 auto 0 0;
  flex: none;
  border-radius: 2px;
  /* The base `.bar i` paints every segment the track colour, and the fill sits on top of a track of the
     same colour — so without this the whole bar was one grey line and 96% read the same as 100%. */
  background: var(--text);
}
.clk {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 13px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
  background: var(--chip);
}
.dly {
  flex: none;
  font-size: 13px;
  line-height: 18px;
  color: var(--danger);
}
</style>
