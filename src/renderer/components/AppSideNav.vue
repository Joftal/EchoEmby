<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAppStore } from '../stores/app';
import EmbyMark from './EmbyMark.vue';
import logoUrl from '../assets/echoemby.png';

defineProps<{ collapsed: boolean }>();
const emit = defineEmits<{ (e: 'toggle'): void }>();

const store = useAppStore();
const route = useRoute();
const router = useRouter();

interface NavItem {
  key: string;
  label: string;
  to: string;
  paths: string[];
}

const ICONS = {
  home: ['M4 11 12 4.4 20 11', 'M6.6 9.4V19a1.6 1.6 0 0 0 1.6 1.6h7.6A1.6 1.6 0 0 0 17.4 19V9.4'],
  play: ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z', 'M10.4 9.1 15.2 12l-4.8 2.9z'],
  list: ['M8.5 6.5H20', 'M8.5 12H20', 'M8.5 17.5H20', 'M4.4 6.5h.02', 'M4.4 12h.02', 'M4.4 17.5h.02'],
  heart: ['M12 19.6S5.2 15.2 5.2 10.7A3.9 3.9 0 0 1 12 8.3a3.9 3.9 0 0 1 6.8 2.4c0 4.5-6.8 8.9-6.8 8.9Z'],
  layers: ['M4 8.4 12 4.2l8 4.2-8 4.2z', 'M4 8.4v7.2L12 19.8l8-4.2v-7.2'],
  search: ['M11 4.6a6.4 6.4 0 1 0 0 12.8 6.4 6.4 0 0 0 0-12.8Z', 'M19.4 19.4 15.6 15.6'],
  // Two rails with knobs, not a gear: a toothed rim needs ~7px of ink to read as a gear, and at the
  // 19px icon column it came back as a sun (the teeth detached from the circle at that stroke weight).
  tune: ['M4.4 8h2.1', 'M11.1 8h8.5', 'M8.8 5.7a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6Z', 'M4.4 16h8.5', 'M17.5 16h2.1', 'M15.2 13.7a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6Z'],
  chevL: ['M14.5 6.5 9 12l5.5 5.5'],
  chevR: ['M9.5 6.5 15 12l-5.5 5.5'],
};

const discover: NavItem[] = [{ key: 'home', label: '首页', to: '/', paths: ICONS.home }];
const mine: NavItem[] = [
  { key: 'kresume', label: '在看', to: '/browse?kind=resume', paths: ICONS.play },
  { key: 'kunwatched', label: '待看', to: '/browse?kind=unwatched', paths: ICONS.list },
  { key: 'kfavorites', label: '收藏', to: '/browse?kind=favorites', paths: ICONS.heart },
];

const activeKey = computed(() => {
  if (route.name === 'home') return 'home';
  if (route.name === 'settings') return 'set';
  if (route.name === 'browse') return route.query.view ? `v${route.query.view}` : `k${route.query.kind || ''}`;
  return '';
});

const searchOn = computed(() => activeKey.value === 'ksearch');
const serversOn = computed(() => route.name === 'servers');
const shown = computed(() => {
  const a = store.account;
  return a?.label || a?.serverName || a?.username || '?';
});
// The rail is far narrower than the card, so the totals drop the 「部」 counter word — and at 13px the
// spaces around the separator go too: 「电影 7313 · 电视剧 2487」 measures 138px against a 137.4px
// column, which the ellipsis turned into 「24…」.
const libs = computed(() => {
  const c = store.account ? store.counts[store.account.accountId] : undefined;
  if (!c) return '';
  const parts: string[] = [];
  if (c.movies > 0) parts.push(`电影 ${c.movies}`);
  if (c.series > 0) parts.push(`电视剧 ${c.series}`);
  return parts.join('·');
});
const railEl = ref<HTMLElement | null>(null);
const listEl = ref<HTMLElement | null>(null);

/** The library group is server-sized, so the list can and does end mid-row (measured: 42px of
    overflow at the default window, 67px at a shorter one, with 「播放列表」 sliced in half). The
    scrollbar is hidden on purpose, which makes that edge read as a broken panel instead of a
    scrollable one, so it fades — but only while there is something below it to fade to. */
