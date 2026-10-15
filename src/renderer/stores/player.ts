import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import {
  emptyPlayerMedia,
  emptyPlayerState,
  type DanmakuComment,
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

  const danmakuOn = ref(false);
  const dmCandidates = ref<DanmakuTrackInfo[]>([]);
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

  async function play(itemId: string): Promise<boolean> {
    busy.value = true;
    const r = await window.echoemby.player.play(itemId);
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
    danmakuOn.value = prefs.value.enabled === true;
    dmCandidates.value = [];
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
    if (prefs.value.enabled && !danmakuOn.value) danmakuOn.value = true;
    if (danmakuOn.value) void loadDanmaku();
  }

  let seededFor = '';

  watch(() => [session.value?.danmaku?.itemId || '', prefs.value.enabled === true], () => seedDanmaku());

  /** Turning the layer off drops the comments but keeps the candidate list, so switching back on inside
   *  the same episode does not ask the service the same question twice. */
  async function closeDanmaku(): Promise<void> {
    dmComments.value = [];
    dmTrackId.value = '';
  }

  /** `session` is a deep ref, so its `danmaku` field is a reactive proxy, and the IPC bridge structured-clones
   *  its argument and refuses a proxy with 「An object could not be cloned」. The query is all scalars, so a
   *  spread is the whole conversion. */
  function danmakuQuery(): DanmakuQuery | null {
    const q = session.value?.danmaku;
    return q ? { ...q } : null;
  }

  async function loadDanmaku(): Promise<void> {
    const q = danmakuQuery();
    if (!q || !prefs.value.enabled) return;
    if (dmAsked.value) return;
    dmAsked.value = true;
    dmLoading.value = true;
    const r = await window.echoemby.danmaku.search(q);
    dmLoading.value = false;
    if (!r.ok) {
      dmAsked.value = false;
      say(r.error || '弹幕源没有回应');
      return;
    }
    // A source that did not answer is not a source that answered 「none」: the question stays open so the
    // next drawer opening asks it again.
    if (r.data === null) {
      dmAsked.value = false;
      say('弹幕源没有回应，稍后再试');
      return;
    }
    dmCandidates.value = r.data || [];
    if (dmCandidates.value.length) await selectDanmaku(dmCandidates.value[0].id);
    else say('这条没有弹幕');
  }

  async function selectDanmaku(trackId: string): Promise<void> {
    const q = danmakuQuery();
    if (!q) return;
    dmTrackId.value = trackId;
    dmComments.value = [];
    dmLoading.value = true;
    const r = await window.echoemby.danmaku.track(q, trackId);
    dmLoading.value = false;
    if (!r.ok) {
      say(r.error || '弹幕读取失败');
      return;
    }
    dmComments.value = r.data?.comments || [];
    // An empty list is an answer the user can act on, so it is said out loud instead of leaving a blank
    // layer under a track row that looks selected.
    if (!dmComments.value.length) say('这一条没有弹幕');
  }

  /** The switch in the drawer is the setting itself: off means the main process asks nothing at all. */
  async function setDanmakuEnabled(on: boolean): Promise<void> {
    danmakuOn.value = on;
    await useAppStore().saveSettings({ danmaku: { enabled: on } });
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
    loadDanmaku,
    selectDanmaku,
    setDanmakuEnabled,
    patchDanmaku,
  };
});
