<script setup lang="ts">
import { computed, onBeforeUpdate, onUpdated, ref } from 'vue';
import type { LibraryItem } from '../../shared/types';
import { tmdbKind, useScores } from '../lib/scores';
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
const props = defineProps<{ item: LibraryItem }>();

const scores = useScores(() => props.item);
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
  return out;
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
});
</script>

<template>
  <div ref="strip" class="strip">
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
    <span v-if="certText" data-k="cert" class="b cert">{{ certText }}</span>
    <span v-if="scores.csm?.minAge" data-k="csm" class="b cert">{{ scores.csm.minAge }}+</span>
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
/* Bangumi's letters sit low in its image, so centring the file centres the antenna above them. */
.bgm .lg {
  transform: translateY(-2.8px);
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
</style>
