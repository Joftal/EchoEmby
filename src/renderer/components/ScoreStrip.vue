<script setup lang="ts">
import { computed, onBeforeUnmount, onBeforeUpdate, onMounted, onUpdated, ref } from 'vue';
import type { LibraryItem } from '../../shared/types';
import { tmdbKind, useScores, type Scores } from '../lib/scores';
import logoTomatoFresh from '../assets/logos/rt-tomato-fresh.svg';
import logoTomatoRotten from '../assets/logos/rt-tomato-rotten.svg';
import logoPopcorn from '../assets/logos/rt-popcorn-good.svg';
import logoImdb from '../assets/logos/imdb.svg';
import logoTmdb from '../assets/logos/tmdb.svg';
import logoTrakt from '../assets/logos/trakt.svg';
import logoBangumi from '../assets/logos/bangumi.png';

/** The line of platform marks the detail page and the lobby hero both put over their art. It fetches
 *  its own data through useScores, so a caller only hands it the item it is already showing. */
/* Every mark here is the work's own number: the card face, the lobby slide and this row all answer for the
 *  same subject, so a title never wears two figures. A season's rating is not this row's business and the
 *  detail page prints it next to the season it belongs to. */
/* `card` is the same marks on a light plate rather than over art: dark ink and no age badge. */
const props = withDefaults(defineProps<{ item: LibraryItem; card?: boolean }>(), { card: false });

/** No `csm`: it answers only the age badge this variant does not draw, and asking it per row would be one
 *  reverse-lookup of a Chinese ratings site for every card on the page for nothing. */
const CARD_SOURCES: (keyof Scores)[] = ['rt', 'imdb', 'trakt', 'bgm', 'tmdb'];
/** One order on every surface that prints scores: the two percentages lead, then the 10-point numbers.
 *  The plate used to lead with the 10-point numbers and close on the percentages, so the same work wore
 *  its marks in two different orders two centimetres apart; the user fixed this one as correct. */
const ORDER = ['tomato', 'corn', 'imdb', 'tmdb', 'trakt', 'bgm'];
const scores = useScores(() => props.item, props.card ? CARD_SOURCES : undefined);
/** TMDB first, the server second: measured on this library the server's `OfficialRating` is present on
 *  only 13-18 of 25 sampled titles, while TMDB's `content_ratings` answers for nearly all of them. */
const certText = computed(() => scores.value.tmdb?.cert || props.item.officialRating || '');

interface Mark {
  k: string;
  logo: string;
  text: string;
  hint: string;
  /** The platform's own page for this title, built from the ids that keyed the lookup. */
  url: string;
}

/** Trakt's web app takes an IMDb id wherever its API does, so the badge needs no slug of its own. */
const traktUrl = (kind: string, imdb: string): string =>
  `https://trakt.tv/${kind === 'movie' ? 'movies' : 'shows'}/${imdb}`;

/** One mark per platform that answered for this title: the platform's own logo, then its number. The
 *  logo carries the identity, so no raters counts or platform names hang off the numbers. The tomato
 *  follows RT's own rule and turns red under 60%, since a green splat beside a 22% would be a lie. */
const marks = computed<Mark[]>(() => {
  const out: Mark[] = [];
  const kind = tmdbKind(props.item);
  const imdb = props.item.providers?.imdb || '';
  const tmdbId = props.item.providers?.tmdb || '';
  const rt = scores.value.rt;
  const tomato = rt?.tomatometer;
  if (tomato != null)
    out.push({
      k: 'tomato',
      logo: tomato >= 60 ? logoTomatoFresh : logoTomatoRotten,
      text: `${tomato}%`,
      hint: `烂番茄 影评人 ${tomato}%${rt?.tomatoCertified ? '（Certified Fresh）' : ''}`,
      url: rt?.url || '',
    });
  if (rt?.popcorn != null)
    out.push({ k: 'corn', logo: logoPopcorn, text: `${rt.popcorn}%`, hint: `烂番茄 观众 ${rt.popcorn}%`, url: rt.url || '' });
  if (scores.value.imdb)
    out.push({ k: 'imdb', logo: logoImdb, text: scores.value.imdb.rating.toFixed(1), hint: 'IMDb 评分', url: `https://www.imdb.com/title/${imdb}/` });
  const tmdbVote = scores.value.tmdb?.voteAverage || 0;
  if (tmdbVote)
    out.push({
      k: 'tmdb',
      logo: logoTmdb,
      text: tmdbVote.toFixed(1),
      hint: 'TMDB 评分',
      url: kind && tmdbId ? `https://www.themoviedb.org/${kind}/${tmdbId}` : '',
    });
  if (scores.value.trakt?.rating != null)
    out.push({ k: 'trakt', logo: logoTrakt, text: scores.value.trakt.rating.toFixed(1), hint: 'Trakt 评分', url: kind && imdb ? traktUrl(kind, imdb) : '' });
  // A season-only Bangumi record (《摩登家庭 第一季》) is that season's number, not the show's, so it does not
  // belong in a row that is otherwise the work; the detail page prints it beside the season it names.
  const bgm = scores.value.bgm;
  if (bgm && bgm.season == null)
    out.push({ k: 'bgm', logo: logoBangumi, text: bgm.score.toFixed(1), hint: `Bangumi《${bgm.name}》`, url: `https://bgm.tv/subject/${bgm.subjectId}` });
  return out.sort((a, b) => ORDER.indexOf(a.k) - ORDER.indexOf(b.k));
});

