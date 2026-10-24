<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
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
import { libraryWorks, useRelated, REVEAL_MS, type WorkKind, type WorkSeed } from '../lib/related';
import { embyCached } from '../lib/embycache';
import { mergeGenres } from '../lib/genres';
import { beginPlay, workSeedFor } from '../lib/handoff';
import { accountName, episodeHead, fmtDate, fmtMinutes, fmtRuntime, seenLabel, seasonTitle, watchedRatio } from '../lib/format';
import { seasonTarget } from '../lib/resume';
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
/** Whether the page may stop waiting for TMDB's half and treat its silence as the answer. Earned two ways:
 *  the detail ask came back, or it went unanswered for as long as the card's band gives the server. Making
 *  the reader wait for the first alone costs the fallback page TMDB's whole transport timeout (15000 ms,
 *  `src/main/meta/tmdb.ts:159`) before a record this account already holds can be shown. */
const settled = ref(false);
/** Whether the hero may be drawn from the server's record instead of TMDB's. Needs `settled` because a page
 *  whose rows merely arrived first is not yet a page TMDB has nothing to say about, and needs rows because
 *  an unanswered question is not an absence. The row is not handed over by the card that opened the page: a
 *  card holding one points at the detail page instead, so this page can only ever be opened by a card that
 *  had nothing, and it falls back by asking the server the same question over again. A link typed in by hand
 *  therefore stays the dead end it is, with no name left to search the library by. */
const fallback = computed(() => settled.value && !meta.value && libAsked.value && libRows.value.length > 0);
/** Whether the server's answer for this work is still on its way. The red line waits for it: a page that
 *  printed 「TMDB 没有答上」 and then grew a hero two hundred milliseconds later is the collapse this page is
 *  kept free of, and the skeleton below already holds the room the hero takes when it arrives. */
const libPending = ref(false);

const meta = ref<TmdbMeta | null>(null);
const error = ref('');
/** Every Series row this account files the work under. A TMDB id is one work; a server can hold it as
 *  several rows — 81 of this library's shows are — and picking only the fullest one would say 「服务器没有
 *  资源」 about seasons the other row does carry. */
const libRows = ref<LibraryItem[]>([]);
/** Whether the server has answered for this work. Distinct from an empty `libRows`: an unanswered question
 *  is not an absence, and only one of them is a promise about whether the CTA is coming. */
const libAsked = ref(false);
/** The row the hero speaks for and its button opens. One TMDB id is one work, but a server can file it as
 *  several Series rows — 81 of this library's shows — and the rows hold different seasons: opening the first
 *  one back from the query would send the reader to a page holding the thinner half. Counted over the
 *  server's own season rows where those have arrived, and over `ChildCount` until then. */
const libItem = computed(() => {
  const rows = libRows.value;
  if (rows.length < 2) return rows[0] || null;
  const held = (r: LibraryItem): number =>
    serverSeasons.value.reduce((a, g) => (g.row.id === r.id ? a + 1 : a), 0) || r.childCount || 0;
  return rows.reduce((best, r) => (held(r) > held(best) ? r : best), rows[0]);
});
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
/** The server's own wide art for that same row. The band behind the copy is the window's width, and a 300px
 *  poster blown across it is what made a fallback hero look like a frame that had lost its picture. The row
 *  usually has one (measured: 179 of the 200 newest Series rows and 193 of 200 Movies carry a Backdrop tag),
 *  and it is asked only once the page is known to be running on the server's record — a page TMDB answered
 *  has its own shots for that band already. */
const rowWide = ref('');
/** On a fallback page the server's picture comes first: TMDB not answering usually means its image host did
 *  not answer either, and the card's plate is then a frame holding nothing. */
const plateSrc = computed(() =>
  fallback.value ? rowArt.value || seed.value?.url || '' : seed.value?.url || rowArt.value || posterUrl(meta.value?.poster),
);
const heroBackdrop = computed(() => {
  if (fallback.value) return rowWide.value || plateSrc.value;
  return backdrops.value.length ? backdropUrl(backdrops.value[0]) : plateSrc.value;
});
const tmdbUrl = computed(() => (idKey.value ? `https://www.themoviedb.org/${kind.value}/${props.tmdbId}` : ''));

/** Every season this work has, on either side of the pair, in one number-ordered list — the union the detail
 *  page keeps. TMDB's table names, dates and scores a season, so it owns those columns; the episode count
 *  belongs to the machine holding the files (measured: the server's own ChildCount matched the rows it
 *  returned 20 of 20 times, while the two sides disagreed on 2 of the 20 seasons both of them know). Where
 *  two Series rows carry the same number they overlap rather than continue each other, so the fullest one
 *  answers, which is also how the row below picks its files. On a page built out of the server's record the
 *  server's rows are the whole list either way. */
