import { session } from 'electron';
import fsp from 'node:fs/promises';
import { renameSync } from 'node:fs';
import path from 'node:path';
import * as config from '../config';
import { META_FILES, resetSources } from '../meta/cache';
import { resetCalendar } from '../meta/calendar';
import { resetCsm } from '../meta/csm';
import { resetRt } from '../meta/rt';
import { resetTmdb } from '../meta/tmdb';
import { resetStore as resetDanmaku } from '../danmaku';
import { diskCache } from './disk';
import { userDataStore } from './userdata';
import { mediaCache } from '../media-cache';
import { cachePath, cacheRoot, defaultRoot, imagesPath } from './root';
import type { CacheCategory, CacheCategoryId, CacheUsage } from '../../shared/types';

/**
 * The management side of the caches: what is on disk, which kind each file is, and how to throw one kind away
 * without touching another.
 *
 * The split is by owner, not by folder: 剧集信息 is the server's answers (disk.ts) plus the 观看状态 grafted
 * back onto them (userdata.ts) and the two only make sense together; 元数据 is the eight JSON files the
 * outside sources keep; 弹幕链接 is what the matcher remembered, including the 链接 the viewer made by hand,
 * which is why it is offered separately instead of under 全部清空.
 */

/** Folders this app owns inside the cache root. 本地字幕 and the HDR claim are deliberately absent: the first
 *  is the viewer's own file, the second is a fact about the machine, not a cache. */
const MOVE_DIRS = ['emby-cache', 'media-cache', 'thumbs'];
const MOVE_FILES = [...META_FILES, 'calendar.json', 'danmaku.json'];

const LISTS: { id: CacheCategoryId; label: string; hint: string; restart?: boolean }[] = [
  { id: 'media', label: '媒体缓存', hint: '看过的片段，回拖不再下载' },
  { id: 'data', label: '剧集信息', hint: '库、季、集与搜索结果的服务器答复' },
  { id: 'images', label: '海报与图片', hint: '海报、剧照、背景图（Chromium 的图片缓存）', restart: true },
  { id: 'meta', label: '元数据', hint: 'TMDB、IMDb、豆瓣、Trakt、Bangumi 与追剧日历' },
  { id: 'danmaku', label: '弹幕链接', hint: '匹配到的作品与集数；手动链接也在这里' },
  { id: 'thumbs', label: '预览缩略图', hint: '进度条预览的帧，一集约 3 MB' },
];

/** A folder's size and file count, or zeros when it is not there. Never throws: a cache that cannot be read
 *  is a cache that shows 0. */
async function dirUsage(dir: string, onlyDirs = false): Promise<{ bytes: number; items: number }> {
  let bytes = 0;
  let items = 0;
  const walk = async (at: string): Promise<void> => {
    const rows = await fsp.readdir(at, { withFileTypes: true }).catch(() => []);
    for (const row of rows) {
      const p = path.join(at, row.name);
      if (row.isDirectory()) {
        items++;
        await walk(p);
      } else if (!onlyDirs) {
        const st = await fsp.stat(p).catch(() => null);
        if (st) bytes += st.size;
      }
    }
  };
  await walk(dir);
  return { bytes, items };
}

async function fileUsage(file: string): Promise<{ bytes: number; items: number }> {
  const st = await fsp.stat(file).catch(() => null);
  return { bytes: st?.size ?? 0, items: st && st.size > 0 ? 1 : 0 };
}

