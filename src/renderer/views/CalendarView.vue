<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { CalendarPool, CalendarQuiet, CalendarResult, CalendarSlot } from '../../shared/types';
import CalendarDayCard from '../components/calendar/CalendarDayCard.vue';
// The档 and their colours are one table shared with the day cards, so a chip's dot and a card's dot cannot
// drift apart. See lib/pools.ts.
import { CAL_POOLS as POOLS, poolColor, poolLabel } from '../lib/pools';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const router = useRouter();

const DAY = 86_400_000;
/** How far ahead the page asks and draws. One number for both, so a day a reader scrolls to is never a day
 *  the page cannot answer — and never a day the main process dated and threw away either. */
const BAND = 90;
/** How far behind today the timeline reaches, and the reason the ask starts where it does. A 追剧日历
 *  answers 「what is coming」, and the week just past is the part of that question with a second use —
 *  「did I miss one」. Nothing on this page reaches further, so nothing is fetched further either. */
const PAST_DAYS = 7;

const WEEK = ['一', '二', '三', '四', '五', '六', '日'];

const pad = (n: number): string => String(n).padStart(2, '0');
const fmt = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOf = (s: string): Date => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
const today = fmt(new Date());
const todayMs = dayOf(today).getTime();
/** Monday-anchored, because that is where the 「上周 / 本周播出 / 下周播出」 separators cut the timeline. */
const weekStartMs = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - ((d.getDay() + 6) % 7) * DAY;
const thisWeekMs = weekStartMs(dayOf(today));
const weekOffset = (s: string): number => Math.round((weekStartMs(dayOf(s)) - thisWeekMs) / (7 * DAY));

const pool = ref<'' | CalendarPool>('');

const data = ref<CalendarResult | null>(null);
const loading = ref(true);
const error = ref('');

/** `force` is the 刷新 button: a date that slipped or a season that finally started is the one thing a
 *  reader comes back for, and the cache would otherwise hold the stale answer for three more days. */
async function load(force = false): Promise<void> {
  loading.value = true;
  error.value = '';
  const r = await window.echoemby.calendar.schedule({
    from: fmt(new Date(todayMs - PAST_DAYS * DAY)),
    to: fmt(new Date(todayMs + BAND * DAY)),
    force,
  });
  loading.value = false;
  if (r.ok && r.data) data.value = r.data;
  else error.value = r.error || '日历没有答上';
}

const slots = computed<CalendarSlot[]>(() => data.value?.slots || []);
const shown = computed<CalendarSlot[]>(() => (pool.value ? slots.value.filter((s) => s.pool === pool.value) : slots.value));
const quiet = computed<CalendarQuiet[]>(() => {
  const q = data.value?.quiet || [];
  return pool.value ? q.filter((x) => x.pool === pool.value) : q;
});

const byDay = computed(() => {
  const m = new Map<string, CalendarSlot[]>();
  for (const s of shown.value) {
    const list = m.get(s.date);
    if (list) list.push(s);
    else m.set(s.date, [s]);
  }
  return m;
});

/** One group per day the answer carries, plus today itself even when it is empty: 「今天没有更新」 is an
 *  answer, and its absence is the difference between a quiet day and a page that broke. The ask already cut
 *  the band, so nothing here has to filter a date out. */
const days = computed(() => {
  const out = [...byDay.value.entries()].map(([date, items]) => ({ date, items }));
  if (!byDay.value.has(today)) out.push({ date: today, items: [] });
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
});

interface WeekGroup {
  label: string;
  groups: { date: string; items: CalendarSlot[] }[];
}

/** `days` cut at every Monday, which is where the reference surface puts its 「下周播出」 bar. */
const weeks = computed<WeekGroup[]>(() => {
  const out: WeekGroup[] = [];
  let week = Number.NaN;
  for (const g of days.value) {
    const w = weekOffset(g.date);
    if (w !== week) {
      week = w;
      out.push({ label: weekName(w), groups: [] });
    }
    out[out.length - 1].groups.push(g);
  }
  return out;
});

const counts = computed(() => {
  const m: Record<string, number> = {};
  for (const s of slots.value) m[s.pool] = (m[s.pool] || 0) + 1;
  return m;
});