const more = ref(false);
function checkMore(): void {
  const l = listEl.value;
  if (l) more.value = l.scrollHeight - l.clientHeight > 6;
}

/** The highlight is a child of whichever row is active, so the layout welds it to that row: when the
    rail morphs, the rows above it grow and shrink and it travels with them instead of lagging behind
    a measured offset (which measured 31px adrift mid-sweep). Moving between rows is a FLIP —
    remember where it was, let the patch drop it into the new row, then play the difference back. */
watch(activeKey, () => {
  const from = railEl.value?.querySelector<HTMLElement>('.glider')?.getBoundingClientRect();
  if (!from) return;
  void nextTick(() => {
    const g = railEl.value?.querySelector<HTMLElement>('.glider');
    if (!g) return;
    const dy = from.top - g.getBoundingClientRect().top;
    if (!dy) return;
    g.style.transition = 'none';
    g.style.transform = `translate3d(0, ${dy}px, 0)`;
    void g.offsetHeight;
    g.style.transition = '';
    g.style.transform = '';
  });
});

function go(to: string): void {
  if (router.currentRoute.value.fullPath !== to) void router.push(to);
}

// The rail sits on every page with an account, so it is what keeps that account's totals filled in.
watch(() => store.account?.accountId, id => { if (id) void store.loadCounts(id); }, { immediate: true });

onMounted(() => {
  if (store.ready && !store.account) {
    router.replace('/login');
    return;
  }
  void store.loadViews();
  checkMore();
  window.addEventListener('resize', checkMore);
});
onBeforeUnmount(() => window.removeEventListener('resize', checkMore));
/* The views arrive after the panel has painted, and they are what makes the list overflow. */
watch(() => store.views.length, () => void nextTick(checkMore));
</script>

<template>
  <aside ref="railEl" class="rail" :class="{ min: collapsed }">
    <header class="head">
      <button class="logo" @click="emit('toggle')">
        <img class="wm" :src="logoUrl" alt="" width="22" height="22" />
        <span class="word">EchoEmby</span>
        <svg class="chev" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path :d="collapsed ? ICONS.chevR[0] : ICONS.chevL[0]" />
        </svg>
      </button>
      <button class="sbtn" :class="{ on: searchOn }" @click="go('/browse?kind=search')">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <path v-for="p in ICONS.search" :key="p" :d="p" />
        </svg>
      </button>
    </header>

    <nav ref="listEl" class="list" :class="{ more }">
      <section class="grp">
        <p class="cap">发现</p>
        <button
          v-for="it in discover"
          :key="it.key"
          class="item"
          :class="{ on: activeKey === it.key }"
          @click="go(it.to)"
        >
          <span v-if="activeKey === it.key" class="glider"></span>
          <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path v-for="p in it.paths" :key="p" :d="p" />
          </svg>
          <span class="lb">{{ it.label }}</span>
        </button>
      </section>

      <section class="grp">
        <p class="cap">我的</p>
        <button
          v-for="it in mine"
          :key="it.key"
          class="item"
          :class="{ on: activeKey === it.key }"
          @click="go(it.to)"
        >
          <span v-if="activeKey === it.key" class="glider"></span>
          <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path v-for="p in it.paths" :key="p" :d="p" />
          </svg>
          <span class="lb">{{ it.label }}</span>
        </button>
      </section>

      <section v-if="store.views.length" class="grp libs">
        <div class="gsh">
          <p class="cap">资源库</p>
          <button
            v-for="v in store.views"
            :key="v.id"
            class="item"
            :class="{ on: activeKey === `v${v.id}` }"
            @click="go(`/browse?view=${v.id}&name=${encodeURIComponent(v.name)}`)"
          >
            <span v-if="activeKey === `v${v.id}`" class="glider"></span>
            <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path v-for="p in ICONS.layers" :key="p" :d="p" />
            </svg>
            <span class="lb">{{ v.name }}</span>
          </button>
        </div>
      </section>
    </nav>

    <footer class="foot">
      <button class="item" :class="{ on: activeKey === 'set' }" @click="go('/settings')">
        <span v-if="activeKey === 'set'" class="glider"></span>
        <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path v-for="p in ICONS.tune" :key="p" :d="p" />
        </svg>
        <span class="lb">设置</span>
      </button>
      <button class="acct" :class="{ on: serversOn }" @click="go('/servers')">
        <span class="av"><EmbyMark :size="15" /></span>
        <span class="who">
          <b>{{ shown }}</b>
          <i>{{ libs }}</i>
        </span>
      </button>
    </footer>
  </aside>