const seasons = computed<TmdbSeasonRow[]>(() => {
  if (kind.value !== 'tv') return [];
  const byN = new Map<number, TmdbSeasonRow>();
  for (const s of meta.value?.seasons || []) byN.set(s.n, { ...s });
  const held = new Map<number, { count: number; name: string }>();
  for (const g of serverSeasons.value) {
    const n = g.season.indexNumber ?? 0;
    if (n < 0) continue;
    const count = g.season.childCount || 0;
    const best = held.get(n);
    if (!best || count > best.count) held.set(n, { count, name: g.season.name });
  }
  for (const [n, g] of held) {
    const cur = byN.get(n);
    // A row that bills no files is not an answer about a season TMDB has a full list for.
    if (cur) cur.epCount = g.count || cur.epCount;
    else byN.set(n, { n, epCount: g.count, airDate: '', poster: '', name: g.name });
  }
  return [...byN.values()].sort((a, b) => a.n - b.n);
});
/** The seasons 「N 季」 counts. TMDB bills a season that has not been filmed yet — measured: 孤独摇滚 第 2 季
 *  and 碧蓝之海 第 4 季 each arrive with 0 集 — and an announcement is nothing to watch. */
const counted = computed(() => seasons.value.filter(s => s.n >= 1 && s.epCount > 0));
/** The season the page opens on: the first numbered one with files behind it, falling back to the head of
 *  the list. Both the TMDB table and the server's rows are asked this way, so the two cannot disagree about
 *  which season a fresh page lands on. */
const firstSeasonN = (rows: TmdbSeasonRow[]): number | undefined => (rows.find(s => s.n >= 1 && s.epCount) || rows[0])?.n;
const season = computed(() => seasons.value.find(s => String(s.n) === seasonPick.value) || null);
const seasonOptions = computed(() => seasons.value.map(s => ({ value: String(s.n), label: seasonTitle(s.n, s.name) })));

/** A click on the season already on screen comes back as the picker's clear gesture. This band always shows
 *  a season, so an empty answer keeps the one on screen instead of blanking it. */
function pickSeason(v: string | string[]): void {
  if (typeof v !== 'string' || !v) return;
  seasonPick.value = v;
}

const overviewText = computed(() => meta.value?.overviewZh || meta.value?.overviewOther || (fallback.value ? libItem.value?.overview || '' : ''));
/** 分类 is TMDB's list with the server's own labels appended (measured: 动画 | 喜剧 on 百变的七仓同学), which
 *  is the same fact stated by the machine holding the file. Either way it goes through the one alias table
 *  the rest of the app folds with, so this page and the detail page cannot spell the same genre two ways
 *  (measured here: TMDB answers Sci-Fi & Fantasy in English for some of these works, and 详情页 turned that
 *  into 科幻奇幻 while this page printed it raw). */
const shownGenres = computed<string[]>(() => mergeGenres(meta.value?.genres, fallback.value ? libItem.value?.genres : []));
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

/* TMDB files a face for a credit it sometimes has no picture for any more, and the initial under it is
   already the other half of that test — so a face that will not decode only has to retire its URL. */
const faceDead = ref<Record<string, true>>({});
const faceOf = (p: { face: string }): string => (p.face && !faceDead.value[p.face] ? p.face : '');
const onFaceFail = (p: { face: string }): void => {
  if (p.face) faceDead.value = { ...faceDead.value, [p.face]: true };
};

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

/** The season on screen, stated exactly the way the detail page states its own: 「2018-07-14 · 12 集 ·
 *  4小时51分钟」. This line used to speak for the whole work — its year and a count summed over every season
 *  the account holds — and under a picker the reader has just switched to 第 1 季 that read as 第 1 季's own
 *  number (measured: 104 集 printed over rails of 90, 66 and 19 cards). One subject per line, and the
 *  work-level facts the line no longer carries are the picker's rows. */
const pack = computed(() => {
  const s = season.value;
  const row = serverRow.value;
  if (!s && !row) return null;
  const held = serverBand.value;
  return {
    date: fmtDate(s?.airDate) || fmtDate(row?.season.premiereDate),
    eps: s?.epCount || 0,
    /* Only ever summed from rows that belong to this season: a Series row's own RunTimeTicks is neither its
       seasons' nor its episodes' (measured on the detail page: 64 分钟 billed for a season that runs
       17小时18分). A season TMDB lists and this account has no files for has no length to print. */
    runtime: held ? fmtRuntime(held.reduce((a, e) => a + (e.runTimeTicks || 0), 0)) : '',
  };
});

