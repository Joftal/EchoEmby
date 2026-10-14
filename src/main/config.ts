import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Account, AppConfig, MetaKeys, Settings } from '../shared/types';

const DEFAULT_SETTINGS: Settings = {
  maxStreamingBitrate: 140_000_000,
  hwdec: 'd3d11va',
  proxyMode: 'system',
  proxyUrl: '',
};

const HWDEC = ['d3d11va', 'cuda', 'auto', 'no'] as const;
const PROXY_MODES = ['system', 'manual', 'none'] as const;

/** Reads keep only the fields that still exist: the file outlives every knob we drop, and a
    leftover `hwdec` would end up in mpv's command line. */
const pickSettings = (raw: Partial<Settings> | undefined): Settings => ({
  maxStreamingBitrate: typeof raw?.maxStreamingBitrate === 'number' && raw.maxStreamingBitrate > 0 ? raw.maxStreamingBitrate : DEFAULT_SETTINGS.maxStreamingBitrate,
  hwdec: raw?.hwdec && HWDEC.includes(raw.hwdec) ? raw.hwdec : DEFAULT_SETTINGS.hwdec,
  proxyMode: raw?.proxyMode && PROXY_MODES.includes(raw.proxyMode) ? raw.proxyMode : DEFAULT_SETTINGS.proxyMode,
  proxyUrl: typeof raw?.proxyUrl === 'string' ? raw.proxyUrl.trim().slice(0, 160) : '',
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
  settings: { ...DEFAULT_SETTINGS },
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
    meta: encodeMeta(cfg.meta),
  };
  writeFileSync(file(), JSON.stringify(copy, null, 2), 'utf8');
  cache = cfg;
}

export function get(): AppConfig {
  return load();
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

/** Both knobs are read again when the next stream is negotiated (PlaybackInfo for the cap, mpv's
 *  launch for the decoder), so a change needs no restart and takes effect on the next play. */
export function saveSettings(patch: Partial<Settings>): Settings {
  const cfg = load();
  cfg.settings = pickSettings({ ...cfg.settings, ...patch });
  save(cfg);
  return cfg.settings;
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
    if (v === '') delete cur[k];
    else cur[k] = v;
  }
  cfg.meta = Object.keys(cur).length ? cur : undefined;
  save(cfg);
  return cfg.meta;
}
