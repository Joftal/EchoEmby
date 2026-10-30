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
        if (!s) void closeDanmaku();
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
    dmCandidates.value = [];
    dmLink.value = null;
    dmAuto.value = false;
    dmTrackId.value = '';
    dmComments.value = [];
    dmAsked.value = false;
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

  async function loadDanmaku(): Promise<void> {
    const q = danmakuQuery();
    if (!q) return;
    if (dmAsked.value) return;
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
    for (const id of order.slice(0, 3)) {
      await selectDanmaku(id, dmCandidates.value.find(t => t.id === id)?.shift || 0, true);
      if (dmComments.value.length) return;
    }
    say(dmCandidates.value.length ? '这些轨道都没有弹幕' : '这条没有弹幕');
  }

  /** `quiet` is for the style of walk that tries several rows in one go: only the last one's emptiness is
   *  worth a sentence, the rest are just steps that did not pan out. */
  async function selectDanmaku(trackId: string, shift = 0, quiet = false): Promise<void> {
    const q = danmakuQuery();
    if (!q) return;
    dmTrackId.value = trackId;
    dmComments.value = [];
    dmLoading.value = true;
    const r = await window.echoemby.danmaku.track(q, trackId, shift);
    dmLoading.value = false;
    if (!r.ok) {
      if (!quiet) say(r.error || '弹幕读取失败');
      return;
    }
    dmComments.value = r.data?.comments || [];
    // An empty list is an answer the user can act on, so it is said out loud instead of leaving a blank
    // layer under a track row that looks selected.
    if (!dmComments.value.length && !quiet) say('这一条没有弹幕');
  }

  /** 手动链接: the answer becomes the show's link on the main side, so every later episode of it resolves
   *  through the same work instead of guessing again. */
  async function linkDanmaku(link: DanmakuLink | null): Promise<void> {
    const q = danmakuQuery();
    if (!q) return;
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

  async function searchDanmaku(word: string): Promise<DanmakuAnime[]> {
    const r = await window.echoemby.danmaku.search(word);
    return r.ok && r.data ? r.data : [];
  }

  async function danmakuEpisodes(title: string, animeId: string): Promise<DanmakuEpisode[]> {
    const r = await window.echoemby.danmaku.episodes(title, animeId);
    return r.ok && r.data ? r.data : [];
  }

  /** The one row for a given number, for shows whose episode list comes back cut short. */
  async function danmakuEpisodeAt(title: string, animeId: string, episode: number): Promise<DanmakuEpisode | null> {
    const r = await window.echoemby.danmaku.episodeAt(title, animeId, episode);
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
    setDanmakuEnabled,
    patchDanmaku,
  };
});