import { app, BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { raiseVideoSurface, raiseVideoSurfaceWhenReady } from './zorder';

const DEFAULT_H = 720;
const DEFAULT_W = 1280;

/**
 * Two top-level windows: an opaque host mpv paints into (via --wid) and a
 * transparent controls layer kept above it. The PoC showed DOM draws above the
 * native mpv surface and clicks still reach the DOM; the only native call needed
 * is raiseVideoSurface(), which lifts mpv over Chromium's compositor child inside
 * the host window.
 */
export class PlayerWindows {
  host: BrowserWindow | null = null;
  overlay: BrowserWindow | null = null;
  private syncing = false;

  get isOpen(): boolean {
    return !!this.host && !this.host.isDestroyed();
  }

  /** Decimal HWND string, the form mpv's --wid expects. */
  hostHwnd(): string {
    if (!this.host) throw new Error('player window is not open');
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
    if (this.isOpen) this.close();
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
    // The host exists only to own an HWND for mpv; it never loads a document.
    // Its compositor surface still stacks above mpv's child until raiseVideoSurface()
    // reorders them.
    this.host.loadURL('data:text/html,');
    const raise = () => this.raiseVideo();
    this.host.on('resize', raise);
    this.host.on('enter-full-screen', raise);
    this.host.on('leave-full-screen', raise);

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
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
        contextIsolation: true,
        sandbox: false,
      },
    });
    this.overlay.setAlwaysOnTop(true, 'screen-saver');
    this.overlay.loadURL(overlayUrl);

    const follow = (src: BrowserWindow, dst: BrowserWindow) => {
      const sync = () => {
        if (this.syncing || dst.isDestroyed() || src.isDestroyed()) return;
        this.syncing = true;
        try {
          if (src.isFullScreen() && !dst.isFullScreen()) dst.setFullScreen(true);
          else if (!src.isFullScreen() && dst.isFullScreen()) dst.setFullScreen(false);
          else dst.setBounds(src.getBounds());
        } finally {
          this.syncing = false;
        }
      };
      src.on('move', sync);
      src.on('resize', sync);
      src.on('enter-full-screen', sync);
      src.on('leave-full-screen', sync);
    };
    follow(this.host, this.overlay);
    follow(this.overlay, this.host);

    this.overlay.once('ready-to-show', () => {
      if (this.host && !this.host.isDestroyed()) this.host.show();
      if (this.overlay && !this.overlay.isDestroyed()) this.overlay.show();
    });
    // The overlay must hold keyboard focus, but mpv must keep painting; give focus
    // only after the host is up so the window manager does not hide the video.
    setTimeout(() => { if (!this.overlay?.isDestroyed() && !this.overlay?.isFocused()) this.overlay?.focus(); }, 400);

    this.overlay.on('closed', () => { this.overlay = null; });
    this.host.on('closed', () => { this.host = null; });
  }

  setFullscreen(on: boolean): void {
    this.host?.setFullScreen(on);
    this.overlay?.setFullScreen(on);
  }

  get isFullscreen(): boolean {
    return !!this.host?.isFullScreen();
  }

  close(): void {
    for (const w of [this.overlay, this.host]) {
      if (w && !w.isDestroyed()) w.destroy();
    }
    this.overlay = null;
    this.host = null;
  }

  focus(): void {
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.focus();
  }
}
