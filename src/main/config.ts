import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { isAnime4kLevel } from '../shared/anime4k';
import { isAudioLang, isSubLang } from '../shared/lang';
import type { Account, AppConfig, DanmakuSettings, DanmakuSource, MediaCachePrefs, MetaKeys, PlayerPrefs, Settings, SettingsPatch, WindowPrefs } from '../shared/types';

/* No `cuda`: mpv only offers that path to an OpenGL or Vulkan backend, and this player launches with
   `--vo=gpu-next --gpu-api=d3d11` — it answered 「CUDA hwdec only works with OpenGL or Vulkan backends」 and
   fell through to software decode every time. Choosing it therefore never accelerated anything; it only
   replaced a hardware decoder that was working. A config written before this reads back as the default. */
const HWDEC = ['d3d11va', 'auto', 'no'] as const;
const FITS = ['fit', 'fill', 'stretch'] as const;
const PROXY_MODES = ['system', 'manual', 'none'] as const;

/** What a masked secret reads as on screen. A patch carrying it back means "the row was not touched",
 *  so saving one setting never writes the placeholder over the real credential. */
export const SECRET_MASK = '<set>';

/* 自动 for both languages, and not 中文: the app has never chosen a subtitle on its own — mpv's own order
   did that, Chinese first — and a default of 中文 would silently change what plays for every file whose
   default track names another language. A row that starts on 自动 is a promise that nothing moved until the
   viewer pressed something. */
const DEFAULT_PLAYER: PlayerPrefs = {
  /* 自动, not a named driver: the machine this was written on is one NVIDIA card, while `auto` lets mpv ask
     the adapter that will actually present the picture which decoder it supports — the same build then opens
     a 4K HEVC film on an Intel iGPU (D3D11VA, Kaby Lake and later for 10-bit), an AMD card (D3D11VA since
     GCN) or an NVIDIA one, and drops to software only for a codec that adapter cannot decode. A named
     `d3d11va` here would be the same answer on all three today, but it is the app's guess rather than the
     driver's, and it is the wrong guess on a desktop whose display is driven by a second adapter. */
  hwdec: 'auto',
  seekStepMs: 10_000,
  // Off by default: switching a display's mode blanks the screen for a moment, and that is not something to
  // do to someone who only asked to watch a film. A row that starts off is a promise that nothing moved.
  hdr: false,
  autoNext: true,
  subLang: '',
  audioLang: '',
  // 适应屏幕, because it is what the player has always done: mpv's own default, and the one mode that
  // shows the whole frame. A setting nobody touched must not crop or distort the picture.
  fit: 'fit',
  /* Off, because the chain is not free: measured in this app on 2026-10-29, a 720p file in a 1080p window
     went from 2.4% of the GPU to 15% on 标准 and 14% on 高, and a 4K source reached 48% on 高. A sharper
     picture is a choice, and the app has drawn every frame so far with mpv's own scaler. */
  anime4k: 'off',
  // Off by default. The preview is a second decoder running beside the film: measured 608 MB resident
  // while it scans a 4K source, plus a grid of frames on disk. A switch that costs that much must be
  // something the viewer asked for, not something the first 播放 signed them up for.
  thumbPreview: false,
};

const CLOSE_ACTIONS = ['quit', 'tray'] as const;

/** 退出程序, because a window that goes away without a word is what every switch in this file starts from:
 *  the app has no tray and no menu, so an unusual default would leave a user with no obvious way out. */
const DEFAULT_WINDOW: WindowPrefs = { closeAction: 'quit', hideOnPlay: false };

/** Ten gigabytes is the default because it is the largest of the four fixed ceilings the sheet offers and
 *  about seven 1080p episodes (measured 2026-10-28: 1.34 GB each) - enough for 追剧 to feel instant, small
 *  enough to be invisible on a normal disk. 不限制 (`0`) is a choice, not a default: a cache that fills the
 *  disk by itself is a surprise nobody asked for. On by default - the point of the feature is the second
 *  viewing, and a cache nobody switched on can never deliver one. */
const DEFAULT_MEDIA_CACHE: MediaCachePrefs = { enabled: true, limitGB: 10, clearOnExit: false, prefetchNext: true };

/** The one row every install starts with. Its id is fixed so a renamed official row is still recognised
 *  as the official one, and its URL is spelled here rather than imported: config is read before anything
 *  else, and it must not drag the network module in with it. */
