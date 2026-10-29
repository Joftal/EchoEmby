import koffi from 'koffi';
import { app } from 'electron';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * The desktop's own HDR switch.
 *
 * There is no supported API for it — DXGI reports whether a target is in HDR and refuses to change it,
 * and the Settings app's 使用 HDR toggle goes through the DisplayConfig device-info pair below, which
 * Microsoft has never documented but has kept stable since Windows 10 1803 (the same call the probe
 * script in .probe/hdr-toggle.ps1 was written against on 2026-10-29). Reading and writing are the two
 * packets this needs: GET_ADVANCED_COLOR_INFO (9), SET_ADVANCED_COLOR_STATE (10) and, for the number the
 * panel could otherwise only guess at, GET_SDR_WHITE_LEVEL (11).
 *
 * Everything here is best-effort by design: a machine whose driver refuses the call, a remote session or
 * a display that cannot do HDR all end in `null`/`false` and the player simply behaves as it did before
 * this existed. Nothing in the playback path may fail because the desktop would not switch.
 */

const QDC_ONLY_ACTIVE_PATHS = 0x00000002;
const GET_ADVANCED_COLOR_INFO = 9;
const SET_ADVANCED_COLOR_STATE = 10;
const GET_SDR_WHITE_LEVEL = 11;

/** Windows' own unit for the white level: 1/1000 of 80 nits, so 3000 reads 240 nits. */
const SDR_WHITE_UNIT = 0.08;

/** How long a mode switch takes before the picture is back. Measured on this machine 2026-10-29: mpv
 *  launched before the switch settles opens a swapchain the old mode described, and its log then says
 *  `RGB_FULL_G22_NONE_P709` on a desktop that is already in HDR — the film plays, it is just mapped to
 *  SDR until the next load. mpv re-queries on the next file, so this only has to cover the first one. */
const SETTLE_MS = 1200;

export interface HdrState {
  /** The target can be switched at all: false on a panel or driver without HDR. */
  supported: boolean;
  /** HDR is on right now — by this app or by the user. */
  enabled: boolean;
  /** Bits per channel the swapchain runs at (10 in HDR, 8 in SDR). */
  bits: number;
  /** What SDR white is drawn at while HDR is on, in nits. 0 when the call could not answer. */
  sdrWhiteNits: number;
}

interface Target {
  key: string;
  low: number;
  high: number;
  id: number;
}

interface Api {
  targets: () => Target[];
  read: (t: Target) => HdrState;
  write: (t: Target, on: boolean) => boolean;
}

let cached: Api | null | undefined;

/** Where a viewing that died mid-film leaves the fact that it turned the desktop on. */
function claimPath(): string {
  return path.join(app.getPath('userData'), 'hdr-claim.json');
}

function dropClaim(): void {
  try {
    rmSync(claimPath(), { force: true });
  } catch {
    // The next launch asks neither question if the file is gone; a file that will not go only costs one
    // extra write of the state the display is already in.
  }
}

