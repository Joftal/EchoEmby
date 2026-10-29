import { app, BrowserWindow, shell } from 'electron';
import type { Tray } from 'electron';
import path from 'node:path';
import * as config from './config';
import { applyProxy } from './net';
import { startNetMeter } from './netmeter';
import { AppServices } from './ipc';
import { createTray, revealWindow } from './tray';
import { mediaCache } from './media-cache';
import { reclaimAbandonedHdr } from './player/hdr';

const DEV_URL = process.env.VITE_DEV_URL || '';
const rendererRoot = path.join(app.getAppPath(), 'dist', 'renderer');

const rendererUrl = (hash: string): string =>
  DEV_URL ? `${DEV_URL}/${hash}` : `file://${path.join(rendererRoot, 'index.html')}${hash}`;

let mainWindow: BrowserWindow | null = null;
let services: AppServices | null = null;
/** Held for the life of the app: a Tray that nothing references is garbage-collected and the icon vanishes. */
let tray: Tray | null = null;
/** Set as soon as the app is on its way out, by whichever gesture asked for it. The window's own close
 *  handler reads it: without the flag, the close that follows 「退出程序」 would be read as the user pressing
 *  × again and get minimized (or re-quit) instead of going through with the exit. */
let quitting = false;

const getMainWindow = () => mainWindow;

function createMainWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    show: false,
    frame: false,
    icon: path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'resources', 'echoemby.png'),
    backgroundColor: '#f4f4f7',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  w.once('ready-to-show', () => w.show());
  w.setMenuBarVisibility(false);
  /* The × lives in the renderer's own title bar (the window is frameless), but Alt+F4 and the window
     manager's close reach the same event, so the decision belongs here rather than in the button: one
     place, every gesture. The setting is read when the button is pressed, not when the app launched, so
     changing the row in 设置 does not need a restart. */
  w.on('close', e => {
    if (quitting) return;
    if (config.load().settings.window.closeAction === 'tray') {
      /* Hidden, not minimized: 隐藏至菜单栏 means the window leaves the taskbar too, and only the tray icon
         brings it back. Playback is untouched — the player's own windows are separate and stay where they are. */
      e.preventDefault();
      w.hide();
      return;
    }
    /* 退出程序 closes the player with it. Closing only this window would leave the overlay and the mpv
       process running with no page to control them — the film keeps playing and nothing can stop it but
       the task manager — so the app quits and the shutdown below takes the player down first. */
    e.preventDefault();
    app.quit();
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (DEV_URL) w.loadURL(`${DEV_URL}/`);
  else w.loadFile(path.join(rendererRoot, 'index.html'));
  mainWindow = w;
  return w;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  /* Launching the app again is the second way back from the tray, so it has to do what 显示主界面 does:
     a hidden window has to be shown, not merely focused. */
  app.on('second-instance', () => revealWindow(mainWindow));

  // Chromium's network stack carries every request this app makes, so the saved proxy mode is applied
  // to the session once here and again on each change; the direct route to this server measured
  // 152 B/s vs 2.8 MB/s through the local proxy, which is why 系统代理 is the default.
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');

  app.whenReady().then(async () => {
    startNetMeter();
    // A run that was killed while it held the desktop's HDR switch left it on: the claim file it wrote is the
    // only witness, and this is the first moment the display can be asked about it.
    reclaimAbandonedHdr();
    const s = config.load().settings;
    // A saved address that no longer parses must not leave the app without a route, and must not stay in
    // the file either. Measured 2026-10-14 by hand-poisoning config.json: the fallback kept traffic
    // alive, but the settings row went on reading 「手动代理 / not a url」 while the system route was what
    // actually carried every request - so the correction is written down, and the page tells the truth.
    try {
      await applyProxy(s);
    } catch {
      const fallback = { ...s, proxyMode: 'system' as const, proxyUrl: '' };
      await applyProxy(fallback).catch(() => undefined);
      config.saveSettings(fallback);
    }
    // The cache index is read before any window exists, so 设置 can print a real number the first time it is
    // opened and the first playback does not race the folder scan.
    void mediaCache.init();
    services = new AppServices(getMainWindow, rendererUrl);
    services.register();
    createMainWindow();
    tray = createTray(getMainWindow);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
      else revealWindow(mainWindow);
    });
  });

  app.on('window-all-closed', () => app.quit());

  // Quitting waits for the player's stop, because that one POST is what decides where the film resumes
  // anywhere. Bounded: a server that has stopped answering must not be able to hold the app open, so the
  // exit goes ahead without it after a beat.
  let cleanupStarted = false;
  app.on('before-quit', e => {
    quitting = true;
    /* The icon outlives the window, so it has to go when the exit is already decided: otherwise a shutdown
       that waits on the player's stop (up to 5s) leaves a tray icon nothing can answer. */
    tray?.destroy();
    tray = null;
    if (cleanupStarted) return;
    e.preventDefault();
    cleanupStarted = true;
    // Measured on these two gateways: the stop POST lands in 394ms and 657ms on a warm connection, while the
    // first request after a cold handshake took 7050ms. A budget of 1.5s would cut the one write that
    // decides where a film resumes whenever the app quits onto a connection that has gone cold.
    const exit = Promise.race([services?.shutdown(), new Promise(resolve => setTimeout(resolve, 5000))]);
    void exit.finally(() => app.quit());
  });
}

export type { AppServices };