const DANMAKU_OFFICIAL: DanmakuSource = { id: 'dandanplay', name: '弹弹play', url: 'https://api.dandanplay.net', enabled: true };

/** Enough rows to cover the official service plus every mirror a viewer is likely to have; a longer list
 *  would only slow down the fallback walk, which tries them one after another. */
const MAX_DANMAKU_SOURCES = 12;

const DEFAULT_DANMAKU: DanmakuSettings = {
  sources: [{ ...DANMAKU_OFFICIAL }],
  scrollPinned: false,
  delayMs: 0,
  lanes: 0,
  laneGap: 5,
  speed: 1,
  fontFamily: '',
  /* 18px is what the reference player shows out of the box. A size, not a fraction: a viewer who has chosen
    字号 expects the number the panel prints to be the number the canvas uses. */
  fontSize: 18,
  bold: false,
  displayArea: 1,
  opacity: 1,
  strokeWidth: 1,
  strokeColor: '#000000',
  shadowOffset: 0,
  shadowBlur: 0,
  shadowColor: '#000000',
  maxOnScreen: 80,
  blockedWords: '',
};

const DEFAULT_SETTINGS: Settings = {
  player: { ...DEFAULT_PLAYER },
  window: { ...DEFAULT_WINDOW },
  mediaCache: { ...DEFAULT_MEDIA_CACHE },
  proxyMode: 'system',
  proxyUrl: '',
  danmaku: { ...DEFAULT_DANMAKU },
};

