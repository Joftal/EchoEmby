<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { BangumiScore, CsmGuide, ImdbRating, LibraryItem, MediaSourceInfo, MediaStreamInfo, RtScores, TmdbMeta, TmdbSimilar, TmdbStills, TraktScores } from '../../shared/types';
import HScroller from '../components/detail/HScroller.vue';
import { usePlayerStore } from '../stores/player';
import { useAppStore } from '../stores/app';
import { fmtDate, fmtDateTime, fmtRuntime } from '../lib/format';
import logoTomatoFresh from '../assets/logos/rt-tomato-fresh.svg';
import logoTomatoRotten from '../assets/logos/rt-tomato-rotten.svg';
import logoPopcorn from '../assets/logos/rt-popcorn-good.svg';
import logoImdb from '../assets/logos/imdb.svg';
import logoTmdb from '../assets/logos/tmdb.svg';
import logoTrakt from '../assets/logos/trakt.svg';
import logoBangumi from '../assets/logos/bangumi.png';

const props = defineProps<{ id: string }>();
const router = useRouter();
const player = usePlayerStore();
const app = useAppStore();

const item = ref<LibraryItem | null>(null);
const seasons = ref<LibraryItem[]>([]);
const episodes = ref<LibraryItem[]>([]);
const seasonId = ref('');
const loading = ref(true);
const error = ref('');
const playErr = ref('');
const favBusy = ref(false);

const rt = ref<RtScores | null>(null);
const imdbScore = ref<ImdbRating | null>(null);
const trakt = ref<TraktScores | null>(null);
const bgm = ref<BangumiScore | null>(null);
const tmdb = ref<TmdbMeta | null>(null);
const csm = ref<CsmGuide | null>(null);
const similar = ref<TmdbSimilar[]>([]);
const stills = ref<TmdbStills>({});
const backdrops = ref<string[]>([]);

/** The hero parallaxes and its copy fades against the page's own scroll, the way the lobby does. */
const scroller = ref<HTMLElement | null>(null);
const scroll = ref(0);
function onScroll(): void {
  scroll.value = scroller.value?.scrollTop || 0;
}

const isSeries = computed(() => item.value?.type === 'Series');
const isSeason = computed(() => item.value?.type === 'Season');
const tmdbKind = computed<'movie' | 'tv' | null>(() => {
  const t = item.value?.type;
  if (t === 'Movie') return 'movie';
  if (t === 'Series' || t === 'Season') return 'tv';
  return null;
});

const people = computed(() => item.value?.people || []);
const ROLE_LABEL: Record<string, string> = { Director: '导演', Writer: '编剧', Producer: '制片' };
interface CrewRow { id: string; name: string; imageTag?: string; sub: string }
/** Directors, writers and producers share one avatar band with the cast — the reference shows a single
 *  row of circular heads, the role label underneath telling them apart, not a text credit list on top. */
const crew = computed<CrewRow[]>(() => {
  const order: Record<string, number> = { Director: 0, Writer: 1, Producer: 2, Actor: 3 };
  const seen = new Set<string>();
  const out: CrewRow[] = [];
  for (const p of [...people.value].sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9))) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ id: p.id, name: p.name, imageTag: p.imageTag, sub: p.type === 'Actor' ? p.role || '' : ROLE_LABEL[p.type] || p.role || '' });
  }
  // Server carries no writers for this library, so TMDB's fill the gap rather than losing the credit.
  if (!people.value.some(p => p.type === 'Writer')) {
    for (const w of tmdb.value?.writers || []) out.push({ id: `tw:${w}`, name: w, sub: '编剧' });
  }
  return out.slice(0, 30);
});
const overviewText = computed(() => item.value?.overview || tmdb.value?.overviewZh || '');
const certText = computed(() => item.value?.officialRating || tmdb.value?.cert || '');

interface ScoreBadge {
  k: string;
  logo: string;
  text: string;
  hint: string;
}

/** One pill per platform that answered for this title: the platform's own mark, then its number. The
 *  mark carries the identity, so the counts that used to hang off these numbers — raters, in-watch
 *  lists, RT's Certified Fresh word — are gone from the strip. The tomato follows RT's own rule and
 *  turns red under 60%, since a green splat beside a 22% would be a lie. */
