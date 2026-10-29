import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { isAudioLang, isSubLang } from '../shared/lang';
import type { Account, AppConfig, DanmakuSettings, DanmakuSourceConfig, MediaCachePrefs, MetaKeys, PlayerPrefs, Settings, SettingsPatch, WindowPrefs } from '../shared/types';

const HWDEC = ['d3d11va', 'cuda', 'auto', 'no'] as const;
const FITS = ['fit', 'fill', 'stretch'] as const;
const PROXY_MODES = ['system', 'manual', 'none'] as const;
const DANMAKU_SOURCES = ['bilibili', 'dandan'] as const;

/** What a masked secret reads as on screen. A patch carrying it back means "the row was not touched",
 *  so saving one setting never writes the placeholder over the real credential. */
export const SECRET_MASK = '<set>';

/* 自动 for both languages, and not 中文: the app has never chosen a subtitle on its own — mpv's own order
   did that, Chinese first — and a default of 中文 would silently change what plays for every file whose
   default track names another language. A row that starts on 自动 is a promise that nothing moved until the
   viewer pressed something. */
const DEFAULT_PLAYER: PlayerPrefs = {
  hwdec: 'd3d11va',
  seekStepMs: 10_000,
  hdrHint: false,
  autoNext: true,
  subLang: '',
  audioLang: '',
  // 适应屏幕, because it is what the player has always done: mpv's own default, and the one mode that
  // shows the whole frame. A setting nobody touched must not crop or distort the picture.
  fit: 'fit',
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

const DEFAULT_DANMAKU: DanmakuSettings = {
  enabled: false,
  source: { type: 'bilibili', url: '', token: '' },
  matchMode: 0,
  displayArea: 1,
  opacity: 0.85,
  fontScale: 1,
  durationMs: 9000,
  maxOnScreen: 80,
  blockedWords: '',
};

const DEFAULT_SETTINGS: Settings = {
  player: { ...DEFAULT_PLAYER },
  window: { ...DEFAULT_WINDOW },
  mediaCache: { ...DEFAULT_MEDIA_CACHE },
  proxyMode: 'system',
  proxyUrl: '',
  danmaku: { ...DEFAULT_DANMAKU, source: { ...DEFAULT_DANMAKU.source } },
};

const num = (v: unknown, lo: number, hi: number, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : dflt;

const str = (v: unknown, max = 160): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const pickPlayer = (raw: Partial<PlayerPrefs> | undefined): PlayerPrefs => ({
  hwdec: raw?.hwdec && HWDEC.includes(raw.hwdec) ? raw.hwdec : DEFAULT_PLAYER.hwdec,
  seekStepMs: num(raw?.seekStepMs, 1000, 120_000, DEFAULT_PLAYER.seekStepMs),
  hdrHint: raw?.hdrHint === true,
  autoNext: raw?.autoNext !== false,
  // Only a value the dialog can still print: a hand-edited `yuee` reads as 自动 instead of as a language no
  // track will ever match, which would look like the player ignoring the setting.
  subLang: isSubLang(raw?.subLang) ? raw.subLang : DEFAULT_PLAYER.subLang,
  audioLang: isAudioLang(raw?.audioLang) ? raw.audioLang : DEFAULT_PLAYER.audioLang,
  fit: raw?.fit && (FITS as readonly string[]).includes(raw.fit) ? (raw.fit as PlayerPrefs['fit']) : DEFAULT_PLAYER.fit,
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

const pickDanmaku = (raw: Partial<DanmakuSettings> | undefined): DanmakuSettings => {
  const src: Partial<DanmakuSourceConfig> = raw?.source || {};
  const type = src.type && DANMAKU_SOURCES.includes(src.type) ? src.type : DEFAULT_DANMAKU.source.type;
  return {
    enabled: raw?.enabled === true,
    source: { type, url: str(src.url, 200), token: str(src.token, 200) },
    matchMode: raw?.matchMode === 1 ? 1 : 0,
    displayArea: num(raw?.displayArea, 0.2, 1, DEFAULT_DANMAKU.displayArea),
    opacity: num(raw?.opacity, 0.2, 1, DEFAULT_DANMAKU.opacity),
    fontScale: num(raw?.fontScale, 0.6, 2, DEFAULT_DANMAKU.fontScale),
    durationMs: num(raw?.durationMs, 3000, 30_000, DEFAULT_DANMAKU.durationMs),
    maxOnScreen: Math.round(num(raw?.maxOnScreen, 10, 500, DEFAULT_DANMAKU.maxOnScreen)),
    blockedWords: str(raw?.blockedWords, 2000),
  };
};

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
  settings: { ...DEFAULT_SETTINGS, danmaku: { ...DEFAULT_DANMAKU, source: { ...DEFAULT_DANMAKU.source } } },
});

let cache: AppConfig | null = null;

export function load(): AppConfig {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as AppConfig & { accounts: Account[] };
    cache = { ...defaults(), ...parsed, settings: pickSettings(parsed.settings), meta: decodeMeta(parsed.meta) };
    cache.accounts = (parsed.accounts || []).map(a => ({ ...a, accessToken: readToken(a.accessToken) }));
    // The token is a credential for a service the user runs, so it is encrypted at rest exactly like a
    // login token and decrypted here, where only the danmaku module can see it.
    cache.settings.danmaku.source.token = readToken(parsed.settings?.danmaku?.source?.token || '');
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
    settings: { ...cfg.settings, danmaku: { ...cfg.settings.danmaku, source: { ...cfg.settings.danmaku.source, token: writeToken(cfg.settings.danmaku.source.token) } } },
    meta: encodeMeta(cfg.meta),
  };
  writeFileSync(file(), JSON.stringify(copy, null, 2), 'utf8');
  cache = cfg;
}

export function get(): AppConfig {
  return load();
}

/** The shape the renderer may see: the danmaku token never crosses the bridge in plaintext, so the
 *  settings row reads whether one is on file and the user can only replace or clear it. */
export function publicSettings(): Settings {
  const s = load().settings;
  return { ...s, danmaku: { ...s.danmaku, source: { ...s.danmaku.source, token: s.danmaku.source.token ? SECRET_MASK : '' } } };
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
  const source = { ...cfg.settings.danmaku.source, ...(patch.danmaku?.source || {}) };
  // A masked row returning means the field was not touched, not that the token is the word 「<set>」.
  if (source.token === SECRET_MASK) source.token = cfg.settings.danmaku.source.token;
  const next: Settings = {
    ...cfg.settings,
    ...patch,
    player: { ...cfg.settings.player, ...(patch.player || {}) },
    window: { ...cfg.settings.window, ...(patch.window || {}) },
    mediaCache: { ...cfg.settings.mediaCache, ...(patch.mediaCache || {}) },
    danmaku: { ...cfg.settings.danmaku, ...(patch.danmaku || {}), source },
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
