import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import * as config from '../config';

/**
 * Where every disposable file goes.
 *
 * Before 设置 → 缓存 could move them, each cache built its own path under the profile folder and there was no
 * single answer to "how big is this". One function now owns the question: a chosen folder wins, an empty
 * choice means the profile, and nothing that is not a cache (config.json, 本地字幕, the HDR claim) is ever
 * routed through here — moving a viewer's own files is not what 缓存位置 means.
 */
export const defaultRoot = (): string => app.getPath('userData');

export function cacheRoot(): string {
  const chosen = config.load().settings.cache.root;
  return chosen || defaultRoot();
}

export const cachePath = (...parts: string[]): string => path.join(cacheRoot(), ...parts);

/** The image cache is Chromium's, and its folder is fixed before the app is ready: a chosen root sends it to
 *  `<root>/chromium` on the next launch, while the default root keeps the profile's own `Cache` folder — the
 *  switch is only passed when a folder was chosen, so an untouched install reads exactly the folder it
 *  always had. */
export const imagesPath = (): string => {
  const chosen = config.load().settings.cache.root;
  return chosen ? path.join(chosen, 'chromium', 'Cache') : path.join(app.getPath('userData'), 'Cache');
};

/** A chosen folder can be on a drive that is not plugged in yet; the caller finds out by the write failing,
 *  which every cache already tolerates. This one is only here so the first write does not have to. */
export function ensureRoot(): void {
  try {
    mkdirSync(cacheRoot(), { recursive: true });
  } catch {
    // Unwritable: each cache falls back to answering misses, which is what it already does on a full disk.
  }
}