const scoreBadges = computed<ScoreBadge[]>(() => {
  const out: ScoreBadge[] = [];
  const tomato = rt.value?.tomatometer;
  if (tomato != null)
    out.push({
      k: 'tomato',
      logo: tomato >= 60 ? logoTomatoFresh : logoTomatoRotten,
      text: `${tomato}%`,
      hint: `烂番茄 影评人 ${tomato}%${rt.value?.tomatoCertified ? '（Certified Fresh）' : ''}`,
    });
  if (rt.value?.popcorn != null)
    out.push({ k: 'corn', logo: logoPopcorn, text: `${rt.value.popcorn}%`, hint: `烂番茄 观众 ${rt.value.popcorn}%` });
  if (imdbScore.value)
    out.push({ k: 'imdb', logo: logoImdb, text: imdbScore.value.rating.toFixed(1), hint: 'IMDb 评分' });
  if (tmdb.value?.voteAverage)
    out.push({ k: 'tmdb', logo: logoTmdb, text: tmdb.value.voteAverage.toFixed(1), hint: 'TMDB 评分' });
  if (trakt.value?.rating != null)
    out.push({ k: 'trakt', logo: logoTrakt, text: trakt.value.rating.toFixed(1), hint: 'Trakt 评分' });
  if (bgm.value)
    out.push({ k: 'bgm', logo: logoBangumi, text: bgm.value.score.toFixed(1), hint: `Bangumi《${bgm.value.name}》` });
  return out;
});

const source = computed<MediaSourceInfo | undefined>(() => item.value?.sources?.[0]);
const vstream = computed(() => source.value?.video);
const astream = computed<MediaStreamInfo | undefined>(() => {
  const a = source.value?.audio || [];
  return a.find(x => x.isDefault) || a[0];
});

/** image.tmdb.org answers directly on this machine (the API host needs the system proxy). */
const stillUrl = (ep: number | undefined): string =>
  ep != null && stills.value[ep] ? `https://image.tmdb.org/t/p/w500${stills.value[ep]}` : '';
const posterUrl = (p?: string): string => (p ? `https://image.tmdb.org/t/p/w342${p}` : '');
const backdropUrl = (p: string): string => `https://image.tmdb.org/t/p/w780${p}`;

const faces = ref<Record<string, string>>({});
watch(
  crew,
  list => {
    for (const p of list) {
      if (!p.imageTag || faces.value[p.id]) continue;
      void app.imageUrl({ id: p.id, primaryImageTag: p.imageTag }, 110).then(url => (faces.value[p.id] = url));
    }
  },
  { immediate: true },
);

const epArt = ref<Record<string, string>>({});
watch(
  episodes,
  list => {
    // Only the server URL is cached; the TMDB still arrives later so the template reads it at render time.
    for (const e of list) {
      if (!e.primaryImageTag || epArt.value[e.id]) continue;
      void app.imageUrl({ id: e.id, primaryImageTag: e.primaryImageTag }, 520).then(url => (epArt.value[e.id] = url));
    }
  },
  { immediate: true },
);

const heroBackdrop = ref('');

const playableId = computed(() => {
  if (!item.value) return '';
  if (isSeries.value || isSeason.value) {
    return episodes.value.find(e => e.userData?.playedPercentage)?.id || episodes.value[0]?.id || '';
  }
  return item.value.id;
});
const playTargetLabel = computed(() => {
  if (!isSeries.value && !isSeason.value) return '';
  const e = episodes.value.find(x => x.userData?.playedPercentage) || episodes.value[0];
  if (!e) return '';
  const s = e.parentIndexNumber ?? seasons.value.find(x => x.id === seasonId.value)?.indexNumber;
  return s != null ? `第 ${s} 季 · ${e.indexNumber} 集` : `第 ${e.indexNumber} 集`;
});

const genres = computed(() => item.value?.genres || []);
const premiered = computed(() => fmtDate(item.value?.premiereDate) || String(item.value?.productionYear || ''));
const metaLine = computed(() => {
  const parts = [premiered.value];
  if (item.value?.childCount) parts.push(`${item.value.childCount} 集`);
  const rt = fmtRuntime(item.value?.runTimeTicks);
  if (rt) parts.push(rt);
  return parts.filter(Boolean).join(' · ');
});

const fav = computed(() => !!item.value?.userData?.isFavorite);

async function loadEpisodes(sid: string, seriesId = props.id) {
  seasonId.value = sid;
  episodes.value = [];
  stills.value = {};
  if (!sid) return;
  const r = await window.echoemby.emby.episodes({ seriesId, seasonId: sid });
  if (r.ok) episodes.value = r.data || [];
  const seasonNumber = seasons.value.find(x => x.id === sid)?.indexNumber ?? item.value?.indexNumber;
  const tmdbId = item.value?.providers?.tmdb || (isSeason.value ? await fetchParentTmdbId(seriesId) : '');
  if (tmdbId && Number.isInteger(seasonNumber)) {
    void window.echoemby.meta.tmdbStills({ tmdbId, season: seasonNumber as number }).then(x => {
      if (x.ok && x.data && seasonId.value === sid) stills.value = x.data.value;
    });
  }
}

