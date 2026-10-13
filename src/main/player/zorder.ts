import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const findWindowEx = user32.func(
  'void *FindWindowExW(void *parent, void *after, const char16_t *cls, const char16_t *title)',
);
const setWindowPos = user32.func(
  'bool SetWindowPos(void *hwnd, void *insertAfter, int x, int y, int cx, int cy, uint32_t flags)',
);

const SWP_NOSIZE = 0x1;
const SWP_NOMOVE = 0x2;
const SWP_NOACTIVATE = 0x10;
const RAISE_FLAGS = SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE;

/**
 * mpv renders into a child window of the host HWND, but Chromium's GPU
 * compositor stacks its own "Intermediate D3D Window" child above every sibling,
 * which paints the picture out. Raising mpv's child is cheaper than
 * `--disable-gpu-compositing`: measured over a 3s full-window transform that
 * switch drops 181 frames to 134 (47 of them missing vsync), while this keeps
 * hardware compositing for the UI and only reorders two native surfaces.
 */
export function raiseVideoSurface(hostHwnd: number): boolean {
  const child = findWindowEx(hostHwnd, null, 'mpv', null);
  if (!child) return false;
  return setWindowPos(child, 0, 0, 0, 0, 0, RAISE_FLAGS) === true;
}

/** mpv creates its surface some time after spawn(); retry until it is there. */
export async function raiseVideoSurfaceWhenReady(hostHwnd: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (raiseVideoSurface(hostHwnd)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}
