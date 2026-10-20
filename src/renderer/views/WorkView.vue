<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { LibraryItem, TmdbCredits, TmdbMeta, TmdbSeasonRow, TmdbStills } from '../../shared/types';
import HScroller from '../components/detail/HScroller.vue';
import RelatedStrip from '../components/detail/RelatedStrip.vue';
import FilterSelect from '../components/browse/FilterSelect.vue';
import TitleArt from '../components/TitleArt.vue';
import ScoreStrip from '../components/ScoreStrip.vue';
import HeroSkeleton from '../components/HeroSkeleton.vue';
import HeroPlay from '../components/HeroPlay.vue';
import logoTmdb from '../assets/logos/tmdb.svg';
import { libraryWorks, useRelated, type WorkKind, type WorkSeed } from '../lib/related';
import { embyCached } from '../lib/embycache';
import { beginPlay, workSeedFor } from '../lib/handoff';
import { accountName, episodeHead, fmtDate, fmtRuntime, seenLabel, seasonTitle } from '../lib/format';
import { resetPageScroll } from '../lib/scroll';
import { useAppStore } from '../stores/app';
import { vReveal } from '../lib/reveal';

/** One work, keyed by its TMDB id rather than by a row this server holds.
 *
 *  The detail page can only be built out of a file: its hero, its season tabs and its technical block all
 *  read the item the server returned. A title the library does not hold has no such row, and until now that
 *  meant it had no page either, however much the outside sources knew about it. Everything here is drawn
 *  from TMDB's own entry instead — its seasons, its episodes with their names and stills, its credits, its
 *  art — and the only thing left out is the file, which is said on the page rather than hidden.
 *
 *  The same page is also what a work split across several Series rows needs: this server files 81 of its
 *  shows that way, and the season numbers of the two rows overlap rather than continue each other, so the
 *  detail page cannot join them into one list without inventing a season. Here the list comes from TMDB and
 *  each of its rows says whether this account holds it. */
const props = defineProps<{ kind: string; tmdbId: string }>();
const router = useRouter();
const app = useAppStore();

const kind = computed<WorkKind | null>(() => (props.kind === 'movie' || props.kind === 'tv' ? props.kind : null));
/** TMDB ids are digits; a link that says otherwise is one this page cannot answer for. */
const idKey = computed(() => (kind.value && /^\d{1,8}$/.test(props.tmdbId) ? `${kind.value}:${props.tmdbId}` : ''));
/** The card this page was opened from: its frame and the two lines it printed. A cold TMDB ask is a round
 *  trip the reader should not sit through with nothing on screen. */
const seed = computed(() => workSeedFor(idKey.value));
/** The row this account holds for the work, when the card it was clicked from was one of the server's own.
 *  TMDB's entry is what this page is built out of, and when TMDB does not answer there is no work page — but
 *  there can still be a page: the row knows the title, the year, its own art and the file one click away. */
const seedRow = computed(() => seed.value?.row || null);
/** Whether the hero may be drawn from the server's record instead of TMDB's. Only ever true alongside an
 *  `error`, and only for a work this account really holds — a hand-typed link to a title nobody has is not
 *  made true by a row that happens to share its name. */
const fallback = computed(() => !meta.value && !!seedRow.value);

const meta = ref<TmdbMeta | null>(null);
const error = ref('');
/** Every Series row this account files the work under. A TMDB id is one work; a server can hold it as
 *  several rows — 81 of this library's shows are — and picking only the fullest one would say 「服务器没有
 *  资源」 about seasons the other row does carry. */
const libRows = ref<LibraryItem[]>([]);
/** Whether the server has answered for this work. Distinct from an empty `libRows`: an unanswered question
 *  is not an absence, and only one of them is a promise about whether the CTA is coming. */
const libAsked = ref(false);
const libItem = computed(() => libRows.value[0] || null);
/** Which machine 「可播」 sits on. Once two servers are configured 「本机」 stops meaning anything, so the
 *  CTA names the account whose files it opens instead. */
const serverName = computed(() => (app.account ? accountName(app.account) : ''));
/** Seasons across all of those rows, each still knowing which row it came from: the episodes below it can
 *  only be asked for through that row. */