const parentTmdbCache = new Map<string, string>();
async function fetchParentTmdbId(seriesId: string): Promise<string> {
  if (!seriesId) return '';
  const cached = parentTmdbCache.get(seriesId);
  if (cached !== undefined) return cached;
  const r = await window.echoemby.emby.item(seriesId);
  const id = r.ok ? r.data?.providers?.tmdb || '' : '';
  parentTmdbCache.set(seriesId, id);
  return id;
}

/** The dropdown reads 「第1季」 from the season's index, falling back to its server name. */
const seasonLabel = (s: LibraryItem): string => (s.indexNumber != null ? `第 ${s.indexNumber} 季` : s.name);
const activeSeasonLabel = computed(() => {
  const s = seasons.value.find(x => x.id === seasonId.value);
  return s ? seasonLabel(s) : item.value?.name || '本季';
});
function onSeason(ev: Event): void {
  void loadEpisodes((ev.target as HTMLSelectElement).value);
}

watch(
  () => props.id,
  async id => {
    loading.value = true;
    error.value = '';
    rt.value = null;
    imdbScore.value = null;
    trakt.value = null;
    bgm.value = null;
    tmdb.value = null;
    csm.value = null;
    similar.value = [];
    stills.value = {};
    backdrops.value = [];
    heroBackdrop.value = '';
    item.value = null;
    seasons.value = [];
    episodes.value = [];
    const r = await window.echoemby.emby.item(id);
    loading.value = false;
    if (!r.ok || !r.data) {
      error.value = r.error || '打不开这一项';
      return;
    }
    const it = r.data;
    item.value = it;

    const tag = it.backdropImageTag || it.primaryImageTag;
    heroBackdrop.value = tag ? await app.backdropUrl({ id: it.id, backdropImageTag: it.backdropImageTag }, 1600) : '';
    if (!it.backdropImageTag && it.primaryImageTag) {
      // No wide art on the server: reuse the poster as a soft backdrop rather than a flat gradient.
      heroBackdrop.value = await app.imageUrl({ id: it.id, primaryImageTag: it.primaryImageTag }, 1000);
    }

    const imdb = it.providers?.imdb;
    const kind = tmdbKind.value;
    if (imdb) {
      void window.echoemby.meta.rt(imdb).then(x => (props.id === id ? (rt.value = x.ok ? x.data || null : null) : undefined));
      void window.echoemby.meta.imdb(imdb).then(x => (props.id === id ? (imdbScore.value = x.ok ? x.data || null : null) : undefined));
      if (kind) void window.echoemby.meta.trakt({ kind, imdb }).then(x => (props.id === id ? (trakt.value = x.ok ? x.data || null : null) : undefined));
    }

    const tmdbId = it.providers?.tmdb;
    if (kind && tmdbId) {
      void window.echoemby.meta.tmdb({ kind, tmdbId }).then(x => (props.id === id ? (tmdb.value = x.ok ? x.data || null : null) : undefined));
      void window.echoemby.meta.tmdbSimilar({ kind, tmdbId }).then(x => (props.id === id ? (similar.value = x.ok ? x.data || [] : []) : undefined));
      void window.echoemby.meta.tmdbImages({ kind, tmdbId }).then(x => (props.id === id ? (backdrops.value = x.ok ? x.data || [] : []) : undefined));
    }
    // CSM reverse-looks-up by title slug, so it needs the Latin original title when we have one.
    const csmTitle = it.originalTitle || it.name;
    if (kind && csmTitle) {
      void window.echoemby.meta.csm({ kind, title: csmTitle }).then(x => (props.id === id ? (csm.value = x.ok ? x.data || null : null) : undefined));
    }
    // Bangumi is the opposite half: its search only reaches CJK names, and it is where the anime and
    // domestic-drama titles this server holds are actually reviewed.
    if (kind && it.name) {
      void window.echoemby.meta.bangumi(it.name).then(x => (props.id === id ? (bgm.value = x.ok ? x.data || null : null) : undefined));
    }

    if (it.type === 'Series') {
      const s = await window.echoemby.emby.seasons(id);
      seasons.value = s.ok ? s.data || [] : [];
      const first = seasons.value.find(x => x.childCount) || seasons.value[0];
      if (first) await loadEpisodes(first.id);
    } else if (it.type === 'Season') {
      await loadEpisodes(it.id, it.parentId || '');
    }
  },
  { immediate: true },
);