/** The row is ordered by source, not by arrival, and the sources answer one at a time — so a Trakt number
 *  that lands after Bangumi's is inserted in the middle and every mark to its right has a new home. They
 *  used to teleport 151px sideways for it (measured on the lobby hero). This carries them there instead:
 *  read where each mark was, let Vue re-pack the row, then run each one from where it was seen to where it
 *  now belongs. The mark that arrived has no previous box, so it keeps its own fade. */
const strip = ref<HTMLElement | null>(null);
let seen = new Map<string, number>();

onBeforeUpdate(() => {
  const el = strip.value;
  if (!el) return;
  const next = new Map<string, number>();
  for (const c of Array.from(el.children)) {
    const k = (c as HTMLElement).dataset?.k;
    if (k) next.set(k, (c as HTMLElement).getBoundingClientRect().left);
  }
  seen = next;
});

onUpdated(() => {
  const el = strip.value;
  if (!el) return;
  for (const c of Array.from(el.children)) {
    const node = c as HTMLElement;
    const was = node.dataset?.k ? seen.get(node.dataset.k) : undefined;
    if (was === undefined) continue;
    const d = was - node.getBoundingClientRect().left;
    if (Math.abs(d) < 1) continue;
    node.animate(
      [{ transform: `translate3d(${d}px, 0, 0)` }, { transform: 'none' }],
      { duration: 300, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' },
    );
  }
  refit();
});

/* One line however narrow the card gets: wrapping would drop a mark onto a second line, an ellipsis would
   hide a number and plain overflow would spill it off the plate, so the row shrinks instead. Every size in
   it is one number multiplied by --fit and its content width is linear in --fit, so the children's widths
   divided by the fit in force are the width the row wants at full size, while the room its parent has left
   after the other child is the width the row actually gets. The floor is where the numbers stop being
   readable; past it the row clips rather than invent a second line. */
const fit = ref(1);
function refit(): void {
  const el = strip.value;
  const host = el?.parentElement;
  if (!props.card || !el || !host) return;
  const kids = Array.from(el.children) as HTMLElement[];
  if (!kids.length) {
    fit.value = 1;
    return;
  }
  const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
  const want = (kids.reduce((a, c) => a + c.getBoundingClientRect().width, 0) + gap * (kids.length - 1)) / fit.value;
  const hcs = getComputedStyle(host);
  const rowGap = parseFloat(hcs.columnGap) || 0;
  const rest = (Array.from(host.children) as HTMLElement[]).filter(c => c !== el);
  const have = host.clientWidth - rest.reduce((a, c) => a + c.getBoundingClientRect().width, 0) - rowGap * rest.length;
  if (!want || !have) return;
  fit.value = Math.max(0.78, Math.min(1, Math.round((have / want) * 50) / 50));
}
let ro: ResizeObserver | null = null;
onMounted(() => {
  refit();
  const host = strip.value?.parentElement;
  if (props.card && host && window.ResizeObserver) {
    ro = new ResizeObserver(() => refit());
    ro.observe(host);
  }
});
onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
});
</script>