const num = (v: unknown, lo: number, hi: number, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : dflt;

const str = (v: unknown, max = 160): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const pickPlayer = (raw: Partial<PlayerPrefs> | undefined): PlayerPrefs => ({
  hwdec: raw?.hwdec && HWDEC.includes(raw.hwdec) ? raw.hwdec : DEFAULT_PLAYER.hwdec,
  seekStepMs: num(raw?.seekStepMs, 1000, 120_000, DEFAULT_PLAYER.seekStepMs),
  // 'hdrHint' is what this row was called while it only forwarded mpv's colour-space hint; a config written
  // then must keep whatever the viewer had chosen, because the switch now decides whether the screen goes
  // into HDR at all — reading it as false would have silently turned the feature off for everyone.
  hdr: raw?.hdr === true || (raw as { hdrHint?: boolean } | undefined)?.hdrHint === true,
  autoNext: raw?.autoNext !== false,
  // Only a value the dialog can still print: a hand-edited `yuee` reads as 自动 instead of as a language no
  // track will ever match, which would look like the player ignoring the setting.
  subLang: isSubLang(raw?.subLang) ? raw.subLang : DEFAULT_PLAYER.subLang,
  audioLang: isAudioLang(raw?.audioLang) ? raw.audioLang : DEFAULT_PLAYER.audioLang,
  fit: raw?.fit && (FITS as readonly string[]).includes(raw.fit) ? (raw.fit as PlayerPrefs['fit']) : DEFAULT_PLAYER.fit,
  // A config written before the row existed has no key, and off is what such a file must read as: an
  // unknown level falls back here too, so a hand-edited value never loads half a shader chain.
  anime4k: isAnime4kLevel(raw?.anime4k) ? raw.anime4k : DEFAULT_PLAYER.anime4k,
  // A config written before this existed has no key, and off is what such a file must get: the worker is
  // a second decoder, so only an explicit `true` pays for it.
  thumbPreview: raw?.thumbPreview === true,
});

/* 'minimize' is what this row used to be called; a config written before the tray existed must map onto the
   behaviour that keeps the app running, not fall back to quitting — that would turn an old setting into the
   opposite of what was asked for, silently. The value is read as a bare string because that is all an old
   config.json is: the type would make the legacy spelling unreachable. */
const pickWindow = (raw: Partial<WindowPrefs> | undefined): WindowPrefs => {
  const v = raw?.closeAction as string | undefined;
  return {
    closeAction: v === 'minimize' || v === 'tray'
      ? 'tray'
      : v && (CLOSE_ACTIONS as readonly string[]).includes(v) ? (v as WindowPrefs['closeAction']) : DEFAULT_WINDOW.closeAction,
    /* Only a literal true turns this on: a config written before the row existed has no key at all, and a
       missing key must read as 「don't hide my window」 rather than as the falsy half of a ternary. */
    hideOnPlay: raw?.hideOnPlay === true,
  };
};

/* A missing key is read as the default rather than as false: every config written before this row existed
   has no mediaCache block at all. The limit is clamped rather than trusted, because the eviction loop
   compares it against real bytes and a typo of 2000 would simply never evict anything. Zero is legal and
   means 不限制, so the floor moves to zero; a negative or absurd number still falls back to the default. */
const pickMediaCache = (raw: Partial<MediaCachePrefs> | undefined): MediaCachePrefs => ({
  enabled: raw?.enabled !== false,
  limitGB: Math.round(num(raw?.limitGB, 0, 500, DEFAULT_MEDIA_CACHE.limitGB)),
  clearOnExit: raw?.clearOnExit === true,
  prefetchNext: raw?.prefetchNext !== false,
});

/* Every bound below is the range the panel's steppers can reach, so a hand-edited file cannot produce a
   layer that is invisible (opacity 0), off-screen (fontSize 900) or a fire hose (speed 40). 弹幕行数 0 is
   legal and means 「fit as many lanes as the area holds」, so its floor is zero rather than one. */
const pickDanmaku = (raw: Partial<DanmakuSettings> | undefined): DanmakuSettings => ({
  sources: pickDanmakuSources(raw?.sources),
  scrollPinned: raw?.scrollPinned === true,
  delayMs: Math.round(num(raw?.delayMs, -30_000, 30_000, DEFAULT_DANMAKU.delayMs)),
  lanes: Math.round(num(raw?.lanes, 0, 40, DEFAULT_DANMAKU.lanes)),
  laneGap: Math.round(num(raw?.laneGap, 0, 40, DEFAULT_DANMAKU.laneGap)),
  speed: num(raw?.speed, 0.5, 4, DEFAULT_DANMAKU.speed),
  fontFamily: str(raw?.fontFamily, 80),
  fontSize: Math.round(num(raw?.fontSize, 10, 64, DEFAULT_DANMAKU.fontSize)),
  bold: raw?.bold === true,
  displayArea: num(raw?.displayArea, 0.2, 1, DEFAULT_DANMAKU.displayArea),
  opacity: num(raw?.opacity, 0.2, 1, DEFAULT_DANMAKU.opacity),
  strokeWidth: Math.round(num(raw?.strokeWidth, 0, 6, DEFAULT_DANMAKU.strokeWidth)),
  strokeColor: pickColor(raw?.strokeColor, DEFAULT_DANMAKU.strokeColor),
  shadowOffset: Math.round(num(raw?.shadowOffset, 0, 12, DEFAULT_DANMAKU.shadowOffset)),
  shadowBlur: Math.round(num(raw?.shadowBlur, 0, 20, DEFAULT_DANMAKU.shadowBlur)),
  shadowColor: pickColor(raw?.shadowColor, DEFAULT_DANMAKU.shadowColor),
  maxOnScreen: Math.round(num(raw?.maxOnScreen, 10, 500, DEFAULT_DANMAKU.maxOnScreen)),
  blockedWords: str(raw?.blockedWords, 2000),
});

/** An endpoint is user text that ends up in a request, so it is narrowed to http(s) with no query and no
 *  trailing slash; anything else is dropped rather than handed to `net.fetch`. */
const cleanUrl = (v: unknown): string => {
  const raw = str(v, 300).trim();
  if (!/^https?:\/\/[^\s]+$/i.test(raw)) return '';
  return raw.replace(/\/+$/, '');
};

/**
 * 弹幕接口列表. Rows are kept in order because that order is the fallback order, so this never sorts. Two
 * rows pointing at one endpoint collapse to the first: the second could never be reached, and keeping it
 * would only make the settings list look longer than the walk. An empty list is not allowed — it would turn
 * 弹幕 off for reasons the viewer never chose — so the official row comes back instead.
 */
const pickDanmakuSources = (raw: unknown): DanmakuSource[] => {
  const rows = Array.isArray(raw) ? raw : [];
  const out: DanmakuSource[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Partial<DanmakuSource>;
    // No complete address, no row: 添加接口's blank row lives in the sheet until it is filled in, and closing
    // the sheet drops it. Storing blanks meant a config could hold twelve rows that ask nothing.
    const url = cleanUrl(r.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      id: str(r.id, 40) || `src-${out.length + 1}`,
      name: str(r.name, 40) || url.replace(/^https?:\/\//i, ''),
      url,
      enabled: r.enabled !== false,
    });
    if (out.length >= MAX_DANMAKU_SOURCES) break;
  }
  return out.length ? out : [{ ...DANMAKU_OFFICIAL }];
};

/** A colour from a config file goes straight into a canvas fill, so anything that is not `#rrggbb` falls
 *  back rather than being handed to the renderer as-is. */
const pickColor = (v: unknown, dflt: string): string =>
  typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : dflt;

/** Reads keep only the fields that still exist: the file outlives every knob we drop, and a leftover
    would end up either in mpv's command line or in a panel row nobody maintains. Each nested block is
    rebuilt from its own defaults, so a partial patch can neither smuggle in an unknown decoder nor
    wipe the sibling keys it did not mention. */
const pickSettings = (raw: Partial<Settings> | undefined): Settings => ({
  player: pickPlayer(raw?.player),
  window: pickWindow(raw?.window),
  mediaCache: pickMediaCache(raw?.mediaCache),
  proxyMode: raw?.proxyMode && PROXY_MODES.includes(raw.proxyMode) ? raw.proxyMode : DEFAULT_SETTINGS.proxyMode,
  proxyUrl: str(raw?.proxyUrl),
  danmaku: pickDanmaku(raw?.danmaku),
});

const file = () => path.join(app.getPath('userData'), 'config.json');

const readToken = (raw: string): string => {
  if (!raw.startsWith('dpapi:')) return raw;
  try {
    return safeStorage.decryptString(Buffer.from(raw.slice(6), 'base64'));
  } catch {
    return '';
  }
};

const writeToken = (token: string): string => {
  if (!safeStorage.isEncryptionAvailable()) return token;
  return 'dpapi:' + safeStorage.encryptString(token).toString('base64');
};

const decodeMeta = (raw: Partial<MetaKeys> | undefined): MetaKeys | undefined => {
  if (!raw) return undefined;
  const out: MetaKeys = {};
  if (typeof raw.tmdbV4Token === 'string' && raw.tmdbV4Token) out.tmdbV4Token = readToken(raw.tmdbV4Token);
  if (typeof raw.traktClientId === 'string' && raw.traktClientId) out.traktClientId = readToken(raw.traktClientId);
  return Object.keys(out).length ? out : undefined;
};

const encodeMeta = (meta: MetaKeys | undefined): MetaKeys | undefined => {
  if (!meta) return undefined;
  const out: MetaKeys = {};
  if (meta.tmdbV4Token) out.tmdbV4Token = writeToken(meta.tmdbV4Token);
  if (meta.traktClientId) out.traktClientId = writeToken(meta.traktClientId);
  return Object.keys(out).length ? out : undefined;
};

const defaults = (): AppConfig => ({
  deviceId: randomUUID(),
  deviceName: process.env.COMPUTERNAME || 'EchoEmby',
  clientName: 'EchoEmby',
  clientVersion: '0.1.0',
  accounts: [],
  activeAccountId: null,
  settings: { ...DEFAULT_SETTINGS, danmaku: { ...DEFAULT_DANMAKU } },
});

let cache: AppConfig | null = null;

export function load(): AppConfig {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as AppConfig & { accounts: Account[] };
    cache = { ...defaults(), ...parsed, settings: pickSettings(parsed.settings), meta: decodeMeta(parsed.meta) };
    cache.accounts = (parsed.accounts || []).map(a => ({ ...a, accessToken: readToken(a.accessToken) }));
  } catch {
    cache = defaults();
    save(cache);
  }
  return cache;
}

