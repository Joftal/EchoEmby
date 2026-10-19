import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import * as config from './config';
import { applyProxy } from './net';
import { startNetMeter } from './netmeter';
import { AppServices } from './ipc';

const DEV_URL = process.env.VITE_DEV_URL || '';
const rendererRoot = path.join(app.getAppPath(), 'dist', 'renderer');

const rendererUrl = (hash: string): string =>
  DEV_URL ? `${DEV_URL}/${hash}` : `file://${path.join(rendererRoot, 'index.html')}${hash}`;

let mainWindow: BrowserWindow | null = null;
let services: AppServices | null = null;

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
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
  });

  // Chromium's network stack carries every request this app makes, so the saved proxy mode is applied
  // to the session once here and again on each change; the direct route to this server measured
  // 152 B/s vs 2.8 MB/s through the local proxy, which is why 系统代理 is the default.
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');

  app.whenReady().then(async () => {
    startNetMeter();
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
    services = new AppServices(getMainWindow, rendererUrl);
    services.register();
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());

  // Quitting waits for the player's stop, because that one POST is what decides where the film resumes
  // anywhere. Bounded: a server that has stopped answering must not be able to hold the app open, so the
  // exit goes ahead without it after a beat.
  let cleanupStarted = false;
  app.on('before-quit', e => {
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
