import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import {
  emptyPlayerMedia,
  emptyPlayerState,
  type DanmakuAnime,
  type DanmakuComment,
  type DanmakuEpisode,
  type DanmakuLink,
  type DanmakuQuery,
  type DanmakuSettings,
  type DanmakuTrackInfo,
  type PlayerCommand,
  type PlayerMedia,
  type PlayerSession,
  type PlayerState,
} from '../../shared/types';
import { useAppStore } from './app';

/** The eight right drawers. Only one can be open at a time, the way Emby's own menu behaves. */
export type PanelKind = 'subtitle' | 'audio' | 'video' | 'quality' | 'speed' | 'chapters' | 'episodes' | 'danmaku';

/** mpv's `speed` takes any number; these are the steps a button can land on. */
export const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];

export const usePlayerStore = defineStore('player', () => {
  const state = ref<PlayerState>(emptyPlayerState());
  const session = ref<PlayerSession | null>(null);
  const media = ref<PlayerMedia>(emptyPlayerMedia());
  const panel = ref<PanelKind | ''>('');
  const busy = ref(false);
  /** A refused command (「这已经是最后一集」) says so in the bar rather than in silence. */
  const error = ref('');
  let offAll: (() => void) | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;

  /** 显示弹幕 in the player's drawer. Session-local on purpose: whether 弹幕 exists at all is answered by
   *  设置's endpoint switches, so this is only the mute you throw while watching — a second, remembered 「off」
   *  would be an invisible reason for an empty canvas. */
  const danmakuOn = ref(true);
  const dmCandidates = ref<DanmakuTrackInfo[]>([]);
  /** The link the viewer made for this show, if any; it is what turns 「猜的」 into 「我们知道的」. */
  const dmLink = ref<DanmakuLink | null>(null);
  /** True when the row playing was resolved from the library's TMDB id rather than guessed from a title. */
  const dmAuto = ref(false);
  /** The endpoint that answered this item's lookup, by the name 设置 gave it — empty when nobody answered. */
  const dmSource = ref('');
  /** Why the last lookup came back empty when the endpoint refused rather than said 「none」. Printed in the
   *  drawer in place of 「没匹配到」, which would be a lie about a key that ran out of calls. */
  const dmRefusal = ref('');
  const dmTrackId = ref('');
  const dmComments = ref<DanmakuComment[]>([]);
  const dmLoading = ref(false);
  const dmAsked = ref(false);

  /** 手动搜索's answer, kept for the whole session. A search is the viewer's own work — forty-two rows they
   *  were comparing mirror by mirror — and it used to be thrown away the moment they linked one, so coming
   *  back to compare again meant typing the word and paying the round trip again. It survives the drawer
   *  closing, a link, and a change of episode; only leaving the player drops it. */
  const dmWord = ref('');
  const dmResults = ref<DanmakuAnime[]>([]);
  const dmSearched = ref(false);
  /** A sentence about the last search or pick — 「至少输入两个字」, 「这部剧里没有第 5 集」. */
  const dmNote = ref('');
  const dmSearchBusy = ref(false);
  const dmPicking = ref(false);
  /** Each hit's count *for the episode being played*, beside the rows rather than inside them: the number is a
   *  property of that episode, and a row that answers late fills in where it stands. */
  const dmCounts = ref<Record<string, number | null>>({});
  /** Which episode `dmCounts` describes. A different episode makes every number in there a lie, so they go. */
  let dmCountsFor = -1;
  let dmCountSeq = 0;

  const prefs = computed<DanmakuSettings>(() => useAppStore().config?.settings.danmaku || ({} as DanmakuSettings));
  const progress = computed(() => (state.value.durationMs ? Math.min(1, state.value.positionMs / state.value.durationMs) : 0));

  function say(message: string): void {
    error.value = message;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (error.value = ''), 2600);
  }

  function attach(): void {
    if (offAll) return;
    const api = window.echoemby;
    const off = [
      api.player.onState(s => (state.value = s)),
      api.player.onSession(s => {
        session.value = s;
        if (!s) {
          void closeDanmaku();
          dropDmSearch();
        }
      }),
      api.player.onMedia(m => (media.value = m)),
    ];
    offAll = () => off.forEach(f => f());
    void refresh();
  }

  function detach(): void {
    offAll?.();
    offAll = null;
  }

  /** The overlay is a window of its own, so it can be created after the main process has already put
   *  something on screen; all three channels are pulled once on mount. */
  async function refresh(): Promise<void> {
    const api = window.echoemby;
    state.value = await api.player.state();
    const s = await api.player.session();
    if (s.ok) session.value = s.data || null;
    const m = await api.player.media();
    if (m.ok && m.data) media.value = m.data;
  }

  async function play(itemId: string, fromStart = false): Promise<boolean> {
    busy.value = true;
    const r = await window.echoemby.player.play(itemId, fromStart);
    busy.value = false;
    if (!r.ok) say(r.error || '无法开始播放');
    return !!r.ok;
  }

  async function cmd(command: PlayerCommand): Promise<boolean> {
    const r = await window.echoemby.player.command(command);
    if (!r.ok) say(r.error || '操作没有生效');
    return !!r.ok;
  }

  /** How the card was last asked to open. A click leaves the pointer on the trigger; a letter shortcut has
   *  no target, so the card takes focus itself and the arrow keys can walk it. */
  const focusFromKey = ref(false);

  function openPanel(kind: PanelKind, viaKey = false): void {
    if (panel.value === kind) {
      closePanel();
      return;
    }
    panel.value = kind;
    sub.value = '';
    focusFromKey.value = viaKey;
    measureAnchor(kind);
  }

  /** Where the card belongs: the middle of its trigger's top edge, in window coordinates. The pointer and
   *  the letter shortcuts both come through here, so the button is looked up by its `data-panel` attribute
   *  rather than handed in - a key press has no event target worth asking. */
  const anchor = ref<{ x: number; top: number } | null>(null);

  function measureAnchor(kind: PanelKind): void {
    const el = document.querySelector<HTMLElement>(`[data-panel="${kind}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    anchor.value = { x: r.left + r.width / 2, top: r.top };
  }

  /** The card outlives the click that opened it: a window resize or a fullscreen flip moves the button
   *  under it, and the anchor is the one piece of geometry that cannot be re-derived from CSS. */
  function remeasure(): void {
    if (panel.value) measureAnchor(panel.value);
  }

  /** Which submenu is unfolded inside the open card. It lives in the store rather than in the panel
   *  component because Escape has to close the submenu first and the card second. */
  const sub = ref('');

  function toggleSub(name: string): void {
    sub.value = sub.value === name ? '' : name;
  }

  function closePanel(): void {
    const kind = panel.value;
    panel.value = '';
    sub.value = '';
    focusFromKey.value = false;
    // The card is about to disappear with the cursor inside it; hand the cursor back to the button that
    // grew it, so a keyboard user is not left on a detached node.
    const el = document.activeElement;
    if (kind && el instanceof HTMLElement && el.closest('.pl-sheet')) {
      document.querySelector<HTMLElement>(`[data-panel="${kind}"]`)?.focus();
    }
  }

  async function close(): Promise<void> {
    await window.echoemby.player.close();
    panel.value = '';
    sub.value = '';
    state.value = emptyPlayerState();
    session.value = null;
    media.value = emptyPlayerMedia();
  }

  // ---- 弹幕 ------------------------------------------------------------------

  function resetDanmaku(): void {
    // A new file is a new question: any track still downloading for the old one belongs to neither.
    dmAsk += 1;
    dmCandidates.value = [];
    dmLink.value = null;
    dmAuto.value = false;
    dmTrackId.value = '';
    dmComments.value = [];
    dmAsked.value = false;
    // The search list itself stays — it is about shows, not about this file — but its numbers were asked for
    // the old episode and would be printed beside the new one as if they were about it.
    dmCounts.value = {};
    dmCountsFor = -1;
    dmCountSeq += 1;
  }

  /** Ask once for whatever is playing, as long as 弹幕 is on. The two triggers are the session and the
   *  setting, and either can arrive first: the overlay's own window can mount before the config read
   *  returns, and the switch can be thrown while a file is already on screen. A new file is also a new
   *  question for the service, so the previous answer is dropped with it. */
  function seedDanmaku(): void {
    const q = session.value?.danmaku;
    if (!q) return;
    if (q.itemId !== seededFor) {
      seededFor = q.itemId;
      resetDanmaku();
    }
    if (danmakuOn.value) void loadDanmaku();
    // The numbers in the search page belong to the episode, so a new one re-asks them for the rows already on
    // screen instead of showing the previous episode's totals.
    if (dmResults.value.length) void fillDmCounts();
  }

  let seededFor = '';

  watch(() => session.value?.danmaku?.itemId || '', () => seedDanmaku());

  /** The layer's teardown drops the list *and* the answer it came from. Both the lookup and the track are
   *  read from the disk cache first, so re-enabling costs no network round trip — while a stale 「已问过」
   *  flag did cost the whole list: 关掉再打开 came back to a blank canvas with the row still marked. */
  async function closeDanmaku(): Promise<void> {
    dmComments.value = [];
    dmTrackId.value = '';
    dmCandidates.value = [];
    dmLink.value = null;
    dmAsked.value = false;
  }

  /** `session` is a deep ref, so its `danmaku` field is a reactive proxy, and the IPC bridge structured-clones
   *  its argument and refuses a proxy with 「An object could not be cloned」. The query is all scalars, so a
   *  spread is the whole conversion. */
  function danmakuQuery(): DanmakuQuery | null {
    const q = session.value?.danmaku;
    return q ? { ...q } : null;
  }

  /** Which episode number the panel links against: the library's own numbering, so a link lands on the
   *  row at the same position inside the work the user picked. */
  const dmEpisode = computed(() => session.value?.danmaku?.episode);

  async function loadDanmaku(force = false): Promise<void> {
    const q = danmakuQuery();
    if (!q) return;
    // `force` is the 重新匹配 button: an answer of 「none」 is remembered so that opening the drawer again
    // does not re-ask a metered service, and only the viewer asking out loud may spend that request.
    if (dmAsked.value && !force) return;
    if (force) dmAsked.value = false;
    dmAsked.value = true;
    dmLoading.value = true;
    dmRefusal.value = '';
    // Cleared with it: a source name left over from the previous item would caption a drawer that has
    // nothing from that source (or from any).
    dmSource.value = '';
    const r = await window.echoemby.danmaku.lookup(q);
    dmLoading.value = false;
    if (!r.ok) {
      dmAsked.value = false;
      say(r.error || '弹幕服务没有回应');
      return;
    }
    // A service that did not answer is not a service that answered 「none」: the question stays open so the
    // next drawer opening asks it again.
    if (!r.data) {
      dmAsked.value = false;
      say('弹幕服务没有回应，稍后再试');
      return;
    }
    const found = r.data;
    dmCandidates.value = found.list || [];
    // The number arrives with the answer for as many rows as one eager pass could afford, and every row has
    // one — a show with 6.9 万条 comments beside one with 84 is the whole point of the column. The rest are
    // asked here, three at a time, and written in as they land instead of holding the list back.
    void fillDmCandidateCounts();
    dmLink.value = found.link;
    dmAuto.value = found.auto;
    dmSource.value = found.source || '';
    // A refusal is not an empty answer. The key running out of calls is worth naming — and worth asking
    // again later — while 「this show has no comments」 is a fact the viewer can stop waiting on.
    if (found.reason && !dmCandidates.value.length) {
      dmAsked.value = false;
      const hours = found.reason === 'quota' && found.retryAfterMs ? Math.max(1, Math.round(found.retryAfterMs / 3_600_000)) : 0;
      dmRefusal.value = found.reason === 'quota'
        ? (hours ? `弹幕配额已用完，约 ${hours} 小时后恢复` : '弹幕配额已用完')
        : '弹幕服务暂时不可用，稍后再试';
      say(dmRefusal.value);
      return;
    }
    // The service's own pick is the first row, and a manual link's row comes first by construction. An
    // already-playing track is kept when it is still on the list, so reopening the drawer does not restart
    // the comments the viewer is watching.
    const pick = dmCandidates.value.some(t => t.id === dmTrackId.value) ? dmTrackId.value : found.pick;
    // A candidate can answer with an empty list — the comments were timed against another cut, or the row is
    // a same-named work the filter let through. The next row is cheaper to try than sending the viewer back
    // to the panel, and three tries is enough to cover the usual film / OVA / TV collision.
    const order = [pick, ...dmCandidates.value.map(t => t.id)].filter((id, i, all) => id && all.indexOf(id) === i);
    let failed = 0;
    for (const id of order.slice(0, 3)) {
      const got = await selectDanmaku(id, dmCandidates.value.find(t => t.id === id)?.shift || 0, true);
      // A newer ask owns the list by now, so this walk has nothing left to say about it.
      if (got === 'stale') return;
      if (got === 'ok') return;
      if (got === 'failed') failed++;
    }
    // Every row failing to download is a service that did not answer, not a show without comments; and the
    // remembered 「问过了」 would keep the drawer quiet for the rest of the file, so the question stays open.
    if (order.length && failed === Math.min(3, order.length)) {
      dmAsked.value = false;
      say('弹幕服务没有回应，稍后再试');
      return;
    }
    say(dmCandidates.value.length ? '这些轨道都没有弹幕' : '这条没有弹幕');
  }

  /** Every ask carries a number and only the newest may write the list. Two rows clicked one after the
   *  other used to leave whichever answered last on screen — measured 2026-10-30: 点第 4 行（冷启动，7996 条）
   *  then 第 1 行（2314 条）, and the tick sat on 第 1 行 while the picture played 第 4 行's comments. The file
   *  is part of the identity as well, or a slow track from the previous episode lands on the new one. */
  let dmAsk = 0;

  /** What one ask came back with, so a caller can tell 「没有」 from 「没答到」: a download that failed used to
   *  arrive as an empty list and read as 「这一集没人发弹幕」, which hides a service that is down. */
  type DmPick = 'ok' | 'empty' | 'failed' | 'stale';

  /** `quiet` is for the style of walk that tries several rows in one go: only the last one's emptiness is
   *  worth a sentence, the rest are just steps that did not pan out. */
  async function selectDanmaku(trackId: string, shift = 0, quiet = false): Promise<DmPick> {
    const q = danmakuQuery();
    if (!q) return 'stale';
    const seq = ++dmAsk;
    dmTrackId.value = trackId;
    dmComments.value = [];
    dmLoading.value = true;
    const r = await window.echoemby.danmaku.track(q, trackId, shift);
    // Superseded while it was in flight: this answer is about a row nobody is looking at any more, and the
    // ask that owns the list now is the one that clears 载入中….
    if (seq !== dmAsk || danmakuQuery()?.itemId !== q.itemId) return 'stale';
    dmLoading.value = false;
    if (!r.ok) {
      // Nothing arrived, so nothing is selected: leaving the tick on a row whose download failed made the
      // drawer look like it was playing that track while the layer stayed blank, and the row could not be
      // clicked again to retry its own selection.
      dmTrackId.value = '';
      if (!quiet) say(r.error || '弹幕读取失败');
      return 'failed';
    }
    dmComments.value = r.data?.comments || [];
    // An empty list is an answer the user can act on, so it is said out loud instead of leaving a blank
    // layer under a track row that looks selected.
    if (!dmComments.value.length) {
      if (!quiet) say('这一条没有弹幕');
      return 'empty';
    }
    return 'ok';
  }

  /** 手动链接: the answer becomes the show's link on the main side, so every later episode of it resolves
   *  through the same work instead of guessing again. */
  async function linkDanmaku(link: DanmakuLink | null): Promise<void> {
    const q = danmakuQuery();
    if (!q) return;
    // A track still downloading belongs to the work that was linked away from: numbering the ask again keeps
    // its answer out of the list this link is about to rebuild.
    dmAsk += 1;
    dmLoading.value = true;
    const r = await window.echoemby.danmaku.link(q, link);
    dmLoading.value = false;
    if (!r.ok) {
      say(r.error || '链接失败');
      return;
    }
    dmLink.value = r.data ?? null;
    dmAsked.value = false;
    dmTrackId.value = '';
    await loadDanmaku();
  }

  /** `null` is 「没有答到」 and an empty array is 「答了，没有」 — the panel must not call a failed request a miss. */
  async function searchDanmaku(word: string): Promise<DanmakuAnime[] | null> {
    const r = await window.echoemby.danmaku.search(word);
    return r.ok && r.data ? r.data : null;
  }

  async function danmakuEpisodes(title: string, animeId: string): Promise<DanmakuEpisode[] | null> {
    const r = await window.echoemby.danmaku.episodes(title, animeId);
    return r.ok && r.data ? r.data : null;
  }

  /** The one row for a given number, for shows whose episode list comes back cut short. */
  async function danmakuEpisodeAt(title: string, animeId: string, episode: number): Promise<DanmakuEpisode | null> {
    const r = await window.echoemby.danmaku.episodeAt(title, animeId, episode);
    return r.ok && r.data ? r.data : null;
  }

  /** 手动搜索's numbers column: one ask per work, answered as `count: null` when the mirror stayed silent. */
  async function danmakuCountFor(title: string, animeId: string, episode: number): Promise<{ episodeId: string; count: number | null } | null> {
    const r = await window.echoemby.danmaku.countFor(title, animeId, episode);
    return r.ok && r.data ? r.data : null;
  }

  /** The mute in the drawer: what is already on screen is torn down at once, and turning it back on re-asks
   *  only when this item has not been asked yet. Nothing is written to the config — the endpoints decide
   *  whether 弹幕 exists, this decides whether it is drawn for this sitting. */
  async function setDanmakuEnabled(on: boolean): Promise<void> {
    danmakuOn.value = on;
    if (!on) await closeDanmaku();
    else if (!dmAsked.value) await loadDanmaku();
  }

  /** Style knobs are live: the canvas reads them from this store on every frame, and the write to disk
   *  is fire-and-forget because a slider dragged at 60 Hz must not wait on the file. */
  async function patchDanmaku(patch: Partial<DanmakuSettings>): Promise<void> {
    await useAppStore().saveSettings({ danmaku: patch });
  }

  /** Numbers for the candidate rows the eager pass in main ran out of time for — written straight into the
   *  rows so the list is readable while the slow ones are still coming. */
  async function fillDmCandidateCounts(): Promise<void> {
    const queue = dmCandidates.value.filter(t => t.count == null);
    if (!queue.length) return;
    const one = async (): Promise<void> => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        const r = await window.echoemby.danmaku.countOne(t.id, t.api);
        if (r.ok && typeof r.data === 'number') t.count = r.data;
      }
    };
    await Promise.all([one(), one(), one()]);
  }

  /** Nothing of 手动搜索 survives leaving the player: the word, the rows, the numbers. Changing episode keeps
   *  the rows and drops only the numbers (see resetDanmaku). */
  function dropDmSearch(): void {
    dmWord.value = '';
    dmResults.value = [];
    dmSearched.value = false;
    dmNote.value = '';
    dmCounts.value = {};
    dmCountsFor = -1;
    dmCountSeq += 1;
  }

  /** The number beside every row of the search page: what this episode holds in that work. Three at a time,
   *  written as they land; a row that stays `null` is one the mirror did not answer for. */
  async function fillDmCounts(): Promise<void> {
    const ep = dmEpisode.value || 0;
    if (dmCountsFor !== ep) {
      dmCounts.value = {};
      dmCountsFor = ep;
    }
    const seq = (dmCountSeq += 1);
    const queue = dmResults.value.filter(a => dmCounts.value[a.id] == null).map(a => ({ id: a.id, title: a.title }));
    if (!queue.length) return;
    const one = async (): Promise<void> => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        const got = await danmakuCountFor(row.title, row.id, ep);
        // A new search or a new episode owns the column by now.
        if (seq !== dmCountSeq) return;
        const n = got ? got.count : null;
        dmCounts.value = { ...dmCounts.value, [row.id]: n };
      }
    };
    await Promise.all([one(), one(), one()]);
  }

  /** 手动搜索's 搜索 button. The rows stay after a pick, so the viewer can go back and compare another mirror
   *  without typing again — only leaving the player drops them. */
  async function runDmSearch(): Promise<void> {
    const word = dmWord.value.trim();
    if (word.length < 2) {
      dmNote.value = '至少输入两个字';
      return;
    }
    dmSearchBusy.value = true;
    dmNote.value = '';
    const found = await searchDanmaku(word);
    dmSearchBusy.value = false;
    dmSearched.value = true;
    dmResults.value = found || [];
    dmCounts.value = {};
    dmCountsFor = -1;
    dmCountSeq += 1;
    if (!found) dmNote.value = '搜索没有成功：接口没有回应，再试一次';
    else if (!found.length) dmNote.value = '没有搜到这部剧，换个名字试试';
    else void fillDmCounts();
  }

  /** Linking a work: the pick is written on the main side, this file is re-matched through it, and the drawer
   *  goes back to the list it came from. The search rows are left alone on purpose — comparing mirrors is the
   *  reason the page exists, and a pick that cleared them sent the viewer back to the search box when the
   *  wrong mirror turned out to be the wrong one. */
  async function pickDmAnime(a: DanmakuAnime): Promise<void> {
    const q = danmakuQuery();
    if (!q || dmPicking.value) return;
    dmPicking.value = true;
    dmNote.value = '';
    // The rows are disabled while this runs, so a throw anywhere below would leave every result unclickable
    // for the rest of the session with nothing on screen saying why. The flag is released on the way out.
    try {
      const ep = dmEpisode.value || 0;
      const eps = await danmakuEpisodes(a.title, a.id);
      if (eps === null) {
        dmNote.value = '接口没有回应，没能取到这部剧的分集，稍后再试';
        return;
      }
      if (!eps.length) {
        dmNote.value = '接口没有返回这部剧的分集（它可能只认另一个名字），换一部或换个名字再试';
        return;
      }
      // A long runner's list comes back cut short (死神 lists 128 of its 366), so 第 131 集 cannot be indexed
      // out of it. Ask the service for that number directly; the auto match resolves the same way.
      const hit =
        (ep ? eps.find(e => e.title.includes(String(ep))) || eps[ep - 1] : eps[0]) ||
        (ep ? await danmakuEpisodeAt(a.title, a.id, ep) : null);
      if (!hit) {
        dmNote.value = ep ? `这部剧里没有第 ${ep} 集` : '这部剧没有可用的分集';
        return;
      }
      await linkDanmaku({ animeId: a.id, animeTitle: a.title, type: a.type, episodeId: hit.id, episodeTitle: hit.title });
      // Back to the list the link was made to fix: the row that says what is playing now reads 手动链接.
      toggleSub('tracks');
    } catch {
      dmNote.value = '链接没有完成，再试一次';
    } finally {
      dmPicking.value = false;
    }
  }

  /** 解除: the file goes back to automatic matching. The search rows and their numbers stay, so the viewer can
   *  pick another mirror without paying for the search again. */
  async function unlinkDm(): Promise<void> {
    dmNote.value = '';
    await linkDanmaku(null);
  }

  return {
    state,
    session,
    media,
    prefs,
    panel,
    focusFromKey,
    sub,
    anchor,
    busy,
    error,
    progress,
    danmakuOn,
    dmCandidates,
    dmTrackId,
    dmEpisode,
    dmComments,
    dmLoading,
    say,
    attach,
    detach,
    refresh,
    play,
    cmd,
    openPanel,
    remeasure,
    toggleSub,
    closePanel,
    close,
    seedDanmaku,
    dmLink,
    dmAuto,
    dmSource,
    dmRefusal,
    loadDanmaku,
    selectDanmaku,
    linkDanmaku,
    searchDanmaku,
    danmakuEpisodes,
    danmakuEpisodeAt,
    danmakuCountFor,
    dmWord,
    dmResults,
    dmSearched,
    dmNote,
    dmSearchBusy,
    dmPicking,
    dmCounts,
    runDmSearch,
    pickDmAnime,
    unlinkDm,
    dropDmSearch,
    setDanmakuEnabled,
    patchDanmaku,
  };
});