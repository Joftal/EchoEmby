import { BrowserWindow, dialog, ipcMain } from 'electron';
import { EmbyClient, EmbyError, normalizeBase } from './emby/client';
import { detail, explain } from './emby/errors';
import * as config from './config';
import { rtScores } from './meta/rt';
import { imdbRating } from './meta/imdb';
import { traktScores } from './meta/trakt';
import { bangumiScore } from './meta/bangumi';
import { tmdbMeta, tmdbSeasonCast, tmdbSeasonStills, tmdbRelated, tmdbImages, tmdbLogos, tmdbTitleIds } from './meta/tmdb';
import { calendarSchedule } from './meta/calendar';
import { csmGuide } from './meta/csm';
import { PlayerWindows } from './player/windows';
import { revealWindow } from './tray';
import { PlayerController, type PlayerOut } from './player/session';
import { mediaCache } from './media-cache';
import * as danmaku from './danmaku';
import { applyProxy, probeNetwork } from './net';
import { type Account, type DanmakuLink, type DanmakuQuery, type DanmakuSource, type IpcResult, type PlayerCommand, type SettingsPatch } from '../shared/types';

/** Every renderer-facing failure crosses here, so this is the one line that has to say which channel asked.
 *  Without it a gateway error in the log — 服务器出错了, a Guid parse, a null reference — is a pile of twelve
 *  possible requests, which is how a refused progress write stays invisible. */
const wrap = async <T>(channel: string, fn: () => Promise<T> | T): Promise<IpcResult<T>> => {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    console.warn('[ipc]', channel, detail(e));
    return { ok: false, error: explain(e) };
  }
};

export class AppServices {
  private windows = new PlayerWindows();
  private player: PlayerController;

  constructor(private getMainWindow: () => BrowserWindow | null, private rendererUrl: (hash: string) => string) {
    // The player writes to every window because the state line is also read from the library window, and
    // the overlay that draws the controls is a separate process of its own.
    const out: PlayerOut = {
      state: s => this.broadcast('player:state', s),
      session: s => this.broadcast('player:session', s),
      media: m => this.broadcast('player:media', m),
      watched: w => this.broadcast('player:watched', w),
      hideMain: () => this.hideForPlayback(),
      /* Restoring goes through the same function the tray uses, so a window that was minimized rather than
         hidden still comes back as itself and not as a taskbar button asking for a second click. */
      reveal: () => revealWindow(this.getMainWindow()),
    };
    this.player = new PlayerController(this.windows, out, this.rendererUrl);
  }

  private identity() {
    const c = config.get();
    return { deviceId: c.deviceId, deviceName: c.deviceName, clientName: c.clientName, clientVersion: c.clientVersion, language: 'zh-cn' };
  }

  private client(): EmbyClient {
    const acc = config.activeAccount();
    if (!acc) throw new EmbyError('还没有登录任何服务器', 401);
    return new EmbyClient(acc, this.identity());
  }

  /** 播放时隐藏主程序: the same act × performs under 隐藏至菜单栏, made by the player instead of by a finger.
   *  Read from the settings at the moment it fires, so turning the row off while a film runs takes effect on
   *  the next viewing rather than at a relaunch. A window that is already hidden is left alone — and it is
   *  never minimized, because the tray icon is what brings the library back. */
  private hideForPlayback(): boolean {
    if (!config.load().settings.window.hideOnPlay) return false;
    const w = this.getMainWindow();
    if (!w || w.isDestroyed() || !w.isVisible()) return false;
    w.hide();
    return true;
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  }

  /** This gateway's login reply has no ServerName, so accounts saved with the bare host get the friendly name after launch. */
  private refreshServerName(): void {
    const acc = config.activeAccount();
    if (!acc || acc.serverName !== new URL(acc.baseUrl).host) return;
    new EmbyClient(acc, this.identity())
      .serverName()
      .then(name => {
        if (name) config.upsertAccount({ ...acc, serverName: name });
      })
      .catch(() => undefined);
  }

