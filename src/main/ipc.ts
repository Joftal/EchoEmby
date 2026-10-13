import { BrowserWindow, ipcMain } from 'electron';
import { EmbyClient, EmbyError, normalizeBase } from './emby/client';
import { detail, explain } from './emby/errors';
import * as config from './config';
import { rtScores } from './meta/rt';
import { imdbRating } from './meta/imdb';
import { traktScores } from './meta/trakt';
import { bangumiScore } from './meta/bangumi';
import { tmdbMeta, tmdbSeasonStills, tmdbSimilar, tmdbImages } from './meta/tmdb';
import { csmGuide } from './meta/csm';
import { MpvPlayer } from './player/mpv';
import { StreamBridge } from './player/bridge';
import { PlayerWindows } from './player/windows';
import { emptyPlayerState, type Account, type IpcResult, type PlayerState, type Settings } from '../shared/types';

const wrap = async <T>(fn: () => Promise<T> | T): Promise<IpcResult<T>> => {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    console.warn('[ipc]', detail(e));
    return { ok: false, error: explain(e) };
  }
};

export class AppServices {
  private mpv: MpvPlayer | null = null;
  private bridge: StreamBridge | null = null;
  private windows = new PlayerWindows();
  private progressTimer: NodeJS.Timeout | null = null;
  private session: { itemId: string; mediaSourceId: string; playSessionId: string } | null = null;
  private lastState: PlayerState = emptyPlayerState();

  constructor(private getMainWindow: () => BrowserWindow | null, private rendererUrl: (hash: string) => string) {}

  private identity() {
    const c = config.get();
    return { deviceId: c.deviceId, deviceName: c.deviceName, clientName: c.clientName, clientVersion: c.clientVersion, language: 'zh-cn' };
  }

  private client(): EmbyClient {
    const acc = config.activeAccount();
    if (!acc) throw new EmbyError('还没有登录任何服务器', 401);
    return new EmbyClient(acc, this.identity(), config.get().settings);
  }

  /** This gateway's login reply has no ServerName, so accounts saved with the bare host get the friendly name after launch. */
  private refreshServerName(): void {
    const acc = config.activeAccount();
    if (!acc || acc.serverName !== new URL(acc.baseUrl).host) return;
    new EmbyClient(acc, this.identity(), config.get().settings)
      .serverName()
      .then(name => {
        if (name) config.upsertAccount({ ...acc, serverName: name });
      })
      .catch(() => undefined);
  }

