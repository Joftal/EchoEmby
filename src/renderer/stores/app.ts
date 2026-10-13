import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { AppConfig, LibraryItem, LibraryRow, Settings } from '../../shared/types';

export const useAppStore = defineStore('app', () => {
  const config = ref<AppConfig | null>(null);
  const rows = ref<LibraryRow[]>([]);
  const views = ref<LibraryItem[]>([]);
  const loading = ref(false);
  const error = ref('');
  const ready = ref(false);

  const account = computed(() => {
    const c = config.value;
    if (!c) return null;
    return c.accounts.find(a => a.accountId === c.activeAccountId) || null;
  });

  const imgCache = new Map<string, string>();

  async function init(): Promise<void> {
    const r = await window.echoemby.app.getConfig();
    if (r.ok && r.data) config.value = r.data;
    ready.value = true;
  }

  async function login(baseUrl: string, username: string, password: string): Promise<boolean> {
    error.value = '';
    const r = await window.echoemby.app.login({ baseUrl, username, password });
    if (!r.ok) {
      error.value = r.error || '登录失败';
      return false;
    }
    invalidate();
    await init();
    return true;
  }

  /** Item ids are per-server and collide across them, so nothing may survive a switch. */
  function invalidate(): void {
    imgCache.clear();
    rows.value = [];
    views.value = [];
    viewsPromise = null;
  }

  async function switchTo(accountId: string): Promise<boolean> {
    const r = await window.echoemby.app.switchAccount(accountId);
    if (!r.ok) {
      error.value = r.error || '切换失败';
      return false;
    }
    invalidate();
    await init();
    return true;
  }

  /** Removing the active account makes the main process fall back to any remaining one. */
  async function remove(accountId: string): Promise<string | null> {
    const r = await window.echoemby.app.removeAccount(accountId);
    if (!r.ok) {
      error.value = r.error || '移除失败';
      return null;
    }
    invalidate();
    await init();
    return r.data ?? null;
  }

  async function update(input: { accountId: string; label?: string; baseUrl: string; username: string; password?: string }): Promise<boolean> {
    error.value = '';
    const r = await window.echoemby.app.updateAccount(input);
    if (!r.ok) {
      error.value = r.error || '保存失败';
      return false;
    }
    invalidate();
    // The address or credentials changed, so any totals on file belong to another library.
    counts.value = Object.fromEntries(Object.entries(counts.value).filter(([id]) => id !== input.accountId));
    await init();
    return true;
  }

  /** The main process answers with the whole merged block, so the page reads back what it wrote. */
  async function saveSettings(patch: Partial<Settings>): Promise<boolean> {
    error.value = '';
    const r = await window.echoemby.app.setSettings(patch);
    if (!r.ok) {
      error.value = r.error || '保存失败';
      return false;
    }
    if (r.data && config.value) config.value = { ...config.value, settings: r.data };
    return true;
  }

  let viewsPromise: Promise<void> | null = null;

  const counts = ref<Record<string, { movies: number; series: number }>>({});
  const countsInFlight = new Set<string>();

  /** Library totals per server: asked once per account, kept for the session. */
  async function loadCounts(accountId: string): Promise<void> {
    if (counts.value[accountId] || countsInFlight.has(accountId)) return;
    countsInFlight.add(accountId);
    const r = await window.echoemby.app.accountCounts(accountId);
    countsInFlight.delete(accountId);
    if (r.ok && r.data) counts.value = { ...counts.value, [accountId]: r.data };
  }

  /** The rail lists the libraries on routes that never touch the home rows. */
  function loadViews(): Promise<void> {
    if (views.value.length) return Promise.resolve();
    if (!viewsPromise) {
      viewsPromise = window.echoemby.emby
        .views()
        .then(r => {
          if (r.ok) views.value = r.data || [];
        })
        .finally(() => {
          viewsPromise = null;
        });
    }
    return viewsPromise;
  }

  async function loadHome(): Promise<void> {
    if (loading.value) return;
    loading.value = true;
    error.value = '';
    const [viewsRes, rowsRes] = await Promise.all([window.echoemby.emby.views(), window.echoemby.emby.homeRows()]);
    if (viewsRes.ok) views.value = viewsRes.data || [];
    if (rowsRes.ok) rows.value = rowsRes.data || [];
    else error.value = rowsRes.error || '加载失败';
    loading.value = false;
  }

  /** Image URLs carry the session token, so they are minted in the main process. */
  async function imageUrl(item: { id: string; primaryImageTag?: string }, width = 320): Promise<string> {
    const key = `${account.value?.accountId}|primary:${item.id}:${width}`;
    const hit = imgCache.get(key);
    if (hit) return hit;
    const r = await window.echoemby.emby.imageUrl({ id: item.id, tag: item.primaryImageTag, width });
    const url = r.ok && r.data ? r.data : '';
    if (url) imgCache.set(key, url);
    return url;
  }

  async function backdropUrl(item: { id: string; backdropImageTag?: string }, width = 1600): Promise<string> {
    const key = `${account.value?.accountId}|backdrop:${item.id}:${width}`;
    const hit = imgCache.get(key);
    if (hit) return hit;
    const r = await window.echoemby.emby.imageUrl({ id: item.id, tag: item.backdropImageTag, width, type: 'backdrop' });
    const url = r.ok && r.data ? r.data : '';
    if (url) imgCache.set(key, url);
    return url;
  }

  return { config, account, rows, views, loading, error, ready, counts, init, login, switchTo, remove, update, saveSettings, loadCounts, loadHome, loadViews, imageUrl, backdropUrl };
});