function api(): Api | null {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    const user32 = koffi.load('user32.dll');
    const sizes = user32.func('int32_t GetDisplayConfigBufferSizes(uint32_t flags, void *numPath, void *numMode)');
    const query = user32.func('int32_t QueryDisplayConfig(uint32_t flags, void *numPath, void *paths, void *numMode, void *modes, void *topologyId)');
    const getInfo = user32.func('int32_t DisplayConfigGetDeviceInfo(void *packet)');
    const setInfo = user32.func('int32_t DisplayConfigSetDeviceInfo(const void *packet)');

    /* The layouts are winuser.h's, transcribed: LUID is two 32-bit halves, a path is a 20-byte source and
       a 48-byte target, and a device-info packet is a 20-byte header plus that call's own body. The mode
       buffer is never read — pcmp only needs it to be big enough — so it stays a byte blob. */
    const Luid = koffi.struct('ECHOEMBY_LUID', { LowPart: 'uint32', HighPart: 'int32' });
    const Rational = koffi.struct('ECHOEMBY_RATIONAL', { Numerator: 'uint32', Denominator: 'uint32' });
    const SourceInfo = koffi.struct('ECHOEMBY_PATH_SOURCE_INFO', {
      adapterId: Luid,
      id: 'uint32',
      modeInfoIdx: 'uint32',
      statusFlags: 'uint32',
    });
    const TargetInfo = koffi.struct('ECHOEMBY_PATH_TARGET_INFO', {
      adapterId: Luid,
      id: 'uint32',
      modeInfoIdx: 'uint32',
      outputTechnology: 'uint32',
      rotation: 'uint32',
      scaling: 'uint32',
      refreshRate: Rational,
      scanLineOrdering: 'uint32',
      targetAvailable: 'int32',
      statusFlags: 'uint32',
    });
    const PathInfo = koffi.struct('ECHOEMBY_PATH_INFO', {
      sourceInfo: SourceInfo,
      targetInfo: TargetInfo,
      flags: 'uint32',
    });
    /* A struct this build lays out differently from the header would have every id point at the wrong
       display, so the size is checked rather than assumed; anything else leaves the feature off. */
    if (koffi.sizeof(PathInfo) !== 72) {
      console.warn('[hdr] 路径结构大小不对，HDR 开关不可用：', koffi.sizeof(PathInfo));
      return null;
    }

    /* `advancedColorEnabled` is supposed to answer this on its own, and on the machine this was written
       against (RTX 4080, Windows 11, 2026-10-29) it does not: it reads 1 in both modes, because Windows 11's
       auto colour management keeps the desktop in an advanced-colour pipeline even while it is in SDR. What
       does flip with the switch, measured across four toggles, is the pair below — the same reading in SDR
       (value 0x7, white 80 nits) and in HDR (value 0x3, white 240 nits) every time, on both the way up and
       the way down. So a display is taken to be in HDR when the bit the docs call "enabled" is set and it is
       not one of the ones that also enforces wide colour at a white level SDR would use. A driver that
       reports the documented bit correctly is still read correctly by this: enabled 0 means SDR. */
    const isOn = (value: number, whiteRaw: number): boolean => (value & 2) !== 0 && !((value & 4) !== 0 && whiteRaw <= 1000);

    const packet = (type: number, size: number, t: Target): Buffer => {
      const b = Buffer.alloc(size);
      b.writeUInt32LE(type, 0);
      b.writeUInt32LE(size, 4);
      b.writeUInt32LE(t.low, 8);
      b.writeInt32LE(t.high, 12);
      b.writeUInt32LE(t.id, 16);
      return b;
    };

    const targets = (): Target[] => {
      const nPath = Buffer.alloc(4);
      const nMode = Buffer.alloc(4);
      if (sizes(QDC_ONLY_ACTIVE_PATHS, nPath, nMode) !== 0) return [];
      let paths = Math.max(1, nPath.readUInt32LE(0));
      let modes = Math.max(1, nMode.readUInt32LE(0));
      for (let attempt = 0; attempt < 4; attempt++) {
        const pathBuf = Buffer.alloc(paths * koffi.sizeof(PathInfo));
        const modeBuf = Buffer.alloc(modes * 128);
        const inPath = Buffer.alloc(4);
        const inMode = Buffer.alloc(4);
        inPath.writeUInt32LE(paths, 0);
        inMode.writeUInt32LE(modes, 0);
        const rc = query(QDC_ONLY_ACTIVE_PATHS, inPath, pathBuf, inMode, modeBuf, null);
        // ERROR_INSUFFICIENT_BUFFER: the topology grew between the two calls, so ask again.
        if (rc === 122) {
          paths = Math.max(paths + 2, inPath.readUInt32LE(0));
          modes = Math.max(modes + 2, inMode.readUInt32LE(0));
          continue;
        }
        if (rc !== 0) return [];
        const list = koffi.decode(pathBuf, PathInfo, Math.min(inPath.readUInt32LE(0), paths)) as any[];
        return list
          .filter(p => p.targetInfo.targetAvailable)
          .map(p => ({
            key: `${p.targetInfo.adapterId.HighPart}:${p.targetInfo.adapterId.LowPart}:${p.targetInfo.id}`,
            low: p.targetInfo.adapterId.LowPart,
            high: p.targetInfo.adapterId.HighPart,
            id: p.targetInfo.id,
          }));
      }
      return [];
    };

    const read = (t: Target): HdrState => {
      const aci = packet(GET_ADVANCED_COLOR_INFO, 32, t);
      if (getInfo(aci) !== 0) throw new Error('GET_ADVANCED_COLOR_INFO 失败');
      // A bitfield: bit 0 supported, bit 1 enabled, bit 2 wide colour enforced, bit 3 force-disabled.
      const value = aci.readUInt32LE(20);
      const bits = aci.readUInt32LE(28);
      const white = packet(GET_SDR_WHITE_LEVEL, 24, t);
      const whiteOk = getInfo(white) === 0;
      const whiteRaw = whiteOk ? white.readUInt32LE(20) : 0;
      return {
        supported: (value & 1) !== 0,
        enabled: isOn(value, whiteRaw),
        bits,
        sdrWhiteNits: whiteOk ? Math.round(whiteRaw * SDR_WHITE_UNIT) : 0,
      };
    };

    const write = (t: Target, on: boolean): boolean => {
      const b = packet(SET_ADVANCED_COLOR_STATE, 24, t);
      // DISPLAYCONFIG_SET_ADVANCED_COLOR_STATE: bit 0 is the whole body.
      b.writeUInt32LE(on ? 1 : 0, 20);
      return setInfo(b) === 0;
    };

    cached = { targets, read, write };
    return cached;
  } catch (e) {
    console.warn('[hdr] Windows 的 HDR 接口不可用：', (e as Error).message);
    return null;
  }
}