/** Tier 3 of the date column. A day inside this week is counted in days, because that is how far the eye
 *  places 「周四」 on its own; once the week changes, the week carries the number — which is also what the
 *  separator above it says, so the two never disagree. */
function relOf(s: string): string {
  const shift = Math.round((dayOf(s).getTime() - todayMs) / DAY);
  if (shift === 0) return '今天';
  if (shift === 1) return '明天';
  if (shift === 2) return '后天';
  if (shift === -1) return '昨天';
  const w = weekOffset(s);
  if (w === 0) return shift > 0 ? `${shift}天后` : `${-shift}天前`;
  if (w === 1) return '下周';
  if (w === 2) return '下下周';
  if (w === -1) return '上周';
  if (w === -2) return '上上周';
  return w > 0 ? `${w} 周后` : `${-w} 周前`;
}

function weekName(w: number): string {
  if (w === 0) return '本周播出';
  if (w === 1) return '下周播出';
  if (w === 2) return '下下周播出';
  if (w === -1) return '上周';
  if (w === -2) return '上上周';
  return w > 0 ? `${w} 周后` : `${-w} 周前`;
}

function mmdd(s: string): string {
  return `${s.slice(5, 7)}/${s.slice(8, 10)}`;
}

/** An empty day names the filter that emptied it, so 「这天没有」 is never read as 「页面没数据」. */
function noneText(): string {
  const l = poolLabel(pool.value);
  return l ? `这天没有「${l}」的更新。` : '这天没有排上日期的更新。';
}

/** Which of the two silences it is: the season has dates and they are all behind the page, or TMDB has
 *  dated nothing for it. `第N季` is dropped when TMDB never named a season at all. */
function quietNote(q: CalendarQuiet): string {
  const s = q.season ? `第${q.season}季 · ` : '';
  return q.lastDate ? `${s}上一集 ${mmdd(q.lastDate)}` : `${s}未排期`;
}

function openQuiet(q: CalendarQuiet): void {
  if (q.seriesId) void router.push(`/detail/${q.seriesId}`);
}

const pageEl = ref<HTMLElement | null>(null);
const bandEl = ref<HTMLElement | null>(null);
const tlEl = ref<HTMLElement | null>(null);

/** The band is sticky, so the distance a day group has to clear is its own height — and that height is not
 *  a constant: the chip row wraps when the rail collapses or the window narrows. Writing the measured number
 *  onto the scroller keeps one source of truth, because `topDay()` reads the same property back. */
function syncPad(): void {
  const band = bandEl.value;
  const page = pageEl.value;
  if (!band || !page) return;
  page.style.scrollPaddingTop = `${band.offsetHeight + 10}px`;
}
let bandRo: ResizeObserver | null = null;