export function save(cfg: AppConfig = cache!): void {
  mkdirSync(path.dirname(file()), { recursive: true });
  const copy: AppConfig = {
    ...cfg,
    accounts: cfg.accounts.map(a => ({ ...a, accessToken: writeToken(a.accessToken) })),
    settings: { ...cfg.settings },
    meta: encodeMeta(cfg.meta),
  };
  writeFileSync(file(), JSON.stringify(copy, null, 2), 'utf8');
  cache = cfg;
}

export function get(): AppConfig {
  return load();
}

/** The shape the renderer may see. Every secret (login token, TMDB key, Trakt id) is masked here; 弹幕 no
 *  longer has one of its own, since the app's key never leaves the main process. */
export function publicSettings(): Settings {
  return { ...load().settings };
}

export function activeAccount(): Account | null {
  const cfg = load();
  return cfg.accounts.find(a => a.accountId === cfg.activeAccountId) || null;
}

export function upsertAccount(input: Omit<Account, 'accountId' | 'lastUsed'> & { accountId?: string }): Account {
  const cfg = load();
  const existing = cfg.accounts.find(x => x.baseUrl === input.baseUrl && x.username === input.username);
  const account: Account = {
    ...input,
    accountId: input.accountId || existing?.accountId || randomUUID(),
    // Logging into a server you already named keeps that name.
    label: input.label ?? existing?.label,
    lastUsed: Date.now(),
  };
  cfg.accounts = [...cfg.accounts.filter(x => x.accountId !== account.accountId), account];
  cfg.activeAccountId = account.accountId;
  save(cfg);
  return account;
}