async function category(id: CacheCategoryId): Promise<CacheCategory> {
  const base = LISTS.find(c => c.id === id) as (typeof LISTS)[number];
  let usage = { bytes: 0, items: 0 };
  if (id === 'media') {
    const st = mediaCache.stats();
    usage = { bytes: st.bytes, items: st.items };
  } else if (id === 'data') {
    const st = diskCache.stats();
    const rows = await fileUsage(cachePath('emby-cache', 'userdata.json'));
    usage = { bytes: st.bytes + rows.bytes, items: st.entries };
  } else if (id === 'images') {
    // Chromium's own folder holds index files and blobs; the number worth printing is how much disk it takes.
    usage = await dirUsage(imagesPath());
  } else if (id === 'meta') {
    for (const f of META_FILES) {
      const u = await fileUsage(cachePath(f));
      usage = { bytes: usage.bytes + u.bytes, items: usage.items + u.items };
    }
    const cal = await fileUsage(cachePath('calendar.json'));
    usage = { bytes: usage.bytes + cal.bytes, items: usage.items + cal.items };
  } else if (id === 'danmaku') {
    usage = await fileUsage(cachePath('danmaku.json'));
  } else if (id === 'thumbs') {
    // One folder per item+version, each holding a grid plus meta.json; the count the sheet shows is how many
    // grids exist, which is what 「一集约 3 MB」 multiplies by.
    usage = await dirUsage(cachePath('thumbs'), true);
  }
  return { id: base.id, label: base.label, hint: base.hint, restart: base.restart, bytes: usage.bytes, items: usage.items };
}

export async function usage(): Promise<CacheUsage> {
  const categories = await Promise.all(LISTS.map(c => category(c.id)));
  const total = categories.reduce((n, c) => n + c.bytes, 0);
  const st = diskCache.stats();
  return { root: cacheRoot(), defaultRoot: defaultRoot(), total, categories, hits: st.hits, misses: st.misses };
}

/** Every reader of a cache holds an in-memory copy; after a delete they must all be told, or the sheet keeps
 *  printing the numbers of files that are gone. */
function forget(): void {
  diskCache.reset();
  userDataStore.reset();
  resetSources();
  resetCalendar();
  resetCsm();
  resetRt();
  resetTmdb();
  resetDanmaku();
}

const rmDir = (dir: string): Promise<void> => fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);

export async function clearCategory(id: CacheCategoryId): Promise<CacheUsage> {
  if (id === 'media') {
    await mediaCache.clear();
  } else if (id === 'data') {
    diskCache.clear();
    userDataStore.clear();
  } else if (id === 'images') {
    // Only the HTTP cache: cookies and localStorage in this session are not disposable pictures.
    await session.defaultSession.clearCache().catch(() => undefined);
  } else if (id === 'meta') {
    for (const f of META_FILES) await fsp.rm(cachePath(f), { force: true }).catch(() => undefined);
    await fsp.rm(cachePath('calendar.json'), { force: true }).catch(() => undefined);
    forget();
  } else if (id === 'danmaku') {
    await fsp.rm(cachePath('danmaku.json'), { force: true }).catch(() => undefined);
    forget();
  } else if (id === 'thumbs') {
    await rmDir(cachePath('thumbs'));
  }
  return usage();
}

export async function clearAll(): Promise<CacheUsage> {
  for (const c of LISTS) await clearCategory(c.id);
  return usage();
}

/**
 * Point every cache at another folder, taking what is already there with it.
 *
 * A rename is instant and atomic per entry, so the common case (another drive letter on the same disk) costs
 * nothing. Across volumes a rename fails with EXDEV; those entries are left behind rather than copied, because
 * the only thing at stake is a cache and a half-gigabyte copy behind a settings toggle is a worse answer than
 * one refetch. The image cache cannot move while Chromium is running: it follows on the next launch, which is
 * what the row says.
 */
export async function setRoot(next: string): Promise<CacheUsage> {
  const root = next.trim().replace(/[\\/]+$/, '');
  if (root && !/^([a-zA-Z]:[\\/]|\\\\)/.test(root) && !root.startsWith('/')) throw new Error('请选择绝对路径');
  const to = root || defaultRoot();
  const from = cacheRoot();
  if (to !== from) {
    await fsp.mkdir(to, { recursive: true }).catch(() => undefined);
    for (const name of MOVE_DIRS) {
      const src = path.join(from, name);
      const dst = path.join(to, name);
      const there = await fsp.stat(dst).catch(() => null);
      if (there) continue;
      try {
        renameSync(src, dst);
      } catch {
        // Another volume, or the source is not there: the new folder simply starts empty.
      }
    }
    for (const name of MOVE_FILES) {
      const src = path.join(from, name);
      const dst = path.join(to, name);
      try {
        renameSync(src, dst);
      } catch {
        // Same as above.
      }
    }
  }
  config.saveSettings({ cache: { root } });
  forget();
  await mediaCache.reset();
  return usage();
}
