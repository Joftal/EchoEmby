import { BrowserWindow, ipcMain } from 'electron';
import { EmbyClient, EmbyError, normalizeBase } from './emby/client';
import { detail, explain } from './emby/errors';
import * as config from './config';
import { rtScores } from './meta/rt';
import { imdbRating } from './meta/imdb';
import { traktScores } from './meta/trakt';
import { bangumiScore } from './meta/bangumi';
import { tmdbMeta, tmdbSeasonCast, tmdbSeasonStills, tmdbRelated, tmdbImages, tmdbLogos } from './meta/tmdb';
import { csmGuide } from './meta/csm';
import { PlayerWindows } from './player/windows';
import { PlayerController, type PlayerOut } from './player/session';
import * as danmaku from './danmaku';
import { applyProxy, probeNetwork } from './net';
import { type Account, type DanmakuQuery, type IpcResult, type PlayerCommand, type SettingsPatch } from '../shared/types';

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
      reveal: () => this.getMainWindow()?.show(),
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
      return config.publicSettings();
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
    ipcMain.handle('emby:genres', () => wrap('emby:genres', () => this.client().genres()));
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
    ipcMain.handle('meta:csm', (_e, { kind, title }: { kind: 'movie' | 'tv'; title: string }) => wrap('meta:csm', () => csmGuide(kind, title)));
    ipcMain.handle('meta:setKeys', (_e, patch: { tmdbV4Token?: string; traktClientId?: string }) => wrap('meta:setKeys', () => config.setMetaKeys(patch)));

    // The player is one object with the whole lifecycle; every channel below is a thin pass-through, so
    // nothing the overlay can ask for needs a second copy of the logic here.
    ipcMain.handle('player:play', (_e, itemId: string, fromStart?: boolean) =>
      wrap('player:play', async () => (await this.player.play(itemId, fromStart), true)),
    );
    ipcMain.handle('player:command', (_e, cmd: PlayerCommand) => wrap('player:command', async () => (await this.player.command(cmd), true)));
    ipcMain.handle('player:close', () => wrap('player:close', async () => (await this.player.close(), true)));
    ipcMain.handle('player:state', () => this.player.getState());
    ipcMain.handle('player:session', () => wrap('player:session', () => this.player.getSession()));
    ipcMain.handle('player:media', () => wrap('player:media', () => this.player.getMedia()));

    // 弹幕 asks two services that are not the media server, so both handlers answer nothing at all while
    // the switch in 设置 is off.
    ipcMain.handle('danmaku:search', (_e, q: DanmakuQuery) => wrap('danmaku:search', () => danmaku.search(q)));
    ipcMain.handle('danmaku:track', (_e, { q, trackId }: { q: DanmakuQuery; trackId: string }) => wrap('danmaku:track', () => danmaku.fetchTrack(q, trackId)));

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
  }
}
