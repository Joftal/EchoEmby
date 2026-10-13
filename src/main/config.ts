import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Account, AppConfig, Settings } from '../shared/types';

const DEFAULT_SETTINGS: Settings = {
  maxStreamingBitrate: 140_000_000,
  hwdec: 'd3d11va',
};

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
    cache = { ...defaults(), ...parsed, settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) } };
    cache.accounts = (parsed.accounts || []).map(a => ({ ...a, accessToken: readToken(a.accessToken) }));
  } catch {
    cache = defaults();
    save(cache);
  }
  return cache;
}

export function save(cfg: AppConfig = cache!): void {
  mkdirSync(path.dirname(file()), { recursive: true });
  const copy: AppConfig = { ...cfg, accounts: cfg.accounts.map(a => ({ ...a, accessToken: writeToken(a.accessToken) })) };
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