const serverSeasons = ref<{ row: LibraryItem; season: LibraryItem }[]>([]);
const serverEps = ref<LibraryItem[]>([]);
/** Whether the band on screen has its answer — TMDB's episode list, or this season's files. An empty band
 *  that has not been asked yet is not an empty band, and the line under the season says which of the two
 *  it is only once it knows. */
const bandAsked = ref(false);
const backdrops = ref<string[]>([]);
const logos = ref<string[]>([]);
const stills = ref<TmdbStills>({});
const seasonCast = ref<TmdbCredits | null>(null);
const seasonPick = ref('');
const scroller = ref<HTMLElement | null>(null);
const scroll = ref(0);
function onScroll(): void {
  scroll.value = scroller.value?.scrollTop || 0;
}

const posterUrl = (p?: string): string => (p ? `https://image.tmdb.org/t/p/w342${p}` : '');
const backdropUrl = (p: string): string => `https://image.tmdb.org/t/p/w780${p}`;
const stillUrl = (p?: string): string => (p ? `https://image.tmdb.org/t/p/w500${p}` : '');
const faceUrl = (p: string): string => `https://image.tmdb.org/t/p/w185${p}`;

const name = computed(() => meta.value?.name || seed.value?.name || '');
const year = computed(() => meta.value?.year || Number(seed.value?.year) || 0);
/** The row's own poster, asked for only by the path that needs it: a page running on the server's record
 *  should carry the server's picture rather than an empty frame. */
const rowArt = ref('');
const plateSrc = computed(() => seed.value?.url || rowArt.value || posterUrl(meta.value?.poster));
const heroBackdrop = computed(() => (backdrops.value.length ? backdropUrl(backdrops.value[0]) : plateSrc.value));
const tmdbUrl = computed(() => (idKey.value ? `https://www.themoviedb.org/${kind.value}/${props.tmdbId}` : ''));

/** Numbered seasons only: TMDB files specials as season 0 and a show's 全部 N 季 does not count them. */
const seasons = computed<TmdbSeasonRow[]>(() =>
  kind.value === 'tv' ? [...(meta.value?.seasons || [])].sort((a, b) => a.n - b.n) : [],
);
const numbered = computed(() => seasons.value.filter(s => s.n >= 1));
const season = computed(() => seasons.value.find(s => String(s.n) === seasonPick.value) || null);
const seasonOptions = computed(() => seasons.value.map(s => ({ value: String(s.n), label: seasonTitle(s.n, s.name) })));

/** A click on the season already on screen comes back as the picker's clear gesture. This band always shows
 *  a season, so an empty answer keeps the one on screen instead of blanking it. */
function pickSeason(v: string | string[]): void {
  if (typeof v !== 'string' || !v) return;
  seasonPick.value = v;
}