</template>

<style scoped>
.rail {
  position: absolute;
  left: 12px;
  /* Same 16px on both sides. It used to sit below the 44px title bar (+8), which put the wordmark
     64px from the window's top edge against the account row's 32px from its bottom. The bar now
     stops at --nav-w (AppTitleBar.vue), so the header stays clickable inside that band. */
  top: 16px;
  bottom: 16px;
  z-index: var(--z-rail);
  display: flex;
  flex-direction: column;
  width: 202px;
  padding: 8px 8px 10px;
  /* The frost is now strong enough that the panel is light everywhere it floats, so brighter-than-the-
     surface is no longer an available affordance: a white pill over a near-white panel measured +7 at
     the bottom of the rail and +39 at the top, i.e. the selected row was visible only over the dark
     half of the art it sits on. The tints go dark, reusing the page's own chip tokens. */
  --tint: var(--chip);
  --tint-hi: var(--chip-hi);
  border-radius: var(--r-panel);
  background: var(--glass);
  border: 1px solid rgba(255, 255, 255, 0.45);
  box-shadow: 0 14px 40px rgba(18, 18, 34, 0.08);
  /* 26px, not the 40 this had: a poster tucked under the panel still smeared into the surrounding white
     at that radius (delta 26 luminance points), which is what read as a mask rather than glass. */
  backdrop-filter: blur(26px) saturate(180%);
  /* Every rule in this file that tweens rail geometry shares --rail-dur/--rail-ease with the page
     gutter, so the panel, its rows and the content beside it move on one schedule. */
  transition: width var(--rail-dur) var(--rail-ease), padding-inline var(--rail-dur) var(--rail-ease);
}
.rail.min {
  width: 60px;
  padding-inline: 6px;
}

/* The search button lives out of flow so it can glide from the right edge to under the mark as
   the rail narrows; a flex-direction flip here snapped the whole list 36px in one frame. */
.head {
  position: relative;
  display: flex;
  /* flex-start, not centre: the content box is exactly the logo's 30px when expanded, so centring
     would make the mark slide down 21px as the header grows to hold the button's second row. */
  align-items: flex-start;
  padding: 0 2px;
  flex: none;
  height: 30px;
  transition: height var(--rail-dur) var(--rail-ease);
}
/* Two 38px rows, so the collapsed mark and search button sit on the same pitch as the nav icons
   below them (which are 38px tall) instead of bunching up at the top. */
.rail.min .head {
  height: 72px;
}
.logo {
  position: relative;
  display: flex;
  align-items: center;
  /* Inset to put the mark on the icon column and the word on the label column: the row below starts
     at 11px with a 19px icon, so a 22px mark needs 8px of padding and 9px of gap to land on it. */
  gap: 9px;
  width: calc(100% - 34px);
  min-width: 0;
  height: 30px;
  padding: 0 4px 0 8px;
  border-radius: var(--radius);
  transition: background var(--hov) var(--ease), width var(--rail-dur) var(--rail-ease),
    column-gap var(--rail-dur) var(--rail-ease), padding-left var(--rail-dur) var(--rail-ease);
}
.rail.min .logo {
  width: 100%;
  gap: 0;
  /* The mark sits on the panel's centre line by construction, like .rail.min .item's icons: with
     justify-content it only reached the centre once the word's max-width cap bound, in the last
     seventh of the sweep, so it drifted left and then snapped 9px back to the right. */
  padding-left: 10.2px;
}
.logo:hover {
  background: var(--tint);
}
/* .wm, not .mark: a scoped rule reaches a child component's root element too, and EmbyMark's root
   carries class="mark" — so this rule was sizing the account avatar's brand mark to 22px inside a
   28px disc and silently overriding the :size="15" the template asks for. */