  register(): void {
    this.refreshServerName();
    ipcMain.handle('app:getConfig', () => wrap('app:getConfig', () => {
      const c = config.get();
      return { ...c, accounts: c.accounts.map(a => ({ ...a, accessToken: a.accessToken ? '<set>' : '' })), meta: config.publicMeta(c.meta), settings: config.publicSettings() };
    }));

    ipcMain.handle('app:login', (_e, { baseUrl, username, password }: { baseUrl: string; username: string; password: string }) =>
      wrap('app:login', async (): Promise<Account> => {
        const acc = await EmbyClient.login(normalizeBase(baseUrl), username, password, this.identity());
        acc.serverName = (await new EmbyClient(acc, this.identity()).serverName().catch(() => '')) || acc.serverName;
        return config.upsertAccount(acc);
      }),
    );

    ipcMain.handle('app:removeAccount', (_e, accountId: string) => wrap('app:removeAccount', () => {
      config.removeAccount(accountId);
      return config.get().activeAccountId;
    }));

    ipcMain.handle('app:updateAccount', (_e, input: { accountId: string; label?: string; baseUrl: string; username: string; password?: string }) =>
      wrap('app:updateAccount', async (): Promise<boolean> => {
        const cur = config.get().accounts.find(a => a.accountId === input.accountId);
        if (!cur) throw new EmbyError('账号不存在', 404);
        const baseUrl = normalizeBase(input.baseUrl);
        const username = input.username.trim();
        const label = input.label === undefined ? cur.label : input.label.trim().slice(0, 24) || undefined;
        if (input.password) {
          const fresh = await EmbyClient.login(baseUrl, username, input.password, this.identity());
          fresh.serverName = (await new EmbyClient(fresh, this.identity()).serverName().catch(() => '')) || fresh.serverName;
          const saved: Omit<Account, 'accountId'> = fresh;
          config.updateAccount(cur.accountId, { ...saved, label });
          return true;
        }
        // Without a typed password the stored token has to carry the new address, or we would save a dead account.
        const patch = { baseUrl, username, label };
        if (baseUrl !== cur.baseUrl || username !== cur.username) {
          await new EmbyClient({ ...cur, ...patch }, this.identity()).views();
        }
        config.updateAccount(cur.accountId, patch);
        return true;
      }),
    );

    ipcMain.handle('app:pingServer', (_e, baseUrl: string) => wrap('app:pingServer', () => EmbyClient.publicInfo(baseUrl, this.identity())));

    ipcMain.handle('app:setSettings', (_e, patch: SettingsPatch) => wrap('app:setSettings', async () => {
      // The route is part of the setting, so it moves here rather than on next launch. Applying first
      // means a rejected address never reaches the file, and the live route stays where it was.
      await applyProxy({ ...config.get().settings, ...patch });
      const next = config.saveSettings(patch);
      // A player knob has to reach the running stream, not wait for the next 播放.
      if (patch.player) this.player.applyPrefs(next.player);
      const settings = config.publicSettings();
      // 播放器面板 has its own 硬件解码 / 画面适配 / 动态范围 switches, and the sheet has the same rows: a write
      // in one window used to leave the other printing the value from launch, so a switch could read 开 while
      // the desktop it controls was already SDR. Every window is told what the file now holds.
      this.broadcast('app:settings', settings);
      return settings;
    }));

    ipcMain.handle('net:probe', () => wrap('net:probe', () => probeNetwork(this.identity())));

    // Every card shows its own server's totals, so this must read with that account's token, not the active one.
    ipcMain.handle('app:accountCounts', (_e, accountId: string) => wrap('app:accountCounts', async () => {
      const acc = config.get().accounts.find(a => a.accountId === accountId);
      if (!acc) throw new EmbyError('账号不存在', 404);
      return new EmbyClient(acc, this.identity()).counts();
    }));

    ipcMain.handle('app:switchAccount', (_e, accountId: string) => wrap('app:switchAccount', () => {
      config.setActive(accountId);
      return true;
    }));

    ipcMain.handle('emby:views', () => wrap('emby:views', () => this.client().navViews()));
    ipcMain.handle('emby:homeRows', () => wrap('emby:homeRows', () => this.client().homeRows()));
    ipcMain.handle('emby:resumeRow', (_e, limit?: number) => wrap('emby:resumeRow', () => this.client().resumeRow(Number(limit) || 18)));
    ipcMain.handle('emby:items', (_e, params) => wrap('emby:items', () => this.client().items(params)));
    // Both facet lists take an optional library id: a 分类 or 公司 list built from the whole account offers
    // entries that answer nothing inside the library being looked at.
    ipcMain.handle('emby:genres', (_e, scope?: string) => wrap('emby:genres', () => this.client().genres(String(scope || ''))));
    ipcMain.handle('emby:studios', (_e, scope?: string) => wrap('emby:studios', () => this.client().studios(String(scope || ''))));
    ipcMain.handle('emby:item', (_e, id: string) => wrap('emby:item', () => this.client().item(id)));
    ipcMain.handle('emby:seasons', (_e, id: string) => wrap('emby:seasons', () => this.client().seasons(id)));
    ipcMain.handle('emby:episodes', (_e, { seriesId, seasonId }: { seriesId: string; seasonId: string }) => wrap('emby:episodes', () => this.client().episodes(seriesId, seasonId)));
    ipcMain.handle('emby:favorite', (_e, { id, on }: { id: string; on: boolean }) => wrap('emby:favorite', () => this.client().setFavorite(id, on)));

    ipcMain.handle('emby:imageUrl', (_e, { id, tag, width, type }: { id: string; tag?: string; width: number; type?: 'primary' | 'backdrop' | 'logo' }) =>
      wrap('emby:imageUrl', () =>
        type === 'backdrop'
          ? this.client().backdropUrl({ id, backdropImageTag: tag }, width)
          : type === 'logo'
            ? this.client().logoUrl({ id, logoImageTag: tag }, width)
            : this.client().imageUrl({ id, primaryImageTag: tag }, width),
      ),
    );

    ipcMain.handle('meta:rt', (_e, imdb: string) => wrap('meta:rt', () => rtScores(imdb)));
    ipcMain.handle('meta:imdb', (_e, imdb: string) => wrap('meta:imdb', () => imdbRating(imdb)));
    ipcMain.handle('meta:trakt', (_e, { kind, imdb }: { kind: 'movie' | 'tv'; imdb: string }) => wrap('meta:trakt', () => traktScores(kind, imdb)));
    ipcMain.handle('meta:bangumi', (_e, title: string) => wrap('meta:bangumi', () => bangumiScore(title)));
    ipcMain.handle('meta:tmdb', (_e, { kind, tmdbId }: { kind: 'movie' | 'tv'; tmdbId: string }) => wrap('meta:tmdb', () => tmdbMeta(kind, tmdbId)));
    ipcMain.handle('meta:tmdbStills', (_e, { tmdbId, season }: { tmdbId: string; season: number }) => wrap('meta:tmdbStills', () => tmdbSeasonStills(tmdbId, season)));
    ipcMain.handle('meta:tmdbSeasonCast', (_e, { tmdbId, season }: { tmdbId: string; season: number }) => wrap('meta:tmdbSeasonCast', () => tmdbSeasonCast(tmdbId, season)));
    ipcMain.handle('meta:tmdbRelated', (_e, { kind, tmdbId }: { kind: 'movie' | 'tv'; tmdbId: string }) => wrap('meta:tmdbRelated', () => tmdbRelated(kind, tmdbId)));
    ipcMain.handle('meta:tmdbImages', (_e, { kind, tmdbId }: { kind: 'movie' | 'tv'; tmdbId: string }) => wrap('meta:tmdbImages', () => tmdbImages(kind, tmdbId)));
    ipcMain.handle('meta:tmdbLogos', (_e, { kind, tmdbId }: { kind: 'movie' | 'tv'; tmdbId: string }) => wrap('meta:tmdbLogos', () => tmdbLogos(kind, tmdbId)));
    ipcMain.handle('meta:tmdbTitles', (_e, term: string) => wrap('meta:tmdbTitles', () => tmdbTitleIds(term)));
    ipcMain.handle('meta:csm', (_e, { kind, title }: { kind: 'movie' | 'tv'; title: string }) => wrap('meta:csm', () => csmGuide(kind, title)));
    ipcMain.handle('meta:setKeys', (_e, patch: { tmdbV4Token?: string; traktClientId?: string }) => wrap('meta:setKeys', () => config.setMetaKeys(patch)));

    ipcMain.handle('calendar:schedule', (_e, { from, to, force }: { from: string; to: string; force?: boolean }) =>
      wrap('calendar:schedule', () => calendarSchedule(this.client(), from, to, !!force)),
    );

    // The player is one object with the whole lifecycle; every channel below is a thin pass-through, so
    // nothing the overlay can ask for needs a second copy of the logic here.
    ipcMain.handle('player:play', (_e, itemId: string, fromStart?: boolean) =>
      wrap('player:play', async () => (await this.player.play(itemId, fromStart), true)),
    );
    // The version a card has chosen lives in the controller, not in the window that asked: the player is a
    // second renderer, and a switch pressed on its own 播放源 card moves the same map the page reads.
    ipcMain.handle('player:lastSource', (_e, itemId: string) => this.player.lastSource(itemId));
    ipcMain.handle('player:chooseSource', (_e, itemId: string, sourceId: string) =>
      wrap('player:chooseSource', async () => (await this.player.chooseSource(itemId, sourceId), true)),
    );
    ipcMain.handle('player:command', (_e, cmd: PlayerCommand) => wrap('player:command', async () => (await this.player.command(cmd), true)));
    ipcMain.handle('player:close', () => wrap('player:close', async () => (await this.player.close(), true)));
    ipcMain.handle('player:state', () => this.player.getState());
    ipcMain.handle('player:session', () => wrap('player:session', () => this.player.getSession()));
    ipcMain.handle('player:media', () => wrap('player:media', () => this.player.getMedia()));
    // The bar's preview frame. A null url is a normal answer — nothing of the file has been decoded yet —
    // and exact:false means the picture is the nearest one that exists while the second under the pointer is
    // still being made. The renderer keeps asking while the pointer stays, so the wait reads as a tip that
    // sharpens rather than as a blocked pointer. precise:false is a pointer on its way somewhere: it takes
    // the pre-rendered grid cell, and only a pointer that has stopped pays for a seek to its own second.
    ipcMain.handle('player:thumb', (_e, timeMs: number, precise?: boolean) =>
      wrap('player:thumb', async () => this.player.thumbAt(Number(timeMs) || 0, precise !== false)),
    );
    // 本地字幕. The picker has to live in main — only main can open a native dialog — and the parent is the
    // window that asked, so the sheet is modal to the player rather than to a main window that may be hidden
    // behind 播放时隐藏主程序. Cancelling answers null; nothing was asked for, so nothing is said.
    ipcMain.handle('player:pickSubtitle', () => wrap('player:pickSubtitle', async () => {
      const parent = BrowserWindow.getFocusedWindow() ?? this.getMainWindow();
      // No filters: a subtitle usually arrives in the same download folder as the film, and a list that hides
      // everything else turns picking one into a hunt for a folder instead of a file. What cannot be read is
      // named when it is refused, which is a better answer than a file the dialog never showed.
      const opts = {
        title: '选择字幕文件',
        properties: ['openFile' as const],
      };
      const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
      const file = res.canceled ? '' : res.filePaths[0] || '';
      if (!file) return null;
      await this.player.useLocalSubtitle(file);
      return { name: file.split(/[\\/]/).pop() || '' };
    }));

    // 媒体缓存: the numbers the settings sheet prints come from the index the bridge already keeps, so this
    // is not a second accounting of the same bytes. Clearing runs while nothing is playing; a viewing that
    // is already on screen keeps its open file handles and simply stops adding to a folder that is gone.
    ipcMain.handle('mediaCache:stats', () => wrap('mediaCache:stats', async () => (await mediaCache.init(), mediaCache.stats())));
    ipcMain.handle('mediaCache:clear', () => wrap('mediaCache:clear', async () => {
      await mediaCache.clear();
      // The preview grids are the second thing this app writes to disk for a viewing, so 清理全部缓存 has to
      // reach them too - otherwise the button leaves hundreds of megabytes of the same film behind.
      await this.player.clearThumbs().catch(() => undefined);
      return mediaCache.stats();
    }));

    // 弹幕 talks to a service that is not the media server, and every handler answers nothing at all while
    // the switch in 设置 is off — the module checks that itself, so no row here has to.
    ipcMain.handle('danmaku:lookup', (_e, q: DanmakuQuery) => wrap('danmaku:lookup', () => danmaku.lookup(q)));
    ipcMain.handle('danmaku:track', (_e, { q, trackId, shift }: { q: DanmakuQuery; trackId: string; shift: number }) =>
      wrap('danmaku:track', () => danmaku.fetchTrack(q, trackId, shift || 0)));
    ipcMain.handle('danmaku:link', (_e, { q, link }: { q: DanmakuQuery; link: DanmakuLink | null }) =>
      wrap('danmaku:link', () => danmaku.setLink(q, link)));
    ipcMain.handle('danmaku:search', (_e, word: string) => wrap('danmaku:search', () => danmaku.search(word)));
    ipcMain.handle('danmaku:episodes', (_e, { animeTitle, animeId }: { animeTitle: string; animeId: string }) =>
      wrap('danmaku:episodes', () => danmaku.episodes(animeTitle, animeId)));
    ipcMain.handle('danmaku:episodeAt', (_e, { animeTitle, animeId, episode }: { animeTitle: string; animeId: string; episode: number }) =>
      wrap('danmaku:episodeAt', () => danmaku.episodeAt(animeTitle, animeId, episode)));
    ipcMain.handle('danmaku:countFor', (_e, { animeTitle, animeId, episode }: { animeTitle: string; animeId: string; episode: number }) =>
      wrap('danmaku:countFor', () => danmaku.countFor(animeTitle, animeId, episode || 0)));
    ipcMain.handle('danmaku:countOne', (_e, { id, api }: { id: string; api?: string }) =>
      wrap('danmaku:countOne', () => danmaku.countOne(id, api)))
  ipcMain.handle('danmaku:test', (_e, { source, keyword }: { source: DanmakuSource; keyword: string }) =>
      wrap('danmaku:test', () => danmaku.test(source, keyword)));
    ipcMain.handle('danmaku:debug', (_e, { base, path, method, body }: { base: string; path: string; method?: 'GET' | 'POST'; body?: unknown }) =>
      wrap('danmaku:debug', () => danmaku.debug(base, path, method, body)));

    ipcMain.on('ui:window', (e, { action }: { action: string }) => {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (!w) return;
      if (action === 'minimize') w.minimize();
      else if (action === 'maximize') w.isMaximized() ? w.unmaximize() : w.maximize();
      else if (action === 'close') w.close();
    });
  }

  /** Quit-time teardown only: the app is going away, so nothing waits for a window to be talked to. */
  async shutdown(): Promise<void> {
    await this.player.shutdown();
    // 退出程序时清理缓存. Ordered after the player so no chunk is being written while the folder is dropped;
    // the caller races this whole call against a five-second exit budget, so a slow disk loses the race
    // rather than holding the window open.
    await mediaCache.clearIfAsked().catch(() => undefined);
  }
}
