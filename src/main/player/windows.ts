import { app, BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { raiseVideoSurface, raiseVideoSurfaceWhenReady } from './zorder';

/** Electron types each window event's listener separately, so a list of names has to be handed over one
 *  at a time; every callback here ignores the event object, which is the only shape that fits all of them. */
function onAll(w: BrowserWindow, events: readonly string[], fn: () => void): void {
  for (const ev of events) w.on(ev as 'resize', fn);
}
const DEFAULT_H = 720;
const DEFAULT_W = 1280;

/**
 * Two top-level windows: an opaque host mpv paints into (via --wid) and a transparent controls layer it
 * owns, so the pair moves, minimizes and retreats together. The PoC showed DOM draws above the native mpv
 * surface and clicks still reach the DOM; the only native call needed is raiseVideoSurface(), which lifts
 * mpv over Chromium's compositor child inside the host window.
 *
 * Both windows are one player: anything the user does to either one — resizing, fullscreening, closing —
 * is mirrored to the other and reported up, because the state the overlay renders has to be the truth
 * rather than what the last button press asked for.
 */
export class PlayerWindows {
  host: BrowserWindow | null = null;
  overlay: BrowserWindow | null = null;
  private syncing = false;
  /** The user closed the player. Reported once, from whichever window went first. */
  onClosed: () => void = () => undefined;
  onFullscreen: (on: boolean) => void = () => undefined;

  get isOpen(): boolean {
    return !!this.host && !this.host.isDestroyed();
  }

  /** Decimal HWND string, the form mpv's --wid expects. */
  hostHwnd(): string {
    if (!this.host) throw new Error('播放器窗口还没有打开');
    const buf = this.host.getNativeWindowHandle();
    return buf.length >= 8 ? String(buf.readBigUInt64LE(0)) : String(buf.readUInt32LE(0));
  }

  /** mpv resizes its surface on WM_SIZE, which can drop it back under the compositor. */
  raiseVideo(): void {
    if (!this.isOpen) return;
    raiseVideoSurface(Number(this.hostHwnd()));
  }

  raiseVideoWhenReady(): Promise<boolean> {
    return raiseVideoSurfaceWhenReady(Number(this.hostHwnd()));
  }

  open(overlayUrl: string): void {
    if (this.isOpen) this.closeQuietly();
    const work = screen.getPrimaryDisplay().workArea;
    const width = Math.min(DEFAULT_W, Math.round(work.width * 0.8));
    const height = Math.min(DEFAULT_H, Math.round(work.height * 0.8));
    const x = Math.round(work.x + (work.width - width) / 2);
    const y = Math.round(work.y + (work.height - height) / 2);

    this.host = new BrowserWindow({
      x, y, width, height,
      frame: false,
      transparent: false,
      backgroundColor: '#000000',
      show: false,
      skipTaskbar: false,
      icon: path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'resources', 'echoemby.png'),
      resizable: true,
      movable: true,
      hasShadow: true,
    });
    // The host exists only to own an HWND for mpv; it never loads a document. Its compositor surface
    // still stacks above mpv's child until raiseVideoSurface() reorders them.
    this.host.loadURL('data:text/html,');
    const raise = () => this.raiseVideo();
    onAll(this.host, ['resize', 'enter-full-screen', 'leave-full-screen', 'show'], raise);

    this.overlay = new BrowserWindow({
      x, y, width, height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      show: false,
      skipTaskbar: true,
      resizable: false,
      movable: true,
      focusable: true,
      hasShadow: false,
      // Owned by the picture window instead of pinned to the top of the desktop: `alwaysOnTop` made these
      // controls the highest window on the machine, so clicking anything else sent the video away and left
      // the bar painted on whatever came forward. Ownership keeps the layer above its owner - the raised mpv
      // surface included - and takes it to the back with the picture.
      parent: this.host,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
        contextIsolation: true,
        sandbox: false,
      },
    });
    this.overlay.loadURL(overlayUrl);

    const follow = (src: BrowserWindow, dst: () => BrowserWindow | null) => {
      const sync = () => {
        const other = dst();
        if (this.syncing || !other || other.isDestroyed() || src.isDestroyed()) return;
        this.syncing = true;
        try {
          if (src.isFullScreen() && !other.isFullScreen()) other.setFullScreen(true);
          else if (!src.isFullScreen() && other.isFullScreen()) other.setFullScreen(false);
          else other.setBounds(src.getBounds());
        } finally {
          this.syncing = false;
        }
      };
      onAll(src, ['move', 'resize', 'enter-full-screen', 'leave-full-screen'], sync);
    };
    follow(this.host, () => this.overlay);
    follow(this.overlay, () => this.host);

    // The overlay holds keyboard focus, but mpv must keep painting; give focus only after the host is up
    // so the window manager does not hide the video.
    this.overlay.once('ready-to-show', () => {
      if (this.host && !this.host.isDestroyed()) this.host.show();
      if (this.overlay && !this.overlay.isDestroyed()) this.overlay.show();
      setTimeout(() => this.focus(), 400);
    });
    // Fullscreen entered by the window manager (Win+F, a double-click, the OS shortcut) has to reach the
    // controls, or the button keeps offering 全屏 on a window that is already full screen.
    this.overlay.on('enter-full-screen', () => this.pushFullscreen(true));
    this.overlay.on('leave-full-screen', () => this.pushFullscreen(false));
    this.overlay.on('closed', () => {
      this.overlay = null;
      this.onClosed();
    });
    this.host.on('closed', () => {
      this.host = null;
      this.onClosed();
    });
  }

  private pushFullscreen(on: boolean): void {
    if (this.syncing) return;
    this.onFullscreen(on);
  }

  setFullscreen(on: boolean): void {
    this.syncing = true;
    try {
      if (this.host && !this.host.isDestroyed()) this.host.setFullScreen(on);
      if (this.overlay && !this.overlay.isDestroyed()) this.overlay.setFullScreen(on);
    } finally {
      this.syncing = false;
    }
    this.onFullscreen(on);
  }

  get isFullscreen(): boolean {
    return !!this.overlay && !this.overlay.isDestroyed() && this.overlay.isFullScreen();
  }

  /** Only while both windows are still alive: `close` is what the button does, `closed` is what the
   *  window manager does, and the second one must not report a failure from a player already on its way out. */
  private closeQuietly(): void {
    for (const w of [this.overlay, this.host]) {
      if (w && !w.isDestroyed()) w.destroy();
    }
    this.overlay = null;
    this.host = null;
  }

  close(): void {
    this.closeQuietly();
  }

  focus(): void {
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.focus();
  }

  bounds(): { width: number; height: number } | null {
    if (!this.overlay || this.overlay.isDestroyed()) return null;
    const b = this.overlay.getBounds();
    return { width: b.width, height: b.height };
  }
}
