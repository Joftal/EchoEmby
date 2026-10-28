import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron';
import path from 'node:path';

/** Bring the window back from the tray, or from a minimize that predates the tray. */
export function revealWindow(w: BrowserWindow | null): void {
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  if (!w.isVisible()) w.show();
  w.focus();
}

/**
 * The tray icon is the only way back once × hides the window, so it is made when the app starts rather than
 * on the first hide: an icon that materialises only after the window has already gone is not something a
 * viewer can discover, and without it 隐藏至菜单栏 is a one-way door. Only two rows for now.
 *
 * Windows shows a 16px icon in the notification area (32px on a 200% display), so the 256px source is
 * resized rather than handed over whole.
 */
export function createTray(getWindow: () => BrowserWindow | null): Tray {
  const file = path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'resources', 'echoemby.png');
  const img = nativeImage.createFromPath(file);
  const tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
  tray.setToolTip('EchoEmby');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主界面', click: () => revealWindow(getWindow()) },
      { type: 'separator' },
      /* This is the one exit that survives 隐藏至菜单栏: it goes through app.quit(), so the shutdown in
         index.ts still stops the player and writes its position before the app goes. */
      { label: '退出程序', click: () => app.quit() },
    ]),
  );
  tray.on('double-click', () => revealWindow(getWindow()));
  return tray;
}