export function setActive(id: string): void {
  const cfg = load();
  if (!cfg.accounts.some(a => a.accountId === id)) return;
  cfg.activeAccountId = id;
  cfg.accounts = cfg.accounts.map(a => (a.accountId === id ? { ...a, lastUsed: Date.now() } : a));
  save(cfg);
}

export function removeAccount(id: string): void {
  const cfg = load();
  cfg.accounts = cfg.accounts.filter(a => a.accountId !== id);
  if (cfg.activeAccountId === id) cfg.activeAccountId = cfg.accounts[0]?.accountId || null;
  save(cfg);
}

export function updateAccount(id: string, patch: Partial<Omit<Account, 'accountId'>>): Account | null {
  const cfg = load();
  const i = cfg.accounts.findIndex(a => a.accountId === id);
  if (i < 0) return null;
  // Editing keeps the slot and does not change which account is active.
  const next: Account = { ...cfg.accounts[i], ...patch, accountId: id };
  cfg.accounts = [...cfg.accounts.slice(0, i), next, ...cfg.accounts.slice(i + 1)];
  save(cfg);
  return next;
}

/** The decoder is read again when mpv is launched and at runtime, so it needs no restart. A patch may name
 *  only the rows the user touched: `{ player: { seekStepMs } }` keeps the decoder and the danmaku block. */
export function saveSettings(patch: SettingsPatch): Settings {
  const cfg = load();
  const next: Settings = {
    ...cfg.settings,
    ...patch,
    player: { ...cfg.settings.player, ...(patch.player || {}) },
    window: { ...cfg.settings.window, ...(patch.window || {}) },
    mediaCache: { ...cfg.settings.mediaCache, ...(patch.mediaCache || {}) },
    danmaku: { ...cfg.settings.danmaku, ...(patch.danmaku || {}) },
  };
  cfg.settings = pickSettings(next);
  save(cfg);
  return publicSettings();
}

/** Empty-string patches delete that key; undefined leaves it alone. The cache in each meta module
 *  is not invalidated here — old entries stay until their TTL expires, which is fine because the
 *  numbers themselves did not come from the key. */
export function setMetaKeys(patch: Partial<MetaKeys>): MetaKeys | undefined {
  const cfg = load();
  const cur: MetaKeys = { ...(cfg.meta || {}) };
  for (const k of ['tmdbV4Token', 'traktClientId'] as const) {
    const v = patch[k];
    if (v === undefined) continue;
    if (v === SECRET_MASK) continue; // the row came back untouched, it is not a new key
    if (v === '') delete cur[k];
    else cur[k] = v;
  }
  cfg.meta = Object.keys(cur).length ? cur : undefined;
  save(cfg);
  return publicMeta(cfg.meta);
}

/** The same rule the danmaku token follows: a stored key never crosses the bridge in plaintext, so the
 *  settings row can only read whether one is on file, replace it, or clear it. */
export function publicMeta(meta: MetaKeys | undefined): MetaKeys | undefined {
  if (!meta) return undefined;
  const out: MetaKeys = {};
  for (const k of ['tmdbV4Token', 'traktClientId'] as const) if (meta[k]) out[k] = SECRET_MASK;
  return Object.keys(out).length ? out : undefined;
}