const metaLine = computed(() => {
  const p = pack.value;
  if (kind.value === 'tv' && p) return [p.date, p.eps ? `${p.eps} 集` : '', p.runtime].filter(Boolean).join(' · ');
  const m = meta.value;
  if (!m) {
    // The row's own caption, and only what the server actually claims, for the window before its season
    // rows arrive: TMDB's table is the very thing that did not answer, so there is nothing else to print.
    const r = libItem.value;
    if (!r) return '';
    // A Series row comes without ProductionYear (measured: absent on 碧蓝之海) while its own premiere date
    // is there, so the year is taken from whichever of the two the row carries.
    const y = String(r.productionYear || '') || (r.premiereDate || '').slice(0, 4);
    // The count is the page's, not the row's: a work split across several Series rows has more seasons than
    // any one of them bills (measured: 碧蓝之海 files three rows, each claiming one season). So the line says
    // nothing about seasons until the season rows have answered, rather than borrowing one row's figure.
    const n = counted.value.length;
    return [y, r.type === 'Series' && n ? `${n} 季` : '', r.type === 'Movie' && r.runTimeTicks ? fmtRuntime(r.runTimeTicks) : '']
      .filter(Boolean)
      .join(' · ');
  }
  return [String(year.value || ''), kind.value === 'tv' ? '' : fmtMinutes(m.runtime)].filter(Boolean).join(' · ');
});

/* A still that will not decode has to step down to the letter rather than leave a bare 16:9 box: this page
   holds no second picture for an episode, so the one rung it has is the placeholder the `v-else` draws. */
const imgDead = ref<Record<string, true>>({});
const liveImg = (key: string, url: string): string => (url && !imgDead.value[key] ? url : '');
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
        img: liveImg(e.id, stillUrl(r?.p)),
        date: fmtDate(e.premiereDate) || fmtDate(r?.air),
        len: fmtRuntime(e.runTimeTicks) || fmtMinutes(r?.rt),
        seen: seenLabel(e.userData, e.runTimeTicks),
        played: Math.round(watchedRatio(e.userData, e.runTimeTicks) * 100),
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
        img: liveImg(`t${k}`, stillUrl(r?.p)),
        date: fmtDate(r?.air),
        len: fmtMinutes(r?.rt),
        seen: '',
        played: 0,
        to: '',
      };
    });
});

const epiBand = ref<InstanceType<typeof HScroller> | null>(null);
/** The card the row should open on: this season's own stop, read off the rows the server handed for it. -1
 *  when the band is TMDB's list rather than files — those rows carry no `userData`, so nothing here knows how
 *  far the reader got — and -1 for a season never started. Both are read from the front. The rows are already
 *  in hand, so this costs no request, which is the one thing the detail page could not do.
 *  `seasonTarget`'s own fallback (its first episode) is not turned into an index: card 0 is where the band
 *  already opens, and the detail page's second tier cannot be copied here, because over a whole season's rows
 *  「not yet finished」 is true of every episode nobody watched. */
const stopIndex = computed(() => {
  const rows = serverBand.value;
  if (!rows) return -1;
  const t = seasonTarget(rows);
  return t?.resumed ? rows.findIndex(e => e.id === t.item.id) : -1;
});
/* One glide per season, keyed instead of unconditional: the cards re-paint again when TMDB's stills arrive a
   beat after the server's rows, and a watcher that ran on every recompute would pull the reader back onto the
   stopped episode while they were already looking for the one past it. The rows themselves are the source, not
   their count: TMDB's list of the same season is painted first and then replaced by the server's files, and
   where the two hold the same number of episodes a count never changes — measured on 朋友的妹妹, seven stills
   then seven files, so the band kept its own resting position and 第 4 集 sat 408px right of the middle
   while its card printed 「看到 0:59」. `epiBand` is a source because this band, unlike the detail page's, is
   not unmounted for the season switch — the same instance answers from the first season to the last. */