.wm {
  width: 22px;
  height: 22px;
  flex: none;
}
.word {
  flex: 1;
  min-width: 0;
  max-width: 150px;
  text-align: left;
  font-size: 14px;
  font-weight: 650;
  letter-spacing: 0.2px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  opacity: 1;
  transition: max-width var(--rail-dur) var(--rail-ease), opacity var(--fade-t) var(--ease) var(--fade-d);
}
.rail.min .word {
  max-width: 0;
  opacity: 0;
}
/* Out of flow on purpose: as a flex child the chev held 15px of the tile even while invisible,
   which pushed the mark off the rail's centre whenever collapsed. */
.chev {
  position: absolute;
  right: 6px;
  top: 7px;
  color: var(--text-dim);
  opacity: 0;
  transform: translate3d(-3px, 0, 0);
  transition: opacity var(--hov) var(--ease), transform var(--hov) var(--ease-out);
  pointer-events: none;
}
.logo:hover .chev {
  opacity: 1;
  transform: none;
}
.sbtn {
  position: absolute;
  top: 0;
  left: 100%;
  margin-left: -30px;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: var(--radius);
  color: var(--text-dim);
  transition: background var(--hov) var(--ease), color var(--hov) var(--ease), transform var(--hov) var(--ease-out),
    top var(--rail-dur) var(--rail-ease), left var(--rail-dur) var(--rail-ease), margin-left var(--rail-dur) var(--rail-ease);
}
.rail.min .sbtn {
  /* One 38px row under the mark, matching the nav icons' pitch. */
  top: 38px;
  left: 50%;
  margin-left: -15px;
}
.sbtn:hover {
  background: var(--tint);
  color: var(--text);
  transform: translate3d(0, -1px, 0);
}
.sbtn.on {
  color: var(--text);
  background: var(--tint-hi);
}

.list {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none;
}
.list::-webkit-scrollbar {
  width: 0;
}
/* The fade is a mask, not a coloured strip: the panel is translucent glass over art that changes
   every nine seconds, so any paint laid here would be a band of the wrong brightness for half of
   those cycles. Masking to transparent lets the glass itself show through the last row.
   Gated on :not(.min) because the collapsed list has nothing below the edge (measured 610/610). */
.rail:not(.min) .list.more {
  mask-image: linear-gradient(to bottom, #000 calc(100% - 18px), transparent);
}
/* Lives inside the active row, so its box is that row's box. The negative z-index keeps it under the
   icon and label; a stacking context starts at the element's own background, so the hover tint still
   sits behind it too. */
.glider {
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: var(--r-row);
  background: var(--tint-hi);
  transition: transform 0.34s var(--ease-out);
  pointer-events: none;
}
.grp {
  padding-bottom: 6px;
}
/* The library group holds a variable number of rows, so it collapses through the track rather
   than by measured pixels: 1fr <-> 0fr interpolates, and .gsh clips the overflow. */
.grp.libs {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--rail-dur) var(--rail-ease);
}
.grp.libs .gsh {
  min-height: 0;
  overflow: hidden;
}
.rail.min .grp.libs {
  grid-template-rows: 0fr;
}
.cap {
  /* 18px box for 13px type, and the 8/7 pair that keeps the group rhythm this had at 12/16/9/8:
     footprint 33 either way, so the list's bottom overflow did not grow. The size is the fix —
     at 12px the caption's topmost row of strokes got no antialiasing row at all (measured off the
     user's own 1:1 capture: row 60 = 243 background, row 61 = 61 solid, while the bottom tapers
     70 = 90 -> 71 = faint), which is what reads as 「上面缺了一截」. Perceived gaps: 10.8 under the
     header, 9.8 to the active row's pill, 16.8 across a group break (a row-to-row gap is 0). */
  height: 18px;
  margin: 8px 0 7px;
  padding-left: 11px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 1.3px;
  line-height: 18px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  opacity: 1;
  transition: height var(--rail-dur) var(--rail-ease), margin var(--rail-dur) var(--rail-ease),
    padding-left var(--rail-dur) var(--rail-ease), opacity var(--fade-t) var(--ease) var(--fade-d);
}
.rail.min .cap {
  height: 0;
  margin-block: 0;
  /* Holds the icon column all the way in, so the whole rail has one left edge during the sweep. */
  padding-left: 13.7px;
  opacity: 0;
}
.item {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  /* A button's UA text-align is centre, and .lb stretches to fill the row, so without this every
     label floated to the middle of the leftover space and no two rows started on the same x. It
     also slid leftward over the icon during the squeeze instead of clipping away. */
  text-align: left;
  gap: 11px;
  width: 100%;
  height: 38px;
  padding: 0 11px;
  border-radius: var(--r-row);
  color: var(--text-dim);
  /* Only the left inset tweens (11 -> 13.7px, see .rail.min .item); the right edge of the row is
     already at the panel edge and has nowhere to go. */
  transition: color var(--hov) var(--ease), background var(--hov) var(--ease), transform var(--hov) var(--ease-out),
    column-gap var(--rail-dur) var(--rail-ease), padding-left var(--rail-dur) var(--rail-ease);
}
.item:hover {
  color: var(--text);
  background: var(--tint);
}
.item:active {
  transform: scale(0.97);
  transition-duration: 0.1s;
}
.item.on {
  color: var(--text);
  font-weight: 600;
}
.ic {
  flex: none;
  width: 19px;
  height: 19px;
  transition: transform var(--hov) var(--ease-out);
}
.item:hover .ic {
  transform: scale(1.09);
}
.lb {
  flex: 1;
  min-width: 0;
  max-width: 160px;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 1;
  transition: max-width var(--rail-dur) var(--rail-ease), opacity var(--fade-t) var(--ease) var(--fade-d);
}
.rail.min .item {
  gap: 0;
  /* Not justify-content: the row's content only became narrower than its box once the label's
     max-width cap bound, roughly the last sixth of the sweep, so centring yanked every icon 2.3px to
     the right mid-flight. 13.7px of left inset puts the 19px icon on the 60px panel's centre line
     from the first frame, and the tween is 2.7px. */
  padding-left: 13.7px;
}
.rail.min .lb {
  max-width: 0;
  opacity: 0;
}