async function play(id = playableId.value) {
  if (!id) {
    playErr.value = '这一项还不能直接播放';
    return;
  }
  playErr.value = '';
  const ok = await player.play(id);
  if (!ok) playErr.value = player.error;
}

async function toggleFav() {
  const it = item.value;
  if (!it || favBusy.value) return;
  favBusy.value = true;
  const next = !fav.value;
  const r = await window.echoemby.emby.favorite({ id: it.id, on: next });
  if (r.ok && it.userData) it.userData.isFavorite = next;
  favBusy.value = false;
}

const LEVEL_WORD = ['无', '极少', '轻微', '中等', '较多', '严重'];
const fmtMbps = (n?: number): string => (n ? `${(n / 1e6).toFixed(1)} Mbps` : '');
const fmtGB = (n?: number): string => (n ? `${(n / 1e9).toFixed(2)} GB` : '');
const fmtRes = (v?: MediaStreamInfo): string => (v?.width && v?.height ? `${v.width}×${v.height}` : '');
const fmtCh = (n?: number): string => (n === 6 ? '5.1' : n === 8 ? '7.1' : n ? String(n) : '');
</script>

<template>
  <div ref="scroller" class="page" @scroll.passive="onScroll">
    <button class="back" @click="router.back()">←</button>
    <p v-if="playErr" class="err banner">{{ playErr }}</p>
    <p v-if="loading" class="muted pad">加载中…</p>
    <p v-else-if="error" class="err pad">{{ error }}</p>

    <template v-else-if="item">
      <section class="hero">
        <div class="stage" :style="{ transform: `translate3d(0, ${Math.round(scroll * 0.28)}px, 0)` }">
          <img v-if="heroBackdrop" :src="heroBackdrop" alt="" decoding="async" />
        </div>
        <div class="wash"></div>
        <div
          class="hero-in"
          :style="{ opacity: Math.max(0, 1 - scroll / 260), transform: `translate3d(0, ${Math.round(scroll * 0.4)}px, 0)` }"
        >
          <div class="copy">
            <div class="text">
              <h1>{{ item.name }}</h1>
              <p v-if="item.tagline" class="tagline">{{ item.tagline }}</p>
              <div class="line">{{ metaLine }}</div>
              <div class="badges">
                <span v-for="s in scoreBadges" :key="s.k" class="b score" :title="s.hint">
                  <img class="lg" :src="s.logo" alt="" /><i>{{ s.text }}</i>
                </span>
                <span v-if="!scoreBadges.length && item.communityRating" class="b rate">★ {{ item.communityRating.toFixed(1) }}</span>
                <span v-if="certText" class="b cert">{{ certText }}</span>
                <span v-if="csm?.minAge" class="b cert">{{ csm.minAge }}+</span>
              </div>
              <p class="overview">{{ overviewText || '暂无简介。' }}</p>
              <div class="actions">
                <button class="play" :disabled="!playableId || player.busy" @click="play()">
                  <span class="tri"></span>
                  <span class="ptxt">
                    <b>{{ player.busy ? '准备中…' : item.userData?.playedPercentage ? '继续播放' : '播放' }}</b>
                    <i v-if="playTargetLabel">{{ playTargetLabel }}</i>
                  </span>
                </button>
                <button class="iconb" :class="{ on: fav }" :disabled="favBusy" :title="fav ? '已收藏' : '收藏'" @click="toggleFav">
                  <svg viewBox="0 0 24 24" width="20" height="20"><path :d="fav ? 'M12 21l-1.5-1.3C5.4 15 2 11.9 2 8.2 2 5.4 4.2 3.2 7 3.2c1.6 0 3.1.7 4 1.9.9-1.2 2.4-1.9 4-1.9 2.8 0 5 2.2 5 5 0 3.7-3.4 6.8-8.5 11.5L12 21z' : 'M12 21l-1.5-1.3C5.4 15 2 11.9 2 8.2 2 5.4 4.2 3.2 7 3.2c1.6 0 3.1.7 4 1.9.9-1.2 2.4-1.9 4-1.9 2.8 0 5 2.2 5 5 0 3.7-3.4 6.8-8.5 11.5L12 21zM7 5.2c-1.7 0-3 1.3-3 3 0 3 3 5.9 8 10.2 5-4.3 8-7.2 8-10.2 0-1.7-1.3-3-3-3-1.3 0-2.5.8-3 2h-4c-.5-1.2-1.7-2-3-2z'" fill="currentColor" /></svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div class="flow">
        <HScroller v-if="episodes.length" class="block">
          <template #header>
            <div class="ep-head">
              <label v-if="seasons.length > 1" class="pick">
                <select :value="seasonId" @change="onSeason">
                  <option v-for="s in seasons" :key="s.id" :value="s.id">{{ seasonLabel(s) }}</option>
                </select>
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
              </label>
              <h2 v-else>{{ activeSeasonLabel }}</h2>
              <span class="count">{{ episodes.length }} 集</span>
            </div>
          </template>
          <button v-for="e in episodes" :key="e.id" class="epi" @click="play(e.id)">
            <div class="ethumb">
              <img v-if="epArt[e.id] || stillUrl(e.indexNumber)" :src="epArt[e.id] || stillUrl(e.indexNumber)" alt="" loading="lazy" decoding="async" />
              <span v-else class="ph">{{ (e.name || '?').slice(0, 1) }}</span>
              <span class="disc" role="presentation"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 5l12 7-12 7z" fill="currentColor" /></svg></span>
            </div>
            <div class="einfo">
              <p class="emeta">
                <span v-if="e.premiereDate">{{ fmtDate(e.premiereDate) }}</span>
                <span>第 {{ e.indexNumber }} 集</span>
                <span>{{ fmtRuntime(e.runTimeTicks) }}</span>
                <span v-if="e.userData?.playedPercentage" class="seen">已观看</span>
              </p>
              <p class="etitle">{{ e.name }}</p>
              <p v-if="e.overview" class="eov">{{ e.overview }}</p>
            </div>
          </button>
        </HScroller>

        <section v-if="source" class="block">
          <h2>播放资源</h2>
          <div class="src">
            <div class="srccard">
              <p class="sc-top">{{ vstream?.range || 'SDR' }}</p>
              <p class="sc-meta"><span>{{ fmtGB(source.sizeBytes) }}</span><span>{{ fmtMbps(source.bitRate) }}</span></p>
              <p class="sc-foot"><span class="dot"></span>{{ source.container }}<span class="ok">✓</span></p>
            </div>
          </div>

          <div class="tech">
            <div v-if="vstream" class="tcard">
              <h3>视频</h3>
              <dl>
                <template v-for="row in [
                  ['标题', vstream.displayTitle || vstream.title],
                  ['分辨率', fmtRes(vstream)],
                  ['色彩范围', vstream.range],
                  ['文件大小', fmtGB(source.sizeBytes)],
                  ['码率', fmtMbps(source.bitRate)],
                  ['帧率', vstream.fps ? vstream.fps.toFixed(1) : ''],
                  ['编码', vstream.codec?.toUpperCase()],
                  ['位深', vstream.bitDepth ? vstream.bitDepth + ' 位' : ''],
                  ['色度', vstream.chroma],
                ] as Array<[string, string]>" :key="row[0]">
                  <template v-if="row[1]"><dt>{{ row[0] }}</dt><dd>{{ row[1] }}</dd></template>
                </template>
              </dl>
            </div>
            <div v-if="astream" class="tcard">
              <h3>音频</h3>
              <dl>
                <template v-for="row in [
                  ['标题', astream.title || astream.displayTitle],
                  ['语言', astream.lang],
                  ['编码', astream.codec?.toUpperCase()],
                  ['声道数', fmtCh(astream.channels)],
                  ['码率', fmtMbps(astream.bitRate)],
                  ['采样率', astream.sampleRate ? String(astream.sampleRate) : ''],
                ] as Array<[string, string]>" :key="row[0]">
                  <template v-if="row[1]"><dt>{{ row[0] }}</dt><dd>{{ row[1] }}</dd></template>
                </template>
                <template v-if="(source.audio.length > 1)">
                  <dt>音轨</dt><dd>共 {{ source.audio.length }} 条</dd>
                </template>
                <template v-if="source.subtitle.length">
                  <dt>字幕</dt><dd>{{ source.subtitle.map(s => s.lang || '?').join(' / ') }}</dd>
                </template>
              </dl>
            </div>
          </div>
          <p v-if="item.dateCreated" class="added">入库时间　{{ fmtDateTime(item.dateCreated) }}</p>
        </section>

        <HScroller v-if="crew.length" title="演职员" :count="crew.length" class="block">
          <div v-for="p in crew" :key="p.id" class="person">
            <div class="face">
              <img v-if="faces[p.id]" :src="faces[p.id]" alt="" loading="lazy" />
              <span v-else class="ini">{{ p.name.slice(0, 1) }}</span>
            </div>
            <p class="pn">{{ p.name }}</p>
            <p v-if="p.sub" class="pr">{{ p.sub }}</p>
          </div>
        </HScroller>

        <section v-if="csm?.categories.length" class="block">
          <h2>家长指南</h2>
          <div class="pg">
            <div v-for="c in csm.categories" :key="c.key" class="pgi">
              <p class="pgt">{{ c.label }}</p>
              <div class="pgdots"><i v-for="n in 5" :key="n" :class="{ on: n <= c.level }"></i></div>
              <p class="pgw">{{ LEVEL_WORD[c.level] || '' }}</p>
            </div>
          </div>
        </section>

        <section v-if="genres.length" class="block">
          <h2>分类</h2>
          <div class="chips"><span v-for="g in genres" :key="g" class="chip">{{ g }}</span></div>
        </section>

        <HScroller v-if="backdrops.length" class="block" title="剧照" :count="backdrops.length">
          <img v-for="(b, i) in backdrops" :key="i" class="stillimg" :src="backdropUrl(b)" alt="" loading="lazy" decoding="async" />
        </HScroller>

        <HScroller v-if="similar.length" class="block" title="相似作品" :count="similar.length">
          <div v-for="s in similar" :key="s.tmdbId" class="sim">
            <div class="sposter">
              <img v-if="s.posterPath" :src="posterUrl(s.posterPath)" alt="" loading="lazy" decoding="async" />
              <span v-else class="ph">{{ s.title.slice(0, 1) }}</span>
            </div>
            <p class="stitle">{{ s.title }}</p>
            <p class="smeta"><span v-if="s.voteAverage" class="srate">★ {{ s.voteAverage.toFixed(1) }}</span><span v-if="s.year">{{ s.year }}</span></p>
          </div>
        </HScroller>
      </div>
    </template>
  </div>