/**
 * One viewing's claim on the desktop's HDR switch.
 *
 * It only ever undoes what it did: a machine already running in HDR (a viewer who leaves it on) keeps
 * that, and a display that cannot switch is left alone. `on()` is asked before mpv is launched, because
 * a process started into an SDR swapchain stays mapped to SDR until the next file is opened.
 */
export class WindowsHdr {
  /** The targets this instance turned on, so `restore` can turn exactly those back off. */
  private flipped: Target[] = [];

  /** The primary target's reading, for the log and for anything that wants to describe the screen. */
  state(): HdrState | null {
    const a = api();
    const t = a?.targets()[0];
    if (!a || !t) return null;
    try {
      return a.read(t);
    } catch {
      return null;
    }
  }

  /** True while this instance holds a switch it made itself. */
  get holding(): boolean {
    return this.flipped.length > 0;
  }

  /**
   * Put the desktop in HDR, and wait for the mode change to settle so the next mpv process opens the
   * swapchain the new mode describes. Returns true when it actually flipped something — false when HDR
   * was already on, the screen cannot do it, or the call was refused.
   */
  /** The file that says a viewing of ours turned the desktop on and never turned it back. Written after the
   *  write lands rather than before, so a claim only ever describes a switch this app made. */
  private claim(keys: string[]): void {
    try {
      writeFileSync(claimPath(), JSON.stringify(keys));
    } catch {
      // A desktop that cannot be remembered is still a desktop that can be switched; the file is only the
      // other half of a restore that already happens on every clean exit.
    }
  }

  async on(): Promise<boolean> {
    const a = api();
    if (!a) return false;
    let changed = false;
    for (const t of a.targets()) {
      let st: HdrState;
      try {
        st = a.read(t);
      } catch {
        continue;
      }
      if (!st.supported || st.enabled) continue;
      if (!a.write(t, true)) continue;
      if (!this.flipped.some(f => f.key === t.key)) this.flipped.push(t);
      changed = true;
    }
    if (!changed) return false;
    // The switch outlives this process if it crashes, so the claim has to be on disk before the picture is.
    this.claim(this.flipped.map(f => f.key));
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
    return true;
  }

  /** Undo this instance's switches. Anyone else's stay exactly as they were. */
  restore(): void {
    if (!this.flipped.length) {
      dropClaim();
      return;
    }
    const a = api();
    const flipped = this.flipped;
    this.flipped = [];
    if (!a) return;
    for (const t of flipped) {
      // Written unconditionally rather than only when the reading says HDR is on: this is undoing a switch
      // this instance made, so the other state is the one to go back to, and a display already in SDR simply
      // ignores it. Asking first would let a driver that reports the state wrongly keep a film's HDR on.
      a.write(t, false);
    }
    dropClaim();
  }
}

/**
 * The previous run died while it held the switch — a hard kill, a crash, a power cut — so nothing undid what
 * it did. Called once at launch, before any window exists: the claim names the targets it turned on, and a
 * target that still reads HDR goes back to SDR and the file is dropped. A viewer who switched HDR on by hand
 * after such a crash loses it to this, which is the price of the guarantee 「看完还原」 makes for the ordinary
 * case that it is this app that turned it on.
 */
export function reclaimAbandonedHdr(): void {
  let keys: string[] = [];
  try {
    keys = JSON.parse(readFileSync(claimPath(), 'utf8')) as string[];
  } catch {
    return;
  }
  dropClaim();
  const a = api();
  if (!a || !Array.isArray(keys)) return;
  for (const t of a.targets()) {
    if (!keys.includes(t.key)) continue;
    try {
      if (!a.read(t).enabled) continue;
    } catch {
      continue;
    }
    a.write(t, false);
    console.log('[hdr] 上次退出时没还原，已把显示切回 SDR');
  }
}