function gotoDay(date: string): void {
  tlEl.value?.querySelector<HTMLElement>(`[data-day="${date}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** The band never scrolls, so 「回到今天」 is a scroll, not a re-render. */
function backToToday(): void {
  gotoDay(today);
}

/** The day group currently reading at the top of the page — which is what 「下一天」 has to step from.
 *  Asking the DOM rather than keeping a pointer in sync with the scroll wheel is the whole trick, and the
 *  threshold is the scroller's own `scroll-padding-top` so the two rules cannot drift apart.
 *  The grace is why a group whose header still hangs a little under the band counts as the one being read:
 *  without it the top of the page answers 「nothing」 and the first → leaps past every day above today. */
function topDay(): string | null {
  const root = tlEl.value;
  const page = pageEl.value;
  if (!root || !page) return null;
  const edge = page.getBoundingClientRect().top + (parseFloat(getComputedStyle(page).scrollPaddingTop) || 0) + 48;
  let best: string | null = null;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-day]'))) {
    if (el.getBoundingClientRect().top <= edge) best = el.dataset.day || null;
    else break;
  }
  return best;
}

function stepDays(d: number): void {
  const list = days.value;
  if (!list.length) return;
  const at = topDay();
  // -1 is also the honest answer for 「above the first group」, which is where the page opens.
  const i = at ? list.findIndex((g) => g.date === at) : -1;
  const n = Math.min(list.length - 1, Math.max(0, i + d));
  gotoDay(list[n].date);
}

function onKey(e: KeyboardEvent): void {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    stepDays(e.key === 'ArrowLeft' ? -1 : 1);
    e.preventDefault();
  }
}

watch(
  () => store.account?.accountId,
  (id) => {
    if (id) void load();
  },
);

onMounted(() => {
  window.addEventListener('keydown', onKey);
  if (bandEl.value) {
    bandRo = new ResizeObserver(() => syncPad());
    bandRo.observe(bandEl.value);
  }
  syncPad();
  if (!data.value) void load().then(() => void nextTick(() => { syncPad(); gotoDay(today); }));
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  bandRo?.disconnect();
  bandRo = null;
});
</script>

<template>
  <div ref="pageEl" class="page">
    <!-- The whole top block stays put while the days scroll under it. It carries the two things a reader
         re-checks mid-list — what today is, and which pool is filtering the list — and neither can be read
         from somewhere off-screen. -->
    <div ref="bandEl" class="band">
      <header class="head">
        <div class="ht">
          <h1>追剧日历</h1>
          <p class="sub">
            <b>{{ mmdd(today) }}</b> · 周{{ WEEK[(dayOf(today).getDay() + 6) % 7] }} · {{ relOf(today) }}
          </p>
        </div>
        <span class="tools">
          <button class="tday" :disabled="loading" @click="load(true)">刷新</button>
          <button class="tday" @click="backToToday()">回到今天</button>
        </span>
      </header>

      <div class="chips">
        <button class="chip" :class="{ on: pool === '' }" @click="pool = ''">全部<b>{{ slots.length }}</b></button>
        <button v-for="p in POOLS" :key="p.key" class="chip" :class="{ on: pool === p.key }" @click="pool = p.key">
          <i class="dot" :style="{ background: p.color }"></i>{{ p.label }}<b>{{ counts[p.key] || 0 }}</b>
        </button>
      </div>
    </div>

    <p v-if="error" class="err">{{ error }} <button @click="load()">重试</button></p>
    <p v-else-if="data && data.failed.length" class="warn">
      TMDB 这次没答上：{{ data.failed.join('、') }}。<button @click="load()">现在重试</button>
    </p>

    <!-- One row per day, its date held in a column that says the same day three ways, and that day's
         episodes as cards beside it. -->
    <div v-if="loading" class="tl">
      <section v-for="g in 4" :key="g" class="grp">
        <span class="dcol sk"><i></i><i></i><i></i></span>
        <span class="cards">
          <span v-for="c in (g === 4 ? 2 : 3)" :key="c" class="card sk"></span>
        </span>
      </section>
    </div>

    <div v-else-if="!shown.length" class="void">
      <!-- Nothing to draw is three different answers here, and the page says which one it is. -->
      <p v-if="data && data.noKey">
        还没有填 TMDB 的密钥，日历排不出任何一天。
        <button @click="router.push('/settings')">去设置 · 元数据</button>
      </p>
      <p v-else-if="slots.length">
        「{{ poolLabel(pool) }}」这一档在往后 {{ BAND }} 天里没有更新。<button @click="pool = ''">看全部</button>
      </p>
      <p v-else-if="quiet.length">名单里的 {{ quiet.length }} 部还在更，TMDB 一部也没排出日期 —— 列在下面。</p>
      <p v-else>这台服务器里没有「收藏 ∪ 在看」还认作在更的作品。</p>
    </div>

    <div v-else ref="tlEl" class="tl">
      <template v-for="w in weeks" :key="w.label">
        <p class="sep"><span>{{ w.label }}</span></p>
        <section v-for="g in w.groups" :key="g.date" class="grp" :data-day="g.date">
          <span class="dcol" :class="{ now: g.date === today }">
            <b>周{{ WEEK[(dayOf(g.date).getDay() + 6) % 7] }}</b>
            <i>{{ mmdd(g.date) }}</i>
            <em>{{ relOf(g.date) }}</em>
          </span>
          <span v-if="g.items.length" class="cards">
            <CalendarDayCard
              v-for="s in g.items"
              :key="`${s.tmdbId}-${s.season}-${s.episode}`"
              :slot="s"
              :past="s.date < today"
            />
          </span>
          <p v-else class="none">{{ noneText() }}</p>
        </section>
      </template>
      <p class="end">已到底部 · 这一页往前 {{ PAST_DAYS }} 天、往后 {{ BAND }} 天</p>
    </div>

    <!-- The followed shows none of the timeline above carries a day for, spelled out rather than folded:
         a click to discover that nothing is coming is the same silence this list exists to break. -->
    <section v-if="!loading && quiet.length" class="quiet">
      <h2>这些还没排上更新</h2>
      <span class="qgrid">
        <component
          v-for="q in quiet"
          :is="q.seriesId ? 'button' : 'div'"
          :key="q.tmdbId"
          class="qrow"
          :class="{ go: !!q.seriesId }"
          @click="openQuiet(q)"
        >
          <i class="dot" :style="{ background: poolColor(q.pool) }"></i>
          <b>{{ q.name }}</b>
          <em>{{ quietNote(q) }}</em>
        </component>
      </span>
    </section>
  </div>
</template>

<style scoped>
.page {
  --side: clamp(10px, 1.8vw, 26px);
  --gutter: calc(var(--nav-w) + var(--side));
  --col: 74px;
  position: relative;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 var(--side) 46px var(--gutter);
  /* What `block: 'start'` means here: a day group stops this far below the top of the scroller, so the
     sticky band never lands on the date column it is being scrolled to. syncPad() overwrites this with the
     band's measured height the moment it mounts — the chip row wraps at narrow widths, so no constant fits. */
  scroll-padding-top: calc(var(--titlebar-h) + 96px);
  transition: padding var(--rail-dur) var(--rail-ease);
}
/* The band is sticky and bleeds to both window edges, so a card travelling past it never shows beside it.
   Its ground is the page's own ground: `attachment: fixed` resolves the wash against the viewport, which is
   exactly how base.css paints it, so the band is the same rectangle of that gradient it sits on rather
   than a flat slab cutting the pastel top of the page in half. */
.band {
  position: sticky;
  top: 0;
  z-index: var(--z-top);
  margin: 0 calc(-1 * var(--side)) 0 calc(-1 * var(--gutter));
  padding: calc(var(--titlebar-h) + 16px) var(--side) 12px var(--gutter);
  background-color: var(--bg);
  background-image: var(--wash);
  background-attachment: fixed;
  transition: padding var(--rail-dur) var(--rail-ease);
}
.head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 22px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.ht {
  min-width: 0;
}
h1 {
  margin: 0;
  font-size: clamp(22px, 2.6vw, 30px);
  font-weight: 700;
  letter-spacing: -0.3px;
  color: var(--text);
}
.sub {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 18px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.sub b {
  font-weight: 650;
  color: var(--text-dim);
}
/* Both controls borrow the 搜索 page's button box — see `.pill` in components/browse/FilterSelect.vue:
   34px, a rounded rectangle rather than a stadium, elevated fill, hairline, and `--shadow-sm`. */
.tday {
  flex: none;
  height: 34px;
  padding: 0 12px;
  border-radius: var(--radius);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-dim);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
  transition: color var(--hov) var(--ease), border-color var(--hov) var(--ease), transform var(--hov) var(--ease-out);
}
.tday:hover {
  border-color: var(--line-strong);
  color: var(--text);
}
.tday:active {
  transform: scale(0.96);
  transition-duration: 0.1s;
}
/* The two answers the band offers are one box each, so they travel together and stay the same height while
   one of them is dimmed out. */
.tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.tday:disabled {
  opacity: 0.55;
}
.tday:disabled:hover {
  border-color: var(--line);
  color: var(--text-dim);
}

.chips {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 34px;
  padding: 0 12px;
  border-radius: var(--radius);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-dim);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
  transition: color var(--hov) var(--ease), background var(--hov) var(--ease), border-color var(--hov) var(--ease),
    transform var(--hov) var(--ease-out);
}
.chip:hover {
  border-color: var(--line-strong);
  color: var(--text);
}
.chip:active {
  transform: scale(0.96);
  transition-duration: 0.1s;
}
/* The search page's engaged answer, read off a pill that has a value picked: the fill drops to `--chip`,
   the border steps out, and the label keeps its dim colour — only the answer it carries brightens, which
   is `.val` and lives on the number below. A selected chip whose whole label went bold would also read as
   heavier than the control it was copied from. */
.chip.on {
  background: var(--chip);
  border-color: transparent;
}
/* The number is this pill's answer, so it takes the brighter colour the search page gives a picked value. */
.chip b {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
.dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
}
.err {
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--danger);
}
.err button {
  margin-left: 6px;
  font-size: 13px;
  color: var(--accent);
  text-decoration: underline;
}
.warn {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 19px;
  color: var(--text-faint);
}
.warn button {
  margin-left: 4px;
  font-size: 13px;
  color: var(--accent);
  text-decoration: underline;
}

.tl {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sep {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 14px 0 8px;
}
.sep::before,
.sep::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--line);
}
.sep span {
  font-size: 13px;
  line-height: 18px;
  color: var(--text-faint);
}

.grp {
  display: grid;
  grid-template-columns: var(--col) minmax(0, 1fr);
  gap: 14px;
  padding: 8px 0 14px;
}
.dcol {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-top: 2px;
  text-align: left;
}
.dcol b {
  font-size: 16px;
  font-weight: 650;
  line-height: 22px;
  color: var(--text);
}
.dcol i {
  font-size: 13px;
  font-style: normal;
  line-height: 18px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.dcol em {
  font-size: 13px;
  font-style: normal;
  line-height: 18px;
  color: var(--text-faint);
}
.dcol.now em {
  color: var(--accent);
  font-weight: 600;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 10px;
  align-items: stretch;
  min-width: 0;
}
.none {
  margin: 0;
  align-self: center;
  font-size: 13px;
  line-height: 20px;
  color: var(--text-faint);
}
.end {
  margin: 22px 0 0;
  text-align: center;
  font-size: 13px;
  color: var(--text-faint);
}

.void {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--text-dim);
}
.void button {
  margin-left: 6px;
  font-size: 13px;
  color: var(--accent);
  text-decoration: underline;
}

/* The 还没排上 list is the page's footnote, not a second subject: no cards, no posters, one line each, and
   the same pool dot so a name here is coded by the档 it would filter to. */
.quiet {
  margin: 26px 0 0;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}
.quiet h2 {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 650;
  line-height: 18px;
  color: var(--text-faint);
}
.qgrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 2px 14px;
}
.qrow {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin-left: -6px;
  padding: 5px 6px;
  border: 0;
  border-radius: 8px;
  background: none;
  color: inherit;
  text-align: left;
  font-size: 13px;
  line-height: 18px;
  transition: background var(--hov) var(--ease), color var(--hov) var(--ease);
}
.qrow b {
  min-width: 0;
  font-weight: 600;
  color: var(--text-dim);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.qrow em {
  flex: none;
  font-style: normal;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
button.qrow.go:hover {
  background: var(--bg-elev);
}
button.qrow.go:hover b {
  color: var(--text);
}

/* Skeletons are the same boxes the answers land in, so arrival moves nothing. */
.dcol.sk i {
  display: block;
  height: 12px;
  margin-top: 6px;
  border-radius: 3px;
  background: var(--shimmer);
  background-size: var(--sk-tile) 100%;
}
.dcol.sk i:nth-child(1) {
  width: 34px;
  height: 16px;
}
.dcol.sk i:nth-child(2) {
  width: 44px;
}
.dcol.sk i:nth-child(3) {
  width: 38px;
}
.card.sk {
  /* The card's own box: 138 px of poster plus its padding and hairline, so the answers land without
     moving the page. */
  min-height: 160px;
  border-radius: var(--r-tile);
  background: var(--shimmer);
  background-size: var(--sk-tile) 100%;
}
@media (prefers-reduced-motion: no-preference) {
  .dcol.sk i,
  .card.sk {
    animation: sh 1.3s linear infinite;
  }
}
@media (max-width: 900px) {
  .grp {
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }
  .dcol {
    flex-direction: row;
    align-items: baseline;
    gap: 8px;
  }
}
</style>