</template>

<style scoped>
.page {
  /* Same inset ladder as the lobby: the rail floats, so the content line is its right edge, and the
     bands tuck their art under it. Defining them here lets the HScroller children inherit the math. */
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
  /* Centred on the rail's search button: rail top 16 + its 8 padding + half the 30px button = 39px,
     so a 36px disc sits at 21px. It used to hang off --titlebar-h, one row below that button. */
  top: 21px;
  left: calc(var(--nav-w) + 18px);
  z-index: 4;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(16, 16, 22, 0.42);
  border: 1px solid rgba(255, 255, 255, 0.24);
  backdrop-filter: blur(10px);
  color: #fff;
  transition: background var(--hov) var(--ease), transform var(--hov) var(--ease-out), left var(--rail-dur) var(--rail-ease);
}
.back:hover {
  background: rgba(16, 16, 22, 0.66);
  transform: translateX(-2px);
}
.pad { padding: calc(var(--titlebar-h) + 40px) 44px 0 calc(var(--nav-w) + 44px); }

.hero {
  position: relative;
  /* Same clamp and the same gutter offset as the lobby hero: the backdrop starts on the content line
     and never runs under the floating rail, which is the whole left-bleed complaint. */
  height: clamp(460px, 61vh, 620px);
  margin-left: var(--gutter);
  margin-bottom: 4px;
  display: flex;
  align-items: flex-end;
  overflow: hidden;
  transition: margin-left var(--rail-dur) var(--rail-ease);
}
/* Only the art layer parallaxes; a transform on the clipped .hero box emits a 1px seam at its edge. */
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
  object-position: center 22%;
  animation: kb 18s ease-in-out infinite alternate;
}
@keyframes kb {
  from { transform: scale(1.02); }
  to { transform: scale(1.12) translate3d(0, -1.4%, 0); }
}
/* Press the art down and put white type on it, the way the lobby hero does: a bottom ramp plus a soft
   left gradient, so the copy reads over any backdrop without ever laying a white plate on the poster. */