const metaLine = computed(() => {
  const m = meta.value;
  if (!m) {
    // The row's own caption, and only the counts the server actually claims: TMDB's season table is the
    // very thing that did not arrive, so a 季 number here has to come from the row that is on screen.
    const r = seedRow.value;
    if (!r) return '';
    // A Series row comes without ProductionYear (measured: absent on 碧蓝之海) while its own premiere date
    // is there, so the year is taken from whichever of the two the row carries.
    const y = String(r.productionYear || '') || (r.premiereDate || '').slice(0, 4);
    return [
      y,
      r.type === 'Series' && r.childCount ? `${r.childCount} 季` : '',
      r.type === 'Movie' && r.runTimeTicks ? fmtRuntime(r.runTimeTicks) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }
  return [
    String(year.value || ''),
    kind.value === 'tv' ? (numbered.value.length ? `${numbered.value.length} 季` : '') : m.runtime ? `${m.runtime} 分钟` : '',
    kind.value === 'tv' ? numbered.value.reduce((a, s) => a + (s.epCount || 0), 0) + ' 集' || '' : '',
  ]
    .filter(Boolean)
    .join(' · ');
});

const overviewText = computed(() => meta.value?.overviewZh || meta.value?.overviewOther || (fallback.value ? seedRow.value?.overview || '' : ''));
const crew = computed(() => {
  const src = kind.value === 'tv' ? seasonCast.value : meta.value?.cast || null;
  const rows: { id: string; name: string; sub: string; face: string }[] = [];
  const add = (list: TmdbCredits['act'], kindLabel: string) => {
    for (const p of list) rows.push({ id: `tm:${kindLabel}:${p.name}`, name: p.name, sub: p.sub || kindLabel, face: p.img ? faceUrl(p.img) : '' });
  };
  if (src) {
    add(src.dir, '导演');
    add(src.write, '编剧');
    add(src.act, '演员');
  } else if (meta.value?.writers?.length) {
    for (const w of meta.value.writers) rows.push({ id: `tw:${w}`, name: w, sub: '编剧', face: '' });
  }
  return rows.slice(0, 30);
});

/** The server's row for the season on screen, when any of this work's rows holds it. The season number is
 *  the join, and it is one this page can make and the detail page cannot: the list here is TMDB's, so a
 *  season the fullest Series row never carried is still a row with a place to go. Where two rows both carry
 *  the number, the one with more episodes answers — they overlap rather than continue each other. */
const serverRow = computed(() => {
  const n = Number(seasonPick.value);
  if (!seasonPick.value || Number.isNaN(n)) return null;
  const held = serverSeasons.value.filter(x => x.season.indexNumber === n);
  if (!held.length) return null;
  return held.sort((a, b) => (b.season.childCount || 0) - (a.season.childCount || 0))[0];
});

interface EpView {
  key: string;
  head: string;
  ov: string;
  img: string;
  date: string;
  len: string;
  seen: string;
  played: number;
  /** '' when nothing can be opened: the card then shows the episode, not a promise about playing it. */
  to: string;
}

/** The server's own rows for the season on screen, and only once they are in hand. A season this account
 *  holds is still a season whose file list may be one request away, and during that request TMDB's list of
 *  the same season is the honest picture: same episodes, same order, nothing taken out from under the read.
 *  The answer replaces it the moment it lands, empty answer included — 「这一季没有文件」 is a verdict, and
 *  a verdict belongs to the server that says it. */
const serverBand = computed<LibraryItem[] | null>(() => (serverRow.value && bandAsked.value ? serverEps.value : null));

const eps = computed<EpView[]>(() => {
  const n = Number(seasonPick.value);
  if (!seasonPick.value) return [];
  const held = serverBand.value;
  if (held) {
    return held.map(e => {
      const r = stills.value[e.indexNumber ?? -1];
      return {
        key: e.id,
        head: episodeHead({ episode: e.indexNumber, season: n, seriesName: name.value }, r?.nZh, r?.nOther, e.name),
        ov: r?.ovZh || r?.ovOther || e.overview || '',
        img: stillUrl(r?.p),
        date: fmtDate(e.premiereDate),
        len: fmtRuntime(e.runTimeTicks),
        seen: seenLabel(e.userData, e.runTimeTicks),
        played: Math.min(100, e.userData?.playedPercentage || 0),
        to: `/detail/${e.id}`,
      };
    });
  }
  return Object.keys(stills.value)
    .map(Number)
    .sort((a, b) => a - b)
    .map(k => {
      const r = stills.value[k];
      return {
        key: `t${k}`,
        head: episodeHead({ episode: k, season: n, seriesName: name.value }, r?.nZh, r?.nOther),
        ov: r?.ovZh || r?.ovOther || '',
        img: stillUrl(r?.p),
        date: '',
        len: '',
        seen: '',
        played: 0,
        to: '',
      };
    });
});

/** One run per work and per season. A still that answers after the reader has moved to another season is a
 *  write into the wrong band. */
let run = 0;

/** Which season the band on screen was drawn for. A re-run for the season already showing is not a reader's
 *  move but the server's row arriving late — after TMDB's stills have painted the band — and blanking then
 *  takes away rows the reader is looking at for as long as one request (measured: 311 ms, 416 ms, 9.7 s).
 *  The stills are the same request either way, and the server's rows replace them when they land. */
let drawnSeason: number | null = null;

/** A season this account has no row for has nothing behind TMDB's episode list, so the row is drawn from
 *  those rows alone: their stills, their names, their paragraphs. */
async function loadSeason(): Promise<void> {
  const mine = run;
  const k = kind.value;
  const n = Number(seasonPick.value);
  if (drawnSeason !== n) {
    serverEps.value = [];
    stills.value = {};
    seasonCast.value = null;
  }
  bandAsked.value = false;
  if (!k || !seasonPick.value || Number.isNaN(n)) return;
  const s = await window.echoemby.meta.tmdbStills({ tmdbId: props.tmdbId, season: n });
  if (mine !== run || n !== Number(seasonPick.value)) return;
  if (s.ok && s.data) {
    stills.value = s.data;
    drawnSeason = n;
  }
  if (k === 'tv') {
    const c = await window.echoemby.meta.tmdbSeasonCast({ tmdbId: props.tmdbId, season: n });
    if (mine === run && n === Number(seasonPick.value) && c.ok && c.data) seasonCast.value = c.data;
  }
  const held = serverRow.value;
  // A season nobody holds is answered by TMDB's list alone, so TMDB's answer is the whole answer.
  if (!held) {
    if (s.ok) bandAsked.value = true;
    return;
  }
  const { row: series, season } = held;
  const e = await embyCached('episodes', { seriesId: series.id, seasonId: season.id }, () =>
    window.echoemby.emby.episodes({ seriesId: series.id, seasonId: season.id }),
  );
  if (mine !== run) return;
  if (!e.ok) return;
  serverEps.value = e.data || [];
  bandAsked.value = true;
}
async function loadWork(): Promise<void> {
  const mine = ++run;
  const k = kind.value;
  meta.value = null;
  error.value = '';
  libRows.value = [];
  libAsked.value = false;
  serverSeasons.value = [];
  serverEps.value = [];
  drawnSeason = null;
  backdrops.value = [];
  logos.value = [];
  stills.value = {};
  seasonCast.value = null;
  bandAsked.value = false;
  seasonPick.value = '';
  // vue-router hands the next `/work/*` the same instance, so this is where a new work takes over the page.
  scroll.value = 0;
  resetPageScroll(scroller.value);
  if (!k || !idKey.value) {
    error.value = '这个链接打不开';
    return;
  }
  const r = await window.echoemby.meta.tmdb({ kind: k, tmdbId: props.tmdbId });
  if (mine !== run) return;
  if (!r.ok || !r.data) {
    // The main process already words a transport failure as 「TMDB 没有答上（…）」, so wrapping it here twice
    // is the only thing that would need saying about it.
    error.value = r.error || 'TMDB 没有这一部';
    // One red line on an empty page is a dead end the reader cannot leave, and on the way in from one of
    // this account's own rows there is no need for one: the row knows the title, the year, its art and the
    // file. What stays missing is TMDB's own half — its seasons, its credits, its similar list — and the
    // hero says so beside the button rather than pretending the page is finished.
    const row = seedRow.value;
    if (row) {
      libRows.value = [row];
      libAsked.value = true;
      if (row.primaryImageTag) void app.imageUrl({ id: row.id, primaryImageTag: row.primaryImageTag }, 300).then(u => (rowArt.value = u));
      void askSeasons([row], mine);
    }
    return;
  }
  meta.value = r.data;
  seasonPick.value = String((r.data.seasons.find(s => s.n >= 1 && s.epCount) || r.data.seasons[0])?.n ?? '');
  void window.echoemby.meta.tmdbImages({ kind: k, tmdbId: props.tmdbId }).then(x => {
    if (mine === run && x.ok) backdrops.value = x.data || [];
  });
  void app.workLogos(k, props.tmdbId).then(u => {
    if (mine === run) logos.value = u;
  });
  void libraryWorks(k, props.tmdbId, r.data.name).then(async rows => {
    if (mine !== run) return;
    // `null` is a server that has not answered, not one that holds nothing: the hero keeps its silence
    // rather than promise 「这台服务器上没有」 about a title nobody has been asked for.
    if (!rows) return;
    libRows.value = rows;
    libAsked.value = true;
    void askSeasons(rows, mine);
  });
}

/** The seasons of every Series row this account holds for the work, and the episodes of the one on screen.
 *  Both paths into the page ask through here: the answered one, over all of the rows a TMDB title matches,
 *  and the fallback, over the single row the click came from. */
async function askSeasons(rows: LibraryItem[], mine: number): Promise<void> {
  const series = rows.filter(x => x.type === 'Series');
  if (!series.length) return;
  const groups = await Promise.all(
    series.map(async row => ({ row, s: await embyCached('seasons', row.id, () => window.echoemby.emby.seasons(row.id)) })),
  );
  if (mine !== run) return;
  const before = serverRow.value;
  serverSeasons.value = groups.flatMap(g => (g.s.ok ? g.s.data || [] : []).map(season => ({ row: g.row, season })));
  // Re-run only where the season on screen changed hands. The stills are already on screen and a second
  // load blanks them first, so a season that had an answer and kept it does not get asked again.
  if (serverRow.value !== before) void loadSeason();
}

watch(idKey, loadWork, { immediate: true });
watch(seasonPick, () => void loadSeason());

const relatedSeed = computed<WorkSeed | null>(() =>
  kind.value && idKey.value ? { kind: kind.value, tmdbId: props.tmdbId, genres: meta.value?.genres } : null,
);
const related = useRelated(() => relatedSeed.value);

function open(to: string, autoplay = false): void {
  if (!to) return;
  if (autoplay) beginPlay(to.split('/').pop() || '');
  void router.push(to);
}
</script>

<template>
  <div ref="scroller" class="page" @scroll.passive="onScroll">
    <button class="back" @click="router.back()">←</button>
    <Transition name="hero-swap">
      <HeroSkeleton v-if="!meta && !error" :poster="plateSrc" />
      <section v-else-if="meta || fallback" class="hero">
        <div class="stage" :style="{ transform: `translate3d(0, ${Math.round(scroll * 0.28)}px, 0)` }">
          <img v-if="heroBackdrop" :src="heroBackdrop" alt="" decoding="async" />
        </div>
        <div class="wash"></div>
        <div
          class="hero-in"
          :style="{ opacity: Math.max(0, 1 - scroll / 260), transform: `translate3d(0, ${Math.round(scroll * 0.4)}px, 0)` }"
        >
          <div class="copy">
            <div v-if="plateSrc" class="art">
              <img :src="plateSrc" alt="" decoding="async" />
            </div>
            <div class="text">
              <TitleArt :urls="logos" :name="name" />
              <div class="line">{{ metaLine }}</div>
              <ScoreStrip v-if="libItem" :item="libItem" class="badges" />
              <div v-else-if="meta" class="badges">
                <span v-if="meta.voteAverage" class="mk" :title="`TMDB ${name} 评分`">
                  <img :src="logoTmdb" alt="" /><i>{{ meta.voteAverage.toFixed(1) }}</i>
                </span>
                <span v-if="meta.cert" class="cert">{{ meta.cert }}</span>
              </div>
              <p class="overview">{{ overviewText || '暂无简介。' }}</p>
            </div>
            <div class="actions">
              <button v-if="libItem" type="button" class="cta" @click="open(`/detail/${libItem.id}`)">
                在&nbsp;<span class="nm">{{ serverName }}</span>&nbsp;播放
              </button>
              <!-- The same plate the detail page answers with: this sentence is the same fact about the same
                   server, and two renderings of it had drifted apart (a 44px translucent pill here, a 48px
                   white plate there). `none` also makes it a non-button, which a `<span>` could not be. -->
              <HeroPlay v-else-if="libAsked" :target="null" none />
              <a v-if="tmdbUrl && !fallback" class="ext" :href="tmdbUrl" target="_blank" rel="noreferrer" title="TMDB 上这一部的页面">
                <img :src="logoTmdb" alt="TMDB" />
              </a>
            </div>
          </div>
        </div>
      </section>
    </Transition>

    <p v-if="error && !fallback" class="err pad">{{ error }}</p>
    <p v-else-if="fallback" class="miss">{{ error }}，这一页用的是服务器上的这条记录；TMDB 的分季、演职员与相似作品没有。</p>

    <div v-else-if="meta" class="flow">
      <HScroller v-if="seasons.length" class="block epi-row">
        <template #header>
          <div class="ep-head">
            <FilterSelect
              v-if="seasons.length > 1"
              bare
              neutral
              rows
              label="季"
              :options="seasonOptions"
              :model-value="seasonPick"
              @update:model-value="pickSeason"
            />
            <h2 v-else>{{ seasonTitle(season?.n, season?.name) }}</h2>
            <span v-if="season?.voteAverage" class="qline">
              <span class="qn">本季评分</span>
              <a
                class="qv"
                :href="`https://www.themoviedb.org/tv/${props.tmdbId}/season/${season.n}`"
                target="_blank"
                rel="noreferrer"
                :title="`TMDB ${seasonTitle(season.n, season.name)} 评分`"
                >TMDB <i>{{ season.voteAverage.toFixed(1) }}</i></a
              >
            </span>
          </div>
        </template>
        <!-- Two empties, and this is the only place either of them is said: the season line's verdict was
             dropped on 2026-10-20 because the detail page's play button carries that sentence, and this page
             has no per-season button to carry it. So the band names which side failed to answer for it. -->
        <p v-if="!eps.length && bandAsked && !serverRow" class="qempty">TMDB 还没有这一季的分集。</p>
        <p v-else-if="!eps.length && bandAsked" class="qempty">{{ serverName }} 服务器在这一季没有文件。</p>
        <component
          v-for="e in eps"
          :is="e.to ? 'button' : 'div'"
          :key="e.key"
          class="epi"
          :class="{ still: !e.to }"
          @click="e.to && open(e.to, true)"
        >
          <div class="ethumb">
            <img v-reveal v-if="e.img" :src="e.img" alt="" loading="lazy" decoding="async" />
            <span v-else class="ph">{{ e.head.slice(0, 1) }}</span>
            <span v-if="e.to" class="disc" role="presentation">
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 5l12 7-12 7z" fill="currentColor" /></svg>
            </span>
            <span v-if="e.seen" class="echip">{{ e.seen }}</span>
            <div v-if="e.played > 0" class="eprog"><i :style="{ width: e.played + '%' }"></i></div>
          </div>
          <div class="einfo">
            <p class="etitle">{{ e.head }}</p>
            <p class="emeta"><span v-if="e.date">{{ e.date }}</span><span>{{ e.len }}</span></p>
            <p v-if="e.ov" class="eov">{{ e.ov }}</p>
          </div>
        </component>
      </HScroller>

      <HScroller v-if="crew.length" class="block" title="演职员" :count="crew.length">
        <div v-for="p in crew" :key="p.id" class="person">
          <div class="face">
            <img v-reveal v-if="p.face" :src="p.face" alt="" loading="lazy" />
            <span v-else class="ini">{{ p.name.slice(0, 1) }}</span>
          </div>
          <p class="pn">{{ p.name }}</p>
          <p v-if="p.sub" class="pr">{{ p.sub }}</p>
        </div>
      </HScroller>

      <section v-if="meta.genres.length" class="block">
        <h2>分类</h2>
        <div class="chips"><span v-for="g in meta.genres" :key="g" class="chip">{{ g }}</span></div>
      </section>

      <HScroller v-if="backdrops.length" class="block" title="剧照" :count="backdrops.length">
        <div v-for="(b, i) in backdrops" :key="i" class="still">
          <img class="stillimg" :src="backdropUrl(b)" alt="" loading="lazy" decoding="async" />
        </div>
      </HScroller>

      <RelatedStrip :cards="related" />
    </div>
  </div>
</template>

<style scoped>
.page {
  --side: clamp(10px, 1.8vw, 26px);
  --gutter: var(--nav-w);
  --rail-x: 12px;
  --tuck: 214px;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  position: relative;
  padding-bottom: 56px;
}
.back {
  position: absolute;
  top: 21px;
  left: calc(var(--nav-w) + 18px);
  z-index: 1;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(16, 16, 22, 0.42);
  border: 1px solid rgba(255, 255, 255, 0.24);
  backdrop-filter: blur(10px);
  color: #fff;
  transition: background var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.back:hover {
  background: rgba(16, 16, 22, 0.66);
  transform: translateX(-2px);
}
.err {
  color: var(--danger);
}
.pad {
  padding: calc(var(--titlebar-h) + 40px) 44px 0 calc(var(--nav-w) + 44px);
}
/* Sits where a rail would, under a hero built from the server's record: the page is usable, and the line
   says which half of it is missing rather than leaving the reader to find the empty space. */
.miss {
  margin: 18px 0 0;
  padding: 0 var(--side) 0 var(--nav-w);
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-dim);
}

.hero {
  position: relative;
  height: clamp(460px, 61vh, 620px);
  margin-left: var(--gutter);
  margin-bottom: 4px;
  display: flex;
  align-items: flex-end;
  overflow: hidden;
  --hero-pos: center 22%;
  --hero-ramp:
    linear-gradient(to top, rgba(6, 8, 14, 0.86) 0, rgba(6, 8, 14, 0.82) 120px, rgba(6, 8, 14, 0.5) max(240px, 42%), rgba(6, 8, 14, 0.12) max(400px, 72%), transparent 100%),
    linear-gradient(90deg, rgba(6, 8, 14, 0.5) 0%, rgba(6, 8, 14, 0.12) 46%, transparent 72%);
}
.stage {
  position: absolute;
  inset: -3px 0;
  will-change: transform;
}
.stage img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: var(--hero-pos);
}
.wash {
  position: absolute;
  inset: 0;
  background: var(--hero-ramp);
}
.hero-in {
  position: relative;
  z-index: 2;
  width: 100%;
  padding: 0 var(--side) 28px 32px;
  will-change: transform, opacity;
}
.copy {
  color: #fff;
  display: flex;
  align-items: flex-end;
  gap: 20px;
}
.art {
  height: clamp(348px, 46vh, 430px);
  flex: none;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: var(--shadow);
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
.line {
  font-size: 13.5px;
  line-height: 1.35;
  min-height: calc(13.5px * 1.35 * 2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.86);
  margin-bottom: 12px;
  font-variant-numeric: tabular-nums;
}
.badges {
  margin-bottom: 14px;
  display: flex;
  align-items: center;
  gap: 13px;
}
.mk {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 12px rgba(0, 0, 0, 0.7);
}
.mk img {
  height: 16px;
  width: auto;
  display: block;
  filter: drop-shadow(0 1px 5px rgba(0, 0, 0, 0.55));
}
.mk i {
  font-style: normal;
  color: #fff;
}
.cert {
  font-size: 13px;
  font-weight: 650;
  color: rgba(255, 255, 255, 0.92);
  text-shadow: 0 1px 12px rgba(0, 0, 0, 0.7);
}
.overview {
  font-size: 14px;
  line-height: 1.65;
  color: rgba(255, 255, 255, 0.9);
  max-width: 660px;
  margin: 0 0 18px;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 92.4px;
}
/* The row keeps its height whether the answer is a button, an absence or a question still out, so the
   copy column does not move when the server says whether it holds this work.
   48.2px is the height the shared plate arrives with — 16px of padding over the two text lines it reserves —
   so the reservation is the tallest thing that can land here rather than the pill that used to be, and
   `flex-end` is what makes the shorter ones sit on the same line the poster and the copy already end at
   instead of re-centring when the plate arrives. */
.actions {
  flex: none;
  margin-left: auto;
  display: flex;
  align-items: flex-end;
  gap: 12px;
  min-height: 48.2px;
}
.cta {
  display: inline-flex;
  align-items: center;
  height: 44px;
  padding: 0 22px;
  border-radius: 999px;
  font-size: 14px;
  font-weight: 700;
  color: #10131c;
  background: #fff;
  white-space: nowrap;
  transition: transform var(--hov) var(--ease-out), opacity var(--hov) var(--ease);
}
/* A server name is whatever the account was labelled — a host, a person's word for the machine. The two
   words around it stay, so the name is what gives when it does not fit. */
.cta .nm {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 9em;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cta:hover {
  transform: translateY(-1px);
  opacity: 0.92;
}
.ext {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.16);
  border: 1px solid rgba(255, 255, 255, 0.36);
  backdrop-filter: blur(10px);
  transition: background var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.ext:hover {
  background: rgba(255, 255, 255, 0.26);
  transform: translateY(-1px);
}
.ext img {
  width: 22px;
  display: block;
}

.flow {
  position: relative;
  z-index: 1;
  margin-left: var(--rail-x);
  overflow-x: clip;
}
.flow:has(.sel.on) {
  z-index: 3;
}
.flow > .block {
  margin-top: 26px;
}
.block:not(.hrow) {
  padding-left: calc(var(--gutter) - var(--rail-x));
  padding-right: var(--side);
}
h2 {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.2px;
  margin: 0 0 14px;
  color: var(--text);
}
.epi-row {
  min-height: 370px;
}
.ep-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  min-height: 34px;
}
.ep-head h2 {
  margin-bottom: 0;
}
.qline {
  display: inline-flex;
  align-items: baseline;
  gap: 9px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.qn {
  color: var(--text-dim);
  font-weight: 550;
}
/* A season with nothing to draw is a rail of zero cards, and a reader cannot tell that apart from a band
   that failed to load. Which of the two it is depends on who was asked, and the line above says it. */
.qempty {
  margin: 0;
  padding: 2px 0 12px;
  font-size: 13px;
  color: var(--text-dim);
}
.qv {
  color: var(--text-dim);
  font-weight: 550;
  text-decoration: none;
  transition: opacity var(--hov) var(--ease);
}
.qv i {
  font-style: normal;
  color: var(--text);
  font-weight: 700;
}
.qv:hover {
  opacity: 0.82;
}

.epi {
  flex: none;
  width: 280px;
  display: flex;
  flex-direction: column;
  /* A button's UA sheet asks for flex-start, and a thumb with nothing in flow then collapses to its
     border. The div version of this card never had the problem. */
  align-items: stretch;
  text-align: left;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  transition: transform var(--hov) var(--ease-out);
}
.epi:not(.still) {
  cursor: pointer;
}
.epi:not(.still):hover {
  transform: translateY(-3px);
}
.ethumb {
  position: relative;
  aspect-ratio: 16 / 9;
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg-elev-2);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
}
.ethumb img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ethumb .ph {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 30px;
  font-weight: 700;
  color: var(--text-faint);
  background: linear-gradient(150deg, var(--bg), var(--bg-elev-2));
}
.ethumb .disc {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  color: #10131c;
  background: rgba(255, 255, 255, 0.92);
  opacity: 0;
  transform: scale(0.9);
  transition: opacity var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.epi:hover .disc {
  opacity: 1;
  transform: none;
}
.ethumb .echip {
  position: absolute;
  left: 8px;
  bottom: 8px;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 650;
  color: #fff;
  background: rgba(9, 11, 18, 0.72);
}
.ethumb .eprog {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgba(255, 255, 255, 0.32);
  overflow: hidden;
}
.ethumb .eprog i {
  display: block;
  height: 100%;
  background: #fff;
}
.einfo {
  min-width: 0;
  margin-top: 11px;
}
.etitle {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  color: var(--text);
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.emeta {
  margin: 3px 0 0;
  display: flex;
  gap: 8px;
  font-size: 13px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.eov {
  margin: 5px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-dim);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.person {
  width: 84px;
  flex: none;
}
.face {
  width: 84px;
  height: 84px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--bg-elev-2);
  border: 1px solid var(--line);
}
.face img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.face .ini {
  display: grid;
  place-items: center;
  height: 100%;
  font-size: 26px;
  font-weight: 700;
  color: var(--text-faint);
}
.pn,
.pr {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.3;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pr {
  margin: 2px 0 0;
  font-weight: 500;
  color: var(--text-dim);
}
.pn {
  font-weight: 600;
  color: var(--text);
}

.chips {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
}
.chip {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  background: var(--chip);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-dim);
}

.still {
  flex: none;
}
.stillimg {
  display: block;
  width: 320px;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border-radius: var(--radius);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
}
</style>