let focusedOn = '';
watch([seasonPick, () => serverBand.value, () => eps.value.length, () => epiBand.value], async () => {
  if (!epiBand.value || !eps.value.length) return;
  // -1 is a season with no stop in it, and the ask is card 0 just the same: a rail left wherever the previous
  // season put it is the stale scrollLeft the detail page was fixed for. Measured here before that half was
  // written — 火影忍者's 第 2 季 is a season TMDB lists and this account files under other numbers, so the band
  // is TMDB's names with no rows to read a stop from, and after 第 1 季 had sent the rail to 2172px for 第 224
  // 集 that is where 第 2 季 opened: 第 54 集 under the reader's eye for a season they had never started.
  const i = Math.max(0, stopIndex.value);
  const key = `${seasonPick.value}:${i}`;
  if (focusedOn === key) return;
  await nextTick();
  // Only a stop is carried to the middle. Centring card 0 would pull the season's own tail clones in front of
  // it and leave 第 1 集 off the reader's left.
  if (epiBand.value.focusCard(i, i > 0)) focusedOn = key;
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
    // The spent glide key belongs to the season being blanked, not to the page: keeping it is what strands
    // the next season's band on the distance the previous one scrolled.
    focusedOn = '';
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
  settled.value = false;
  libRows.value = [];
  libAsked.value = false;
  libPending.value = false;
  rowArt.value = '';
  rowWide.value = '';
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
  /* The server's rows are asked for the moment the page opens, under the name the card printed, because
     waiting for the detail ask would make a fallback page sit through a round trip that may be on its way to
     failing. That name is TMDB's from one of its own lists, which is not a promise it is the name the detail
     answer carries: the second ask below is what covers the case where the two differ. The window given here
     is the one the card's band already uses, so no half of this page may hold the reader longer than the
     other. Which is also why a hand-typed link cannot be rescued: no card, so no name. */
  const cardTerm = seed.value?.name || '';
  if (cardTerm) {
    libPending.value = true;
    void libraryWorks(k, props.tmdbId, cardTerm).then(rows => {
      if (mine === run) takeRows(rows, mine);
    });
  }
  const grace = setTimeout(() => {
    if (mine === run) settled.value = true;
  }, REVEAL_MS);
  const r = await window.echoemby.meta.tmdb({ kind: k, tmdbId: props.tmdbId });
  clearTimeout(grace);
  if (mine !== run) return;
  settled.value = true;
  if (!r.ok || !r.data) {
    // The main process already words a transport failure as 「TMDB 没有答上（…）」, so wrapping it here twice
    // is the only thing that would need saying about it.
    error.value = r.error || 'TMDB 没有这一部';
  } else {
    meta.value = r.data;
    seasonPick.value = String(firstSeasonN(r.data.seasons) ?? '');
    void window.echoemby.meta.tmdbImages({ kind: k, tmdbId: props.tmdbId }).then(x => {
      if (mine === run && x.ok) backdrops.value = x.data || [];
    });
    void app.workLogos(k, props.tmdbId).then(u => {
      if (mine === run) logos.value = u;
    });
  }
  /* When TMDB replies the rows are what badges 「可播」 and tell the seasons apart; when it does not, they are
     the whole page. The card's spelling may already be on its way or answered, and a work filed under a
     different title on either side makes that answer worthless: 明日酱的水手服 searches the library for a
     string it does not hold while 明日同学的水手服 sits in it. So the name that just arrived gets its own
     ask, keeping the card's as the second spelling — which is also what puts it on a different cache key,
     since the same key would only hand back the first ask's silence. */
  const term = meta.value?.name || '';
  if (cardTerm && (libPending.value || libAsked.value)) {
    if (term && term !== cardTerm && !libRows.value.length) {
      libPending.value = true;
      void libraryWorks(k, props.tmdbId, term, cardTerm).then(rows => {
        if (mine === run) takeRows(rows, mine);
      });
    }
    return;
  }
  if (!term) return;
  libPending.value = true;
  void libraryWorks(k, props.tmdbId, term).then(rows => {
    if (mine === run) takeRows(rows, mine);
  });
}

/** One server answer, whichever of the page's two asks brought it. `null` is a server that has not answered,
 *  not one that holds nothing: the hero keeps its silence rather than promise 「这台服务器上没有」 about a
 *  title nobody has been asked for. */
function takeRows(rows: LibraryItem[] | null, mine: number): void {
  libPending.value = false;
  if (!rows) return;
  libRows.value = rows;
  libAsked.value = true;
  void askSeasons(rows, mine);
}

/** The seasons of every Series row this account holds for the work, and the episodes of the one on screen.
 *  Both paths into the page ask through here: the answered one, over all of the rows a TMDB title matches,
 *  and the fallback, over the single row the click came from. */
async function askSeasons(rows: LibraryItem[], mine: number): Promise<void> {
  // The page running on the server's record should carry the server's picture, but only when TMDB's half did
  // not arrive: on a finished page the card's own art is already the plate and this would repaint it. Asked
  // for the row the hero speaks for, so the plate and the 播放 button are the same row's.
  const home = libItem.value;
  if (!meta.value && home?.primaryImageTag) {
    void app.imageUrl({ id: home.id, primaryImageTag: home.primaryImageTag }, 300).then(u => {
      if (mine === run) rowArt.value = u;
    });
  }
  const series = rows.filter(x => x.type === 'Series');
  if (!series.length) return;
  const groups = await Promise.all(
    series.map(async row => ({ row, s: await embyCached('seasons', row.id, () => window.echoemby.emby.seasons(row.id)) })),
  );
  if (mine !== run) return;
  const before = serverRow.value;
  const picked = seasonPick.value;
  serverSeasons.value = groups.flatMap(g => (g.s.ok ? g.s.data || [] : []).map(season => ({ row: g.row, season })));
  // A page with no TMDB table to open on still has to land on a season: the first one with files behind it.
  if (!picked) {
    const first = firstSeasonN(seasons.value);
    if (first !== undefined) seasonPick.value = String(first);
  }
  // Re-run only where the season on screen changed hands. The stills are already on screen and a second
  // load blanks them first, so a season that had an answer and kept it does not get asked again. A first
  // pick is not a re-run: the picker's own watch is what loads it.
  if (seasonPick.value === picked && serverRow.value !== before) void loadSeason();
}

watch(idKey, loadWork, { immediate: true });
watch(seasonPick, () => void loadSeason());

/* The band behind a fallback hero. Asked once the page is known to be running on the server's record rather
   than with the plate, because the plate is needed the moment the hero is drawn — an empty `.art` box would
   move the text column beside it — while this band can take the extra round trip and fade into place. A row
   with no wide tag borrows its poster at a width the band can survive, which is the same ladder the detail
   page climbs. Re-run when the row the hero speaks for changes hands: a split work learns which of its rows
   is the fullest only once the season lists land. */
watch([fallback, libItem], () => {
  const home = libItem.value;
  if (!fallback.value || !home) return;
  const mine = run;
  const wide = home.backdropImageTag
    ? app.backdropUrl({ id: home.id, backdropImageTag: home.backdropImageTag }, 1600)
    : home.primaryImageTag
      ? app.imageUrl({ id: home.id, primaryImageTag: home.primaryImageTag }, 1000)
      : Promise.resolve('');
  rowWide.value = '';
  void wide.then(u => {
    if (mine === run) rowWide.value = u;
  });
});

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
      <HeroSkeleton v-if="!meta && (!error || libPending) && !fallback" :poster="plateSrc" />
      <section v-else-if="meta || fallback" class="hero">
        <div class="stage" :style="{ transform: `translate3d(0, ${Math.round(scroll * 0.28)}px, 0)` }">
          <img v-reveal v-if="heroBackdrop" :key="heroBackdrop" :src="heroBackdrop" alt="" decoding="async" />
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

    <p v-if="error && !fallback && !libPending" class="err pad">{{ error }}</p>
    <!-- Stands on its own words: this state is now also reached by TMDB staying silent rather than by TMDB
         answering, so its sentence is frequently not written yet when the page is. The reason it was silent
         is what the raw string carries, and it belongs to anyone who asks, not to the reading line. -->
    <p v-else-if="fallback" class="miss" :title="error">这一页摆的是 {{ serverName }} 上的这条记录，TMDB 那半没有答上。</p>

    <div v-if="meta || fallback" class="flow">
      <HScroller v-if="seasons.length" ref="epiBand" class="block epi-row">
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
            <img v-reveal v-if="e.img" :src="e.img" alt="" loading="lazy" decoding="async" @error="imgDead[e.key] = true" />
            <span v-else class="ph">{{ e.head.slice(0, 1) }}</span>
            <span v-if="e.to" class="disc" role="presentation">
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 5l12 7-12 7z" fill="currentColor" /></svg>
            </span>
            <span v-if="e.seen" class="echip">{{ e.seen }}</span>
            <div v-if="e.played > 0" class="frame-prog"><i :style="{ width: e.played + '%' }"></i></div>
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
            <img v-reveal v-if="faceOf(p)" :src="faceOf(p)" alt="" loading="lazy" @error="onFaceFail(p)" />
            <span v-else class="ini">{{ p.name.slice(0, 1) }}</span>
          </div>
          <p class="pn">{{ p.name }}</p>
          <p v-if="p.sub" class="pr">{{ p.sub }}</p>
        </div>
      </HScroller>

      <section v-if="shownGenres.length" class="block">
        <h2>分类</h2>
        <div class="chips"><span v-for="g in shownGenres" :key="g" class="chip">{{ g }}</span></div>
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
  left: 10px;
  bottom: 22px;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 650;
  color: #fff;
  background: rgba(9, 11, 18, 0.72);
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