<template>
  <div ref="strip" class="strip" :class="{ card }" :style="{ '--fit': fit }">
    <a
      v-for="s in marks"
      :key="s.k"
      :data-k="s.k"
      class="b score"
      :class="[s.k, s.url ? 'go' : '']"
      :title="s.hint"
      :href="s.url || undefined"
      :target="s.url ? '_blank' : undefined"
      rel="noreferrer"
    >
      <img class="lg" :src="s.logo" alt="" /><i>{{ s.text }}</i>
    </a>
    <span v-if="!marks.length && item.communityRating" data-k="rate" class="b rate">★ {{ item.communityRating.toFixed(1) }}</span>
    <span v-if="!card && certText" data-k="cert" class="b cert">{{ certText }}</span>
    <span v-if="!card && scores.csm?.minAge" data-k="csm" class="b cert">{{ scores.csm.minAge }}+</span>
  </div>
</template>

<style scoped>
.strip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px 13px;
}
/* The sources answer one at a time, so a mark can arrive while the hero is being read. */
.strip > * {
  animation: fade-in 0.3s var(--ease) both;
}
.b {
  display: inline-flex;
  align-items: center;
  font-size: 13px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 12px rgba(0, 0, 0, 0.7);
}
.rate {
  color: #ffe08a;
}
/* The marks sit straight on the art, so the strip has to read as one line of numbers rather than a row
   of plates: no border, no plate, and the gap between groups barely wider than the gap inside one.
   What they share is the height of the *drawn* mark, not of the file it ships in — measured ink-to-box
   is 1.0 for IMDb's chip, TMDB's lockup and Trakt's square, but 0.91 for the popcorn bucket, 0.72 for
   the tomato (its stem is hairline) and 0.62 for Bangumi, whose letters sit under an antenna. One
   shared height would have kept the row ragged. */
.b.score {
  gap: 5px;
  --body: 16px;
}
.lg {
  height: calc(var(--body) / var(--fill, 1));
  width: auto;
  display: block;
  filter: drop-shadow(0 1px 5px rgba(0, 0, 0, 0.55));
}
.corn {
  --fill: 0.907;
}
.tomato {
  --fill: 0.72;
}
.bgm {
  --fill: 0.618;
}
/* Bangumi's letters sit low in its image, so centring the file centres the antenna above them. The shift
   is a share of the drawn height rather than a fixed -2.8px, because this row shrinks that height. */
.bgm .lg {
  transform: translateY(calc(var(--body) * -0.175));
}
.b.score i {
  font-style: normal;
  color: #fff;
}
.b.score.go {
  text-decoration: none;
  transition: opacity var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.b.score.go:hover {
  opacity: 0.86;
  transform: translateY(-1px);
}
.cert {
  color: rgba(255, 255, 255, 0.92);
}
/* On a plate the white numbers and the shadow that split them from the art would both read as dirt. */
.card .b {
  text-shadow: none;
  font-size: calc(13px * var(--fit, 1));
}
/* One line, whatever the card's width: the row takes the slack in its parent and shrinks (--fit) rather
   than wrapping, ellipsizing or spilling off the plate. */
.strip.card {
  flex: 1 1 auto;
  min-width: 0;
  flex-wrap: nowrap;
  overflow: hidden;
  gap: calc(7px * var(--fit, 1)) calc(13px * var(--fit, 1));
}
.card .b.score i {
  color: var(--text);
}
.card .lg {
  filter: none;
}
/* Over art 16px is the height of the drawn mark, and it was measured against a 13px caption line with
   room to spare; on a plate the mark sits *in* that line, so it takes the line's own height. */
.card .b.score {
  --body: calc(13px * var(--fit, 1));
  gap: calc(5px * var(--fit, 1));
}
/* Bangumi ships as a wordmark, 5.8x as wide as it is tall, so at the row's own height it is four times
   the width of every other mark and the loudest thing on the card. On a plate it gives up three pixels
   of letter height to sit beside them; over art there is room and it keeps the full size. */
.card .b.score.bgm {
  --body: calc(10px * var(--fit, 1));
}
/* The floor when no source answered: the work's own number, on the gold plate the rest of the app
   prints that number on. */
.card .rate {
  color: #6b4500;
  background: rgba(255, 208, 99, 0.42);
  border-radius: var(--r-badge);
  padding: calc(2px * var(--fit, 1)) calc(8px * var(--fit, 1));
}
</style>