.wash {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(to top, rgba(6, 8, 14, 0.86) 0, rgba(6, 8, 14, 0.82) 120px, rgba(6, 8, 14, 0.5) max(240px, 42%), rgba(6, 8, 14, 0.12) max(400px, 72%), transparent 100%),
    linear-gradient(90deg, rgba(6, 8, 14, 0.5) 0%, rgba(6, 8, 14, 0.12) 46%, transparent 72%);
}
.hero-in {
  position: relative;
  z-index: 2;
  width: 100%;
  padding: 0 var(--side) 44px 32px;
  will-change: transform, opacity;
}
.copy {
  color: #fff;
}
.text {
  min-width: 0;
  max-width: 640px;
}
h1 {
  margin: 0 0 6px;
  font-size: clamp(28px, 3.6vw, 44px);
  font-weight: 700;
  letter-spacing: -0.4px;
  text-shadow: 0 2px 18px rgba(0, 0, 0, 0.4);
}
.tagline { margin: 0 0 8px; font-size: 14px; font-style: italic; color: rgba(255, 255, 255, 0.82); }
.line { font-size: 13.5px; font-weight: 500; color: rgba(255, 255, 255, 0.86); margin-bottom: 12px; font-variant-numeric: tabular-nums; }
.badges { display: flex; align-items: center; flex-wrap: wrap; gap: 7px 13px; margin-bottom: 14px; }
.b {
  display: inline-flex;
  align-items: center;
  font-size: 13px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 12px rgba(0, 0, 0, 0.7);
}
.rate { color: #ffe08a; }
/* The marks sit straight on the art, so the strip has to read as one line of numbers rather than a row
   of plates: no border, no plate, and the gap between groups barely wider than the gap inside one.
   Everything is aligned by height and never by width — IMDb ships as a box, TMDB and Bangumi as
   wordmarks, and a wordmark squeezed square turns to mush at 18px. */
.b.score { gap: 5px; }
.lg { height: 18px; width: auto; display: block; filter: drop-shadow(0 1px 5px rgba(0, 0, 0, 0.55)); }
.b.score i { font-style: normal; color: #fff; }
.cert { color: rgba(255, 255, 255, 0.92); }
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
}
.actions { display: flex; align-items: center; gap: 12px; }
.play {
  display: inline-flex;
  align-items: center;
  gap: 11px;
  padding: 11px 26px;
  border-radius: 999px;
  background: #f4f4f7;
  color: var(--ink);
  box-shadow: 0 10px 26px rgba(6, 8, 14, 0.4);
  transition: transform var(--hov) var(--ease-out), box-shadow var(--hov) var(--ease), background var(--hov) var(--ease), opacity var(--hov) var(--ease);
}
.play:hover:not(:disabled) { background: #fff; transform: translateY(-1px); box-shadow: 0 14px 32px rgba(6, 8, 14, 0.46); }
.play:active:not(:disabled) { transform: scale(0.97); }
.play:disabled { opacity: 0.5; }
.tri { width: 0; height: 0; border-left: 11px solid var(--ink); border-top: 7px solid transparent; border-bottom: 7px solid transparent; }
.ptxt { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.15; }
.ptxt b { font-size: 15px; font-weight: 650; }
.ptxt i { font-size: 13px; font-weight: 500; opacity: 0.72; font-style: normal; }
.iconb {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: #fff;
  background: rgba(255, 255, 255, 0.16);
  border: 1px solid rgba(255, 255, 255, 0.36);
  backdrop-filter: blur(10px);
  transition: color var(--hov) var(--ease), background var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.iconb:hover { transform: translateY(-1px); background: rgba(255, 255, 255, 0.26); }
.iconb.on { color: #ff5a6a; }

/* Mirrors the lobby's .flow: the bands clip their art here (under the rail) while the plain blocks
   inset to the content line. Children that need the line add their own --gutter padding. */
.flow {
  position: relative;
  z-index: 1;
  margin-left: var(--rail-x);
  overflow-x: clip;
  max-width: 1320px;
}
.flow > .block { margin-top: 26px; }
.block:not(.hrow) {
  padding-left: calc(var(--gutter) - var(--rail-x));
  padding-right: var(--side);
  transition: padding-left var(--rail-dur) var(--rail-ease);
}
h2 { font-size: 18px; font-weight: 700; letter-spacing: -0.2px; margin: 0 0 14px; color: var(--text); }

.ep-head { display: flex; align-items: baseline; gap: 12px; flex: 1; min-width: 0; }
.pick {
  position: relative;
  display: inline-flex;
  align-items: center;
  select {
    appearance: none;
    -webkit-appearance: none;
    padding: 6px 30px 6px 14px;
    border-radius: 999px;
    background: var(--bg-elev);
    border: 1px solid var(--line);
    box-shadow: var(--shadow-sm);
    font-size: 14px;
    font-weight: 650;
    color: var(--text);
    cursor: pointer;
    transition: border-color var(--hov) var(--ease), background var(--hov) var(--ease);
  }
  select:hover { border-color: var(--line-strong); }
  svg { position: absolute; right: 10px; pointer-events: none; color: var(--text-dim); }
}

.epi {
  flex: none;
  width: 280px;
  display: flex;
  flex-direction: column;
  text-align: left;
  padding: 0;
  background: none;
  cursor: pointer;
}
.ethumb {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg-elev-2);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
}
.ethumb img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.ethumb .ph { position: absolute; inset: 0; display: grid; place-items: center; font-size: 30px; font-weight: 700; color: var(--text-faint); background: linear-gradient(150deg, var(--bg), var(--bg-elev-2)); }
.ethumb .disc {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 38px;
  height: 38px;
  margin: -19px 0 0 -19px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: #fff;
  background: rgba(16, 16, 22, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.3);
  backdrop-filter: blur(8px);
  opacity: 0;
  transform: scale(0.72);
  transition: opacity var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.epi:hover .disc { opacity: 1; transform: none; }
.einfo { min-width: 0; margin-top: 11px; }
.emeta { margin: 0; display: flex; gap: 8px; flex-wrap: wrap; font-size: 13px; font-weight: 500; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.emeta .seen { color: var(--text-faint); }
.etitle { margin: 3px 0 0; font-size: 14px; font-weight: 650; color: var(--text); }
.eov {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-dim);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.src { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 18px; }
.srccard {
  width: 210px;
  padding: 14px 16px;
  border-radius: var(--radius);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
}
.sc-top { margin: 0 0 8px; font-size: 15px; font-weight: 700; color: var(--text); }
.sc-meta { margin: 0 0 10px; display: flex; gap: 14px; font-size: 13px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.sc-foot { margin: 0; display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; color: var(--text); }
.sc-foot .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fbf7f; }
.sc-foot .ok { margin-left: auto; color: #3fbf7f; }

.tech { display: flex; gap: 16px; flex-wrap: wrap; }
.tcard {
  flex: 1 1 260px;
  max-width: 380px;
  padding: 16px 18px;
  border-radius: var(--radius);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
}
.tcard h3 { margin: 0 0 12px; font-size: 14px; font-weight: 650; color: var(--text); }
.tcard dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 7px 16px; }
.tcard dt { font-size: 13px; color: var(--text-dim); }
.tcard dd { margin: 0; font-size: 13px; font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
.added { margin: 18px 0 0; font-size: 13px; color: var(--text-dim); }

.person { width: 84px; flex: none; }
.face {
  width: 84px;
  aspect-ratio: 1;
  border-radius: 50%;
  overflow: hidden;
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
}
.face img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ini { display: grid; place-items: center; width: 100%; height: 100%; font-size: 28px; font-weight: 700; color: var(--text-faint); background: linear-gradient(150deg, var(--bg), var(--bg-elev-2)); }
.pn, .pr { margin: 8px 0 0; font-size: 13px; line-height: 1.3; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pr { margin: 2px 0 0; font-weight: 500; color: var(--text-dim); }
.pn { font-weight: 600; color: var(--text); }

.pg { display: flex; gap: 14px; flex-wrap: wrap; }
.pgi {
  flex: 1 1 150px;
  max-width: 210px;
  padding: 14px 16px;
  border-radius: var(--radius);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
}
.pgt { margin: 0 0 10px; font-size: 14px; font-weight: 650; color: var(--text); }
.pgdots { display: flex; gap: 5px; margin-bottom: 8px; }
.pgdots i { width: 22px; height: 5px; border-radius: 3px; background: var(--line-strong); }
.pgdots i.on { background: #f0913a; }
.pgw { margin: 0; font-size: 13px; color: var(--text-dim); }

.chips { display: flex; gap: 9px; flex-wrap: wrap; }
.chip { padding: 6px 14px; border-radius: 999px; background: var(--chip); border: 1px solid var(--line); font-size: 13px; font-weight: 600; color: var(--text); }

.stillimg { flex: none; width: 320px; aspect-ratio: 16 / 9; object-fit: cover; border-radius: var(--radius); border: 1px solid var(--line); box-shadow: var(--shadow-sm); }

.sim { flex: none; width: 150px; }
.sposter { position: relative; aspect-ratio: 2 / 3; border-radius: var(--radius); overflow: hidden; background: var(--bg-elev-2); border: 1px solid var(--line); box-shadow: var(--shadow-sm); }
.sposter img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.sposter .ph { position: absolute; inset: 0; display: grid; place-items: center; font-size: 34px; font-weight: 700; color: var(--text-faint); background: linear-gradient(150deg, var(--bg), var(--bg-elev-2)); }
.stitle { margin: 8px 0 0; font-size: 13px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.smeta { margin: 2px 0 0; display: flex; gap: 8px; font-size: 12.5px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.smeta .srate { color: #b8860b; font-weight: 650; }

.muted { color: var(--text-dim); font-weight: 500; font-size: 13px; }
.err { color: var(--danger); }
.banner { margin: 0 0 12px; padding: 0 44px; }
</style>