  private broadcast(state: PlayerState): void {
    this.lastState = state;
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('player:state', state);
    }
  }

  private ensurePlayer(): MpvPlayer {
    if (this.mpv?.running) return this.mpv;
    this.mpv = new MpvPlayer();
    this.mpv.onState(s => {
      this.broadcast(s);
      if (s.status === 'ended' && this.session) {
        this.reportProgress(true);
        const itemId = this.session.itemId;
        this.client()
          .markPlayed(itemId)
          .catch(() => undefined);
      }
    });
    return this.mpv;
  }

  private async attachPlayer(): Promise<void> {
    if (this.mpv?.running) return;
    if (!this.windows.isOpen) this.windows.open(this.rendererUrl('#/player'));
    const hwnd = this.windows.hostHwnd();
    const p = this.ensurePlayer();
    const settings = config.get().settings;
    await p.start({ hwnd, hwdec: settings.hwdec });
    await this.windows.raiseVideoWhenReady();
  }

  /**
   * mpv opens the loopback URL; the bridge is the side that talks TLS to the server.
   * Measured: ffmpeg's TLS fails this proxy's CONNECT ~2/10, net.fetch 8/8.
   */
  private async ensureBridge(streamUrl: string): Promise<string> {
    if (!this.bridge) this.bridge = new StreamBridge();
    return this.bridge.open(streamUrl);
  }

  private startProgressTicker(): void {
    this.stopProgressTicker();
    this.progressTimer = setInterval(() => this.reportProgress(false), 15000);
  }

  private stopProgressTicker(): void {
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.progressTimer = null;
  }

  private reportProgress(paused: boolean): void {
    const s = this.session;
    const st = this.lastState;
    if (!s || !st.durationMs) return;
    this.client()
      .reportProgress(s.itemId, s.mediaSourceId, s.playSessionId, st.positionMs, st.durationMs, paused || st.paused)
      .catch(() => undefined);
  }

  register(): void {
    this.refreshServerName();
    ipcMain.handle('app:getConfig', () => wrap(() => {
      const c = config.get();
      return { ...c, accounts: c.accounts.map(a => ({ ...a, accessToken: a.accessToken ? '<set>' : '' })) };
    }));

    ipcMain.handle('app:login', (_e, { baseUrl, username, password }: { baseUrl: string; username: string; password: string }) =>
      wrap(async (): Promise<Account> => {
        const acc = await EmbyClient.login(normalizeBase(baseUrl), username, password, this.identity());
        acc.serverName = (await new EmbyClient(acc, this.identity(), config.get().settings).serverName().catch(() => '')) || acc.serverName;
        return config.upsertAccount(acc);
      }),
    );

    ipcMain.handle('app:removeAccount', (_e, accountId: string) => wrap(() => {
      config.removeAccount(accountId);
      return config.get().activeAccountId;
    }));

    ipcMain.handle('app:updateAccount', (_e, input: { accountId: string; label?: string; baseUrl: string; username: string; password?: string }) =>
      wrap(async (): Promise<boolean> => {
        const cur = config.get().accounts.find(a => a.accountId === input.accountId);
        if (!cur) throw new EmbyError('账号不存在', 404);
        const settings = config.get().settings;
        const baseUrl = normalizeBase(input.baseUrl);
        const username = input.username.trim();
        const label = input.label === undefined ? cur.label : input.label.trim().slice(0, 24) || undefined;
        if (input.password) {
          const fresh = await EmbyClient.login(baseUrl, username, input.password, this.identity());
          fresh.serverName = (await new EmbyClient(fresh, this.identity(), settings).serverName().catch(() => '')) || fresh.serverName;
          const saved: Omit<Account, 'accountId'> = fresh;
          config.updateAccount(cur.accountId, { ...saved, label });
          return true;
        }
        // Without a typed password the stored token has to carry the new address, or we would save a dead account.
        const patch = { baseUrl, username, label };
        if (baseUrl !== cur.baseUrl || username !== cur.username) {
          await new EmbyClient({ ...cur, ...patch }, this.identity(), settings).views();
        }
        config.updateAccount(cur.accountId, patch);
        return true;
      }),
    );

    ipcMain.handle('app:pingServer', (_e, baseUrl: string) => wrap(() => EmbyClient.publicInfo(baseUrl, this.identity())));

    ipcMain.handle('app:setSettings', (_e, patch: Partial<Settings>) => wrap(() => config.saveSettings(patch)));

    // Every card shows its own server's totals, so this must read with that account's token, not the active one.
    ipcMain.handle('app:accountCounts', (_e, accountId: string) => wrap(async () => {
      const acc = config.get().accounts.find(a => a.accountId === accountId);
      if (!acc) throw new EmbyError('账号不存在', 404);
      return new EmbyClient(acc, this.identity(), config.get().settings).counts();
    }));

    ipcMain.handle('app:switchAccount', (_e, accountId: string) => wrap(() => {
      config.setActive(accountId);
      return true;
    }));

    ipcMain.handle('emby:views', () => wrap(() => this.client().views()));
    ipcMain.handle('emby:homeRows', () => wrap(() => this.client().homeRows()));
    ipcMain.handle('emby:items', (_e, params) => wrap(() => this.client().items(params)));
    ipcMain.handle('emby:item', (_e, id: string) => wrap(() => this.client().item(id)));
    ipcMain.handle('emby:seasons', (_e, id: string) => wrap(() => this.client().seasons(id)));
    ipcMain.handle('emby:episodes', (_e, { seriesId, seasonId }: { seriesId: string; seasonId: string }) => wrap(() => this.client().episodes(seriesId, seasonId)));
    ipcMain.handle('emby:favorite', (_e, { id, on }: { id: string; on: boolean }) => wrap(() => this.client().setFavorite(id, on)));

    ipcMain.handle('emby:imageUrl', (_e, { id, tag, width, type }: { id: string; tag?: string; width: number; type?: 'primary' | 'backdrop' }) =>
      wrap(() =>
        type === 'backdrop'
          ? this.client().backdropUrl({ id, backdropImageTag: tag }, width)
          : this.client().imageUrl({ id, primaryImageTag: tag }, width),
      ),
    );

    ipcMain.handle('meta:rt', (_e, imdb: string) => wrap(() => rtScores(imdb)));
    ipcMain.handle('meta:imdb', (_e, imdb: string) => wrap(() => imdbRating(imdb)));
    ipcMain.handle('meta:trakt', (_e, { kind, imdb }: { kind: 'movie' | 'tv'; imdb: string }) => wrap(() => traktScores(kind, imdb)));
    ipcMain.handle('meta:bangumi', (_e, title: string) => wrap(() => bangumiScore(title)));
    ipcMain.handle('meta:tmdb', (_e, { kind, tmdbId }: { kind: 'movie' | 'tv'; tmdbId: string }) => wrap(() => tmdbMeta(kind, tmdbId)));
    ipcMain.handle('meta:tmdbStills', (_e, { tmdbId, season }: { tmdbId: string; season: number }) => wrap(() => tmdbSeasonStills(tmdbId, season)));
    ipcMain.handle('meta:tmdbSimilar', (_e, { kind, tmdbId }: { kind: 'movie' | 'tv'; tmdbId: string }) => wrap(() => tmdbSimilar(kind, tmdbId)));
    ipcMain.handle('meta:tmdbImages', (_e, { kind, tmdbId }: { kind: 'movie' | 'tv'; tmdbId: string }) => wrap(() => tmdbImages(kind, tmdbId)));
    ipcMain.handle('meta:csm', (_e, { kind, title }: { kind: 'movie' | 'tv'; title: string }) => wrap(() => csmGuide(kind, title)));
    ipcMain.handle('meta:setKeys', (_e, patch: { tmdbV4Token?: string; traktClientId?: string }) => wrap(() => config.setMetaKeys(patch)));

    ipcMain.handle('player:play', (_e, itemId: string) =>
      wrap(async () => {
        const c = this.client();
        const [info, resume] = await Promise.all([c.playbackInfo(itemId), c.resumePoint(itemId)]);
        const name = resume.name || info.name || itemId;
        const playUrl = await this.ensureBridge(info.directUrl);
        await this.attachPlayer();
        const p = this.ensurePlayer();
        this.session = { itemId, mediaSourceId: info.mediaSourceId, playSessionId: info.playSessionId };
        try {
          await p.load(playUrl, name, { startMs: resume.startMs, playMethod: info.playMethod });
        } catch (e) {
          // The overlay is a different window than the caller, so a failure has to
          // travel through the shared state or the user just sees a black screen.
          this.broadcast({ ...this.lastState, status: 'error', error: explain(e) });
          throw e;
        }
        this.startProgressTicker();
        this.windows.focus();
        return true;
      }),
    );

    ipcMain.handle('player:command', (_e, cmd: { action: string; value?: any }) =>
      wrap(async () => {
        const p = this.mpv;
        if (!p?.running) return false;
        switch (cmd.action) {
          case 'toggle': await p.toggle(); break;
          case 'seek': await p.seekTo(Number(cmd.value)); break;
          case 'seekBy': await p.seekBy(Number(cmd.value)); break;
          case 'volume': await p.setVolume(Number(cmd.value)); break;
          case 'mute': await p.setMuted(!!cmd.value); break;
          case 'sid': await p.setSubtitleIndex(cmd.value === 'no' || cmd.value === 'auto' ? cmd.value : Number(cmd.value)); break;
          default: throw new Error(`unknown action ${cmd.action}`);
        }
        if (cmd.action === 'toggle') this.reportProgress(false);
        return true;
      }),
    );

    ipcMain.handle('player:fullscreen', (_e, on: boolean) => wrap(() => { this.windows.setFullscreen(on); return this.windows.isFullscreen; }));
    ipcMain.handle('player:state', () => this.lastState);

    ipcMain.handle('player:close', () =>
      wrap(async () => {
        this.stopProgressTicker();
        this.reportProgress(true);
        await this.mpv?.quit();
        this.mpv = null;
        this.bridge?.close();
        this.bridge = null;
        this.session = null;
        this.windows.close();
        this.broadcast(emptyPlayerState());
        this.getMainWindow()?.show();
        return true;
      }),
    );

    ipcMain.on('ui:window', (e, { action }: { action: string }) => {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (!w) return;
      if (action === 'minimize') w.minimize();
      else if (action === 'maximize') w.isMaximized() ? w.unmaximize() : w.maximize();
      else if (action === 'close') w.close();
    });
  }

  async shutdown(): Promise<void> {
    this.stopProgressTicker();
    if (this.session) this.reportProgress(true);
    await this.mpv?.quit().catch(() => undefined);
    this.mpv = null;
    this.bridge?.close();
    this.bridge = null;
    this.windows.close();
  }
}