.foot {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.5);
}
.acct {
  display: flex;
  align-items: center;
  /* 5.8px, not 10: the disc is 28px against the nav icons' 19px, and with the old gap the account
     name started at x=66 while all sixteen nav labels start at 61.8 — two text columns in one panel
     4.2px apart. The disc's own centre stays on 42 in both rail states (padding-left does that). */
  gap: 5.8px;
  width: 100%;
  /* 7.2px, not 6: the panel's own padding-inline tweens 8 -> 6 while this tweens 7.2 -> 9.2, so the
     two cancel frame by frame and the 28px disc never moves. At DPR 1.25 the old 1.2px of travel
     crossed two device-pixel boundaries mid-sweep, and the mark re-rasterised with a visible step. */
  padding: 5px 6px 6px 7.2px;
  border-radius: var(--r-row);
  text-align: left;
  color: var(--text-dim);
  transition: background var(--hov) var(--ease), transform var(--hov) var(--ease-out),
    column-gap var(--rail-dur) var(--rail-ease), padding-left var(--rail-dur) var(--rail-ease);
}
.acct:hover {
  background: var(--tint);
}
.acct:active {
  transform: scale(0.97);
  transition-duration: 0.1s;
}
.acct.on {
  background: var(--tint-hi);
}
.av {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: 50%;
  color: #fff;
  background: var(--brand);
}
.who {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  max-width: 160px;
  overflow: hidden;
  opacity: 1;
  transition: max-width var(--rail-dur) var(--rail-ease), opacity var(--fade-t) var(--ease) var(--fade-d);
}
.who b {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.who i {
  /* 13px type, and an explicit 18px line box instead of the inherited 1.55 (which would give 20.2
     and push the account row past the rail's bottom). 18 is what the section caption above uses for
     the same reason: at 12px a CJK glyph's topmost stroke row gets no antialiasing row at all. */
  min-height: 18px;
  line-height: 18px;
  font-size: 13px;
  font-weight: 500;
  font-style: normal;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rail.min .acct {
  gap: 0;
  /* Same reasoning as .rail.min .item: the avatar reaches the centre line by measurement, not by
     centring, so it does not get pulled across the last sixth of the sweep. */
  padding-left: 9.2px;
}
.rail.min .who {
  max-width: 0;
  opacity: 0;
}
</style>
