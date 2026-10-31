import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BaseWindow } from 'electron';
import { cachePath } from '../cache/root';
import { MpvPipe } from './mpv-pipe';
import { mpvExecutable } from './kernel';
import type { PlayerThumb } from '../../shared/types';

/** Cells a full file is worth. The bar shows the frame *at* the pointer, so the grid is cut as fine as the
 *  budget allows: 300 cells is one every 5 s on a 24 min episode (the floor) and one every 35 s on a two
 *  hour fifty minute film. The step is grown until the grid fits this many cells, because a grid that
 *  cannot be finished is a grid that shows the playhead's neighbourhood and nothing else: measured
 *  2026-10-29 on a 171 min film, a step capped at 20 s asked for 515 cells, over half of which never
 *  arrived. */
const MAX_CELLS = 300;

/** Below 5 s a bar 1240 px wide has more cells than it has pixels worth of pointer positions. */
const MIN_STEP_MS = 5_000;

/** The sweep starts once the film has been up a while: the first seconds of a viewing belong to the
 *  playback's own buffering, and a preview nobody has asked for yet must not compete with it. A pointer
 *  arriving earlier than this starts the worker at once instead (see `wake`). */
const START_DELAY_MS = 12_000;

/** Picture width. The tip is ~160 CSS px wide, so 320 covers a 2x display without a second fetch. */
const WIDTH = 320;

/** How long one cell may spend waiting for a fresh picture before the frame on screen is taken as the
 *  answer. Measured seeks through the app's own bridge: 0.04 s when the cell is near the cached part of the
 *  file, 3-7 s when the demuxer has to fetch from the far side of a 1.4 GB episode. */
const FRAME_TIMEOUT_MS = 12_000;

/** A cell that could not be decoded is retried this many times before the sweep lets it go. */
const CELL_TRIES = 3;

/** Cells in a row that come back without a fresh picture before the worker is treated as stuck. A single
 *  miss is a far seek that took longer than FRAME_TIMEOUT_MS; three in a row is mpv sitting in
 *  `seeking: true` forever (measured 2026-10-29: the same frame was handed back for 48 cells, and the
 *  process never rendered again). */
const STALL_LIMIT = 3;

/** How many cells away a stand-in picture may come from. 3 cells is 15 s on a dense episode and 105 s on a
 *  long film: close enough to be that part of the story. */
const NEAR_CELLS = 3;

/** A picture a pointer asked for is rendered and kept at this resolution. One second is finer than a bar
 *  1240 px wide can ask for (0.4 px on a 45 min episode, 0.7 px on a two hour film), and keeps the map
 *  small enough to hold a minute of them. The grid stays coarse: it is the stand-in, not the answer. */
const DEMAND_STEP = 1_000;

/** How many pointed-at seconds are kept per viewing. Ninety is a minute and a half of the bar, which is
 *  more than a hand sweeps over, and 90 x 12 KB is nothing next to the grid already in memory. */
const DEMAND_KEEP = 90;

/** How far a stand-in picture may be from the second that was asked for, when a second is already
 *  rendered. Three seconds is the same moment of the film, not the neighbouring scene. */
const DEMAND_NEAR = 3_000;

/** How long one asked-for second may spend being decoded before the tip keeps the picture it has. Long
 *  enough for a far seek on a remote file (measured 0.05-2 s), short enough that a second the file cannot
 *  produce does not hold the pointer for the twelve a background cell is allowed. */
const DEMAND_TIMEOUT_MS = 8_000;

/** How long a worker that has nothing left to do stays alive. A finished grid leaves an mpv holding the
 *  whole film open: 600 MB of resident memory and a demuxer that reads on ahead of a sweep nobody is
 *  waiting for (measured 2026-10-29: worker RSS 608 MB against the player's 554 MB). Three minutes is
 *  longer than a hand takes to come back to the bar, so pausing to read a message does not cost a restart.
 */
const IDLE_STOP_MS = 180_000;

/** How long a sweep may sit waiting for a film that is short of data before it hands the worker back.
 *  Measured 2026-10-29: a slow link left the player starving for minutes while the worker held 407 MB (one
 *  version peaked at 1 GB) and could not advance a single cell. Twenty seconds is longer than any ordinary
 *  buffer underrun and short enough that the memory comes back while the viewer is still watching. */
const STARVE_STAND_DOWN_MS = 20_000;

/** How many times a stuck worker may be replaced for one file. A fresh mpv costs a couple of seconds and
 *  starts over from the playhead; past this the file simply keeps the cells it has. */
const MAX_RESTARTS = 3;

/** Frames already decoded are kept on disk, so the second viewing of an episode is instant everywhere
 *  instead of instant only where the sweep has got to. 400 MB is roughly eighty episodes at 300 cells. */
const CACHE_BYTES = 400 * 1024 * 1024;
/** How stale a cache sweep has to be before another film may run one. Ten minutes keeps a long session
 *  inside CACHE_BYTES without walking the whole folder on every 下一集. */
const PRUNE_EVERY_MS = 10 * 60_000;

/** One cell's answer. `exact` is false while the cell the pointer is over is still being decoded and the
 *  picture shown belongs to the closest cell that exists — a tip that is never empty, never a blank box. */
export type ThumbAnswer = PlayerThumb;

/** What one file needs to be previewed: its identity on disk, where the playhead is, and when to stand down. */
export interface ThumbOpen {
  /** itemId + MediaSourceId: the same episode in another version is another grid. */
  key: string;
  /** The playhead, so the sweep fills the part of the bar the viewer is watching first. */
  now: () => number;
  /** True while playback is short of data: the sweep stands aside for the film. */
  starving?: () => boolean;
}

const dataUrl = (jpeg: Buffer): string => 'data:image/jpeg;base64,' + jpeg.toString('base64');

/** Where saved grids live, one folder per item+version. */
const cacheRoot = (): string => cachePath('thumbs');
/**
 * Progress-bar preview frames, decoded by a second mpv that nobody watches.
 *
 * Why a process of its own: a frame at an arbitrary time cannot come from the player. The player's mpv
 * renders into a host window handle (--wid) where screenshot-to-file fails outright ("error running
 * command", measured in all four window modes), and even if it worked, seeking that instance to the
 * pointer's position would move the picture the viewer is watching. Bilibili gets this for free because
 * its storyboards are made on the server; Emby has no trickplay at all (measured: eight URL shapes, all
 * 404, no TrickplayInfo in MediaSources, Chapters empty), so the frames have to be decoded here. One extra
 * decoder, no window, 1x1 and off the desktop, is what "here" costs.
 *
 * Why both ahead of time and on demand: a seek inside the file lands in ~50 ms, but the demuxer then needs
 * 1.4-2.7 s of the file before a decoder sees its first frame, and a hand dragged along the bar cannot wait
 * that long per pixel. So the sweep fills a 300 cell grid while the film plays, playhead first, and that
 * grid is what a moving pointer is shown. A pointer that has stopped is asking about one second of the
 * film, not about a cell that may be 35 s away on a long one, so that second is rendered on demand, kept in
 * `shots`, and outranks every cell the sweep had planned. The grid is the stand-in; the demanded second is
 * the answer, and the tip only stops asking when it has it.
 *
 * Why the capture is compared byte for byte: playback-restart is *not* emitted for every seek in this mpv
 * build (measured: seek + a screenshot taken straight after it returns the previous frame, with no event in
 * between), and a paused worker never renders the seek target at all. What is reliable is that a stale
 * capture is the *same JPEG* as the previous cell, so a fresh frame is the first screenshot whose bytes
 * differ from the last accepted one.
 *
 * Why every pass carries a generation number: a 下一集 or a 播放源 switch calls open while the previous
 * file's sweep is still waiting on a seek. That sweep must not write into the new file's map, and it must
 * not clear the busy flag the new sweep has already taken - measured as an episode that never got a single
 * preview because the old sweep was still unwinding when the new one started.
 *
 * Why the grids are kept on disk: the second viewing of an episode should be instant over its whole length,
 * not just where this sweep has reached. One folder per item+version, pruned to CACHE_BYTES.
 *
 * Nothing here may fail a viewing: every step is best-effort, and a worker that dies only means the bar
 * shows the clock without a picture, which is what it showed before this existed.
 */
export class Thumbnails {
  private proc: ChildProcess | null = null;
  private pipe: MpvPipe | null = null;
  /** The window the worker draws into. See start(): the worker never has a window of its own. */
  private host: BaseWindow | null = null;
  private dir = '';
  /** What the worker has open, so a file that mpv dropped can be opened again. */
  private url = '';
  /** Distance between two frames. 0 means nothing is being previewed. */
  private stepMs = 0;
  /** Length of the file in ms, remembered for the grid's own identity on disk. */
  private duration = 0;
  /** Cells in the current file; a pointer past the end asks for the last one. */
  private count = 0;
  /** Folder this file's saved frames live in, under userData/thumbs. */
  private grid = '';
  /** index -> data URL. Never more than MAX_CELLS entries, ~10 KB each. */
  private tiles = new Map<number, string>();
  /** Cells not decoded yet. */
  private pending = new Set<number>();
  /** Cells a pointer asked for, newest first: they outrank the sweep. */
  private demand: number[] = [];
  private demanded = new Set<number>();
  /** Which file the current sweep belongs to. Bumped by open and close. */
  private gen = 0;
  /** The generation of the sweep in charge of the pipe, or null when no sweep is running. A boolean
   *  was wrong: close() had to clear it for the next file, and the sweep it belonged to then cleared it
   *  again on its way out - wiping the *new* sweep's lock, so two loops could seek the same pipe at once
   *  (found 2026-10-29). Tying the lock to the generation makes a stale sweep unable to do that. */
  private pumping: number | null = null;
  /** Cells in a row that came back without a picture, and workers replaced for this file so far. */
  private stalls = 0;
  /** When this sweep started waiting on a starving film, 0 while the film is playing normally. */
  private starveSince = 0;
  /** Set when a sweep gave up on a starving film, so the pump knows to stand the worker down. */
  private drained = false;
  private restarts = 0;
  /** Cells answered since the last replacement, so a long file that hiccups once an hour does not run out
   *  of restarts in its first hour. */
  private good = 0;
  /** The worker is gone for good; only a new open may clear this. */
  private dead = false;
  /** Bytes of the last accepted frame. The next cell must differ from them to count as decoded. */
  private last: Buffer | null = null;
  /** Failed attempts per cell, so a cell that cannot be decoded is retried a few times and then let go. */
  private tries = new Map<number, number>();
  /** Cells that cost a worker its life. A cell whose byte range the server does not have does not just fail:
   *  it freezes the demuxer, and every replacement worker freezes on it again. Measured on a source that is
   *  only half on the server (11.29 GB of 50.19 GB): the sweep spent its whole restart budget failing at the
   *  same offset three times and stopped at cell 75. Retrying one of these is not optimism, it is the same
   *  wait twice. */
  private bad = new Set<number>();
  /** The cell the last failed attempt was for, so a replacement knows which one to blame. */
  private suspect: number | null = null;
  /** Seconds a pointer asked for by name, rendered at DEMAND_STEP, least recently used first. The grid is
   *  5 to 35 s apart, so a pointer over a long film would otherwise be shown the picture of another scene.
   *  These are the answers to "this exact position", and at 12 KB each they cost less than one grid row. */
  private shots = new Map<number, string>();
  /** Seconds that could not be decoded. Asking again buys the same wait, so the tip is told they are final. */
  private badShots = new Set<number>();
  /** The second being rendered for a pointer right now, and the newest one waiting for the worker. A hand
   *  dragged along the bar asks for a dozen seconds a second; only the last one is worth a seek. */
  private asking: number | null = null;
  private queued: number | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  /** Runs when the worker has had nothing to do for IDLE_STOP_MS; see sleep(). */
  private idleTimer: NodeJS.Timeout | null = null;
  /** The worker was stood down on purpose, so its pipe closing is not the worker dying: without this the
   *  socket-close handler below would read a planned exit as a broken one and disable the film's grid. */
  private sleeping = false;
  /** The start() in flight, so a second wake-up inside it does not spawn a second worker. */
  private booting: Promise<void> | null = null;
  /** Whether a pointer has already asked for a picture of this file. The quiet period exists to keep an
   *  unasked-for worker off the film; once the viewer asks, it has been spent. */
  private asked = false;
  /** When the cache was last swept, in epoch ms. Not a boolean: one sweep per process meant a session
   *  that ran all evening never enforced CACHE_BYTES again after its first film (found 2026-10-29). */
  private pruned = 0;
  /** The playhead, so the sweep fills what the viewer is about to look at. */
  private now: () => number = () => 0;
  /** Asked before every cell: true means the film being watched is starving for bytes this second, so a
   *  sweep that reads the same file from the same server must stand aside. */
  private starving: () => boolean = () => false;

  /** Whether a worker is up for the current file. The session asks before starting one for a setting that
   *  was turned on while something was already playing. Not the same as `active`: open() is deliberately
   *  quiet for START_DELAY_MS while the film itself is opening, and a grid that is being loaded from disk
   *  in that window is already this file's grid. */
  get running(): boolean {
    return !!this.proc && !this.dead;
  }

  /** Whether a file's grid is open at all - loaded, loading, or being filled. The session must not open it
   *  again on every pointer move: each open is a generation bump that throws away the frames arriving from
   *  disk, which measured as 284 cells all answering null for the first two seconds of a rewatch. */
  get active(): boolean {
    return this.stepMs > 0;
  }

  /** Begins filling frames for one file. A second call replaces the first: the previous file's frames are
   *  answers about a different film and must not survive a 下一集 or a 播放源 switch. */
  open(url: string, durationMs: number, opts: ThumbOpen): void {
    this.close();
    this.starving = opts.starving ?? (() => false);
    this.now = opts.now;
    if (!url || !(durationMs > 0)) return;
    this.url = url;
    this.duration = Math.round(durationMs);
    // ceil, not round: rounding up the step is what keeps the count at or under MAX_CELLS. Rounding it
    // down gave a 171 min film 515 cells for a budget of 300.
    this.stepMs = Math.max(MIN_STEP_MS, Math.ceil(this.duration / MAX_CELLS / 1000) * 1000);
    this.count = Math.max(1, Math.ceil(this.duration / this.stepMs));
    this.grid = path.join(cacheRoot(), createHash('sha1').update(opts.key).digest('hex').slice(0, 16));
    for (let i = 0; i < this.count; i++) this.pending.add(i);
    this.dir = path.join(tmpdir(), 'echoemby-thumbs-' + randomUUID().slice(0, 8));
    this.dead = false;
    this.asked = false;
    this.stalls = 0;
    this.restarts = 0;
    this.good = 0;
    this.bad.clear();
    this.suspect = null;
    this.shots.clear();
    this.badShots.clear();
    this.asking = null;
    this.queued = null;
    const gen = this.gen;
    void this.prune();
    void this.load(gen);
  }

  /** The frame at ms. `precise` asks for the second the pointer is on itself; without it the answer comes
   *  from the grid, which is the cheap way to keep a picture under a moving hand. Either way a picture that
   *  exists is returned rather than an empty box: while the asked-for second is being decoded the nearest
   *  one already rendered stands in. Asking is also what puts a frame at the head of the queue. */
  at(ms: number, precise = true): ThumbAnswer {
    if (!this.stepMs) return { url: null, exact: false };
    // A pointer arriving during the quiet period is the one case where the sweep may not wait: the viewer
    // asked for a picture, so the 12 s of buffering the delay protects is already spent.
    this.asked = true;
    this.wake();
    // Nothing left to sweep, so the worker stood down minutes ago and this question is what brings it back.
    // The question is answered from the grid or from `shots` while the fresh process opens the file.
    // Standing a starving film's worker down only helps if the next hover does not immediately start
    // another one into the same stall: while the film is short of data the ask waits for the bar to move.
    if (!this.proc && !this.dead && !this.startTimer && !this.starving()) this.resume();
    const bucket = Math.round(ms / DEMAND_STEP) * DEMAND_STEP;
    const shot = this.shots.get(bucket);
    if (shot) {
      // Touched, so the second nobody has looked at for longest is the one dropped when the map fills.
      this.shots.delete(bucket);
      this.shots.set(bucket, shot);
      return { url: shot, exact: true };
    }
    const index = Math.max(0, Math.min(this.count - 1, Math.floor(ms / this.stepMs)));
    if (precise) {
      // A second the worker has already failed on is not asked again - but the answer says so, or the tip
      // would keep asking for a picture that is never coming.
      if (this.badShots.has(bucket)) return { url: this.around(bucket, index), exact: false, final: true };
      this.wantShot(bucket);
    } else if (!this.tiles.has(index)) {
      this.want(index);
    }
    return { url: this.around(bucket, index), exact: false };
  }

  /** Deletes every saved grid. Runs when 清理全部缓存 is pressed, so one button still means "no cache". */
  async clearCache(): Promise<void> {
    await rm(cacheRoot(), { recursive: true, force: true }).catch(() => undefined);
  }

  close(): void {
    this.gen++;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    this.disarmIdle();
    this.stop(true);
    this.tiles.clear();
    this.pending.clear();
    this.demand = [];
    this.demanded.clear();
    this.tries.clear();
    this.bad.clear();
    this.suspect = null;
    this.shots.clear();
    this.badShots.clear();
    this.asking = null;
    this.queued = null;
    this.url = '';
    this.stepMs = 0;
    this.count = 0;
    this.duration = 0;
    this.grid = '';
    this.last = null;
    this.now = () => 0;
    this.starving = () => false;
    this.stalls = 0;
    this.restarts = 0;
    this.good = 0;
    this.starveSince = 0;
    this.drained = false;
    // The sweep that just ended may still be inside a seek; it only clears a lock of its own generation,
    // so it cannot wipe the one a new file's sweep takes in the meantime.
    this.pumping = null;
  }

  /** Starts the worker now instead of at the end of the quiet period. */
  private wake(): void {
    if (!this.startTimer) return;
    clearTimeout(this.startTimer);
    this.startTimer = null;
    void this.start(this.url, this.gen);
  }

  private want(index: number): void {
    this.disarmIdle();
    // A cell that froze a worker is not asked for again: hovering it would buy another 12 s stall and
    // another restart for a picture the server cannot produce. The neighbouring cells still answer.
    if (this.dead || this.bad.has(index) || this.tiles.has(index) || this.demanded.has(index)) return;
    this.demanded.add(index);
    this.demand.unshift(index);
    void this.pump();
  }

  /** Asks for one second of the film. The newest ask wins: a hand moving along the bar asks for a dozen
   *  seconds a second, and rendering the ones it has already passed spends the decoder on pictures nobody
   *  will look at. */
  private wantShot(bucket: number): void {
    this.disarmIdle();
    if (this.dead || this.shots.has(bucket) || this.badShots.has(bucket)) return;
    if (this.asking === bucket || this.queued === bucket) return;
    this.queued = bucket;
    void this.pump();
  }

  /** Keeps one asked-for second, dropping the least recently looked at when the map is full. */
  private keepShot(bucket: number, url: string): void {
    this.shots.set(bucket, url);
    while (this.shots.size > DEMAND_KEEP) {
      const oldest = this.shots.keys().next().value;
      if (oldest === undefined) break;
      this.shots.delete(oldest);
    }
  }

  /** The closest picture that exists to a position: a second already rendered for the bar beats the grid,
   *  the grid beats a neighbouring cell, and a neighbour past NEAR_CELLS beats nothing at all. */
  private around(bucket: number, index: number): string | null {
    let best: string | null = null;
    let bestGap = Infinity;
    for (const [b, url] of this.shots) {
      const gap = Math.abs(b - bucket);
      if (gap < bestGap) {
        bestGap = gap;
        best = url;
      }
    }
    if (best && bestGap <= DEMAND_NEAR) return best;
    return this.tiles.get(index) ?? this.nearest(index);
  }

  /** Frames kept from an earlier viewing, then the worker. The sweep is held back until the saved grid is
   *  in memory: a cell that exists on disk must never be decoded twice. */
  private async load(gen: number): Promise<void> {
    await this.hydrate(gen);
    if (gen !== this.gen || this.dead || !this.url) return;
    if (this.asked) {
      // The pointer got here while the saved grid was still being read; it is asking now.
      void this.start(this.url, this.gen);
      return;
    }
    // A grid that came back from disk complete has nothing to decode, and a rewatch of an episode someone
    // has already seen is the common case: no worker at all until a pointer stops on the bar. That is not a
    // delay - at() starts one for the second it was asked about.
    if (!this.pending.size) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      void this.start(this.url, this.gen);
    }, START_DELAY_MS);
  }

  /** The saved grid, if it was made for this same file at this same density. Anything else is thrown away:
   *  a grid cut for another duration would answer with frames of the wrong moment. */
  private async hydrate(gen: number): Promise<void> {
    const metaFile = path.join(this.grid, 'meta.json');
    const meta = await readFile(metaFile, 'utf8')
      .then(s => JSON.parse(s) as { v?: number; durationMs?: number; stepMs?: number })
      .catch(() => null);
    // v2: grids written before 2026-10-29 may hold the same frame under many indices (the worker froze and
    // every later cell was handed the picture already on screen), so they are not evidence of anything.
    if (!meta || meta.v !== 2 || meta.durationMs !== this.duration || meta.stepMs !== this.stepMs) {
      await rm(this.grid, { recursive: true, force: true }).catch(() => undefined);
      await mkdir(this.grid, { recursive: true }).catch(() => undefined);
      await writeFile(metaFile, JSON.stringify({ v: 2, durationMs: this.duration, stepMs: this.stepMs }), 'utf8').catch(() => undefined);
      return;
    }
    const files = await readdir(this.grid).catch(() => [] as string[]);
    for (const name of files) {
      if (/^\d+\.jpg$/.test(name) === false) continue;
      const index = Number(name.slice(0, -4));
      if (!(index >= 0 && index < this.count)) continue;
      const buf = await readFile(path.join(this.grid, name)).catch(() => null);
      if (!buf || !buf.length) continue;
      this.tiles.set(index, dataUrl(buf));
      this.pending.delete(index);
      if (gen !== this.gen) return;
    }
  }

  private async save(index: number, jpeg: Buffer): Promise<void> {
    await mkdir(this.grid, { recursive: true }).catch(() => undefined);
    await writeFile(path.join(this.grid, String(index).padStart(4, '0') + '.jpg'), jpeg).catch(() => undefined);
  }

  /** Keeps the saved grids inside CACHE_BYTES by dropping whole files, least recently watched first. Runs
   *  once per process: a 400 MB sweep of the disk on every 下一集 would be worse than the disk it saves. */
  private async prune(): Promise<void> {
    if (Date.now() - this.pruned < PRUNE_EVERY_MS) return;
    this.pruned = Date.now();
    const root = cacheRoot();
    const names = await readdir(root).catch(() => [] as string[]);
    if (!names.length) return;
    const entries: { dir: string; bytes: number; at: number }[] = [];
    for (const name of names) {
      const dir = path.join(root, name);
      const files = await readdir(dir).catch(() => [] as string[]);
      let bytes = 0;
      for (const f of files) bytes += (await stat(path.join(dir, f)).catch(() => null))?.size || 0;
      entries.push({ dir, bytes, at: (await stat(dir).catch(() => null))?.mtimeMs || 0 });
    }
    let total = entries.reduce((n, e) => n + e.bytes, 0);
    if (total <= CACHE_BYTES) return;
    entries.sort((a, b) => a.at - b.at);
    for (const e of entries) {
      if (total <= Math.floor(CACHE_BYTES * 0.6)) break;
      if (e.dir === this.grid) continue;
      await rm(e.dir, { recursive: true, force: true }).catch(() => undefined);
      total -= e.bytes;
    }
  }

  /** The cell to decode next: what a pointer asked for, else the nearest cell to the playhead, preferring
   *  what is ahead - that is the part of the bar the viewer is about to hover. */
  private nextIndex(): number | null {
    if (this.demand.length) return this.demand.shift()!;
    if (!this.pending.size) return null;
    const here = Math.max(0, Math.min(this.count - 1, Math.floor(this.now() / this.stepMs)));
    let best = -1;
    let bestCost = Infinity;
    for (const i of this.pending) {
      const cost = i >= here ? i - here : (here - i) * 1.6;
      if (cost < bestCost) {
        bestCost = cost;
        best = i;
      }
    }
    return best < 0 ? null : best;
  }

  /** The closest frame that exists, for a cell that does not - but only if it is close enough to be about
   *  the same moment. Reaching further means the pointer over the last third of a film is shown a picture
   *  of the first, labelled with the time under the pointer: no picture is honest, that is not. */
  private nearest(index: number): string | null {
    let best: string | null = null;
    let bestGap = Infinity;
    for (const [i, url] of this.tiles) {
      const gap = Math.abs(i - index);
      if (gap < bestGap) {
        bestGap = gap;
        best = url;
      }
    }
    return bestGap <= NEAR_CELLS ? best : null;
  }

  /** One start at a time. A stopped pointer can ask twice inside the few milliseconds start spends
   *  between choosing its folder and spawning mpv, and two answers to one wake-up would be two workers on
   *  one file. */
  private async start(url: string, gen: number): Promise<void> {
    if (this.booting) return;
    this.booting = this.boot(url, gen);
    try {
      await this.booting;
    } finally {
      this.booting = null;
    }
  }

  private async boot(url: string, gen: number): Promise<void> {
    const dir = this.dir;
    try {
      await mkdir(dir, { recursive: true });
    } catch {
      if (gen === this.gen) this.dead = true;
      return;
    }
    if (gen !== this.gen) return;
    const pipeName = 'echoemby-thumb-' + randomUUID().slice(0, 8);
    // The worker draws into a window of this app's, never one of its own. mpv's own window lands in the
    // taskbar even with --show-in-taskbar=no (measured 2026-10-29: the flag is accepted, the button stays),
    // and Windows' minimum window size turned the old "1x1 in the corner" into a 136x39 strip of moving
    // video over the desktop - which the viewer could see. A BaseWindow is a native window with no
    // renderer and never shown: nothing to see, nothing in the taskbar, and mpv renders into it through
    // --wid (verified: frames captured from a hidden host are the real frames of the seeked second).
    const host = this.openHost();
    let proc: ChildProcess;
    try {
      const exe = mpvExecutable();
      proc = spawn(exe, this.args(pipeName, host ? this.hwnd(host) : 0), { cwd: path.dirname(exe), windowsHide: true });
    } catch {
      this.closeHost();
      if (gen === this.gen) this.dead = true;
      return;
    }
    if (gen !== this.gen) {
      proc.kill();
      this.closeHost();
      return;
    }
    this.proc = proc;
    this.sleeping = false;
    this.disarmIdle();
    proc.on('exit', () => {
      if (gen === this.gen && !this.sleeping) this.die();
    });
    proc.stderr?.resume();
    const pipe = new MpvPipe();
    this.pipe = pipe;
    pipe.onSocketClose = () => {
      if (gen === this.gen && !this.sleeping) this.die();
    };
    try {
      await pipe.connect(pipeName, 10_000);
    } catch {
      if (gen === this.gen) this.die();
      return;
    }
    if (gen !== this.gen) {
      this.stopLocal(proc, pipe);
      return;
    }
    await pipe.call(['loadfile', url, 'replace'], 10_000).catch(() => undefined);
    // A cold open of a remote mkv is 4-18 s here, so the first tile waits for the file rather than for a
    // restart event: seekable going true is what "there is a picture to seek in" means.
    if (!(await this.ready(pipe, 40_000, gen))) return;
    if (gen !== this.gen) return;
    // The frame at 0 is the baseline, not a tile: every cell's capture has to differ from it.
    this.last = await this.shot(pipe);
    void this.pump();
  }

  /** The window the worker renders into: never shown, no renderer, no taskbar button. Created through the
   *  app rather than by mpv, because a window of mpv's own is a window the viewer can find (see start). */
  private openHost(): BaseWindow | null {
    try {
      const host = new BaseWindow({
        show: false,
        frame: false,
        width: WIDTH,
        height: Math.round((WIDTH * 9) / 16),
        skipTaskbar: true,
        focusable: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        hasShadow: false,
        backgroundColor: '#000000',
      });
      this.host = host;
      return host;
    } catch {
      // No host window is not a reason to lose the grid: mpv gets one of its own off the desktop instead.
      return null;
    }
  }

  private closeHost(): void {
    const host = this.host;
    this.host = null;
    if (!host) return;
    try {
      if (!host.isDestroyed()) host.destroy();
    } catch {
      /* The window is already gone, or the app is closing. Nothing here may fail a viewing. */
    }
  }

  private hwnd(host: BaseWindow): number {
    const raw = host.getNativeWindowHandle();
    return raw.length >= 8 ? Number(raw.readBigUInt64LE(0)) : raw.readUInt32LE(0);
  }

  private args(pipeName: string, wid: number): string[] {
    return [
      '--no-config',
      '--terminal=no',
      '--msg-level=all=error',
      '--idle=yes',
      // Keep the last frame at the end of the file instead of unloading it: an unloaded worker answers
      // every seek with an error and would silently stop filling cells.
      '--keep-open=yes',
      '--no-osc',
      '--no-osd-bar',
      '--no-ytdl',
      '--no-border',
      '--input-ipc-server=' + pipeName,
      // A window is not optional: a minimised one never renders, so its screenshots are the *old* frame
      // (measured). The normal path draws into the app's host window and creates none; the fallback gets a
      // window of its own, parked past the edge of every monitor - such a worker captured frames
      // pixel-identical to one at 1260,700 (measured 2026-10-29) - but it also owns a taskbar button, which
      // is exactly the seam this is here to avoid.
      '--vo=gpu',
      wid ? '--wid=' + wid : '--force-window=yes',
      ...(wid ? [] : ['--geometry=1x1+20000+20000']),
      // --focus-on-open was removed from mpv; the spelling is --focus-on and "no" is rejected.
      '--focus-on=never',
      // Scaling here, not in the capture, is what makes the JPEG 320 px wide.
      '--vf=scale=' + WIDTH + ':-2',
      '--screenshot-format=jpg',
      '--screenshot-jpeg-quality=78',
      // Hardware frames skip the filter chain on the screenshot path: with --hwdec=auto the capture came
      // back 1920x1080 / 172 KB while the same seek with --hwdec=no gave 320x180 / 8 KB (measured
      // 2026-10-28, both with --vf=scale=320:-2 listed as an active filter).
      '--hwdec=no',
      '--ao=null',
      '--aid=no',
      '--sid=no',
      // Read ahead only as far as one frame needs, plus a little. Measured 2026-10-29 against the same file
      // and the same bridge, six far seeks: 8 s / 24 MiB answered in 61, 231, 45, 1392, 3986, 5707 ms,
      // while 30 s / 96 MiB answered in 44, 195, 14099, 6011, 12588, 18815 ms - a worker that buffers a
      // 30 s run before it will show a frame is a worker that looks frozen. The back buffer stays large so a
      // pointer that drifts backwards over cells already decoded costs nothing.
      '--demuxer-readahead-secs=8',
      '--demuxer-max-bytes=24MiB',
      '--demuxer-max-back-bytes=16MiB',
      '--hr-seek=yes',
      '--force-seekable=yes',
      '--network-timeout=20',
    ];
  }

  /** Whether mpv has a file open *and seekable* right now. idle-active alone is not enough: it goes false
   *  the moment loadfile is accepted, while the demuxer is still opening the file, and a seek issued in
   *  that window is rejected at once (measured: 29 cells in a row failed in 1 ms each, then the same seeks
   *  worked). seekable is what an absolute seek actually needs. */
  private async ready(pipe: MpvPipe, timeoutMs: number, gen: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idle = await pipe.call<boolean>(['get_property', 'idle-active'], 3_000).catch(() => true);
      if (idle === false) {
        const seekable = await pipe.call<boolean>(['get_property', 'seekable'], 3_000).catch(() => false);
        if (seekable === true) return true;
      }
      if (this.dead || gen !== this.gen || Date.now() > deadline) return false;
      await new Promise(r => setTimeout(r, 300));
    }
  }

  /** mpv can drop back to idle after a read error; the file has to be opened again before seeking works. */
  private async reopen(pipe: MpvPipe, gen: number): Promise<boolean> {
    if (!this.url || this.dead || gen !== this.gen) return false;
    await pipe.call(['loadfile', this.url, 'replace'], 10_000).catch(() => undefined);
    if (!(await this.ready(pipe, 12_000, gen))) return false;
    this.last = await this.shot(pipe);
    return true;
  }

  /** Fills the grid with one worker, replacing it if it stops answering. The loop lives out here, not as a
   *  retry inside the sweep, because a replacement is a different process with a different pipe: continuing
   *  in the same loop would keep calling into the dead one. */
  private async pump(): Promise<void> {
    const gen = this.gen;
    if (this.pumping === gen) return;
    this.pumping = gen;
    try {
      for (;;) {
        const stalled = await this.fill();
        if (!stalled) break;
        if (!(await this.revive())) return;
      }
    } finally {
      if (this.pumping === gen) this.pumping = null;
    }
    // A sweep that gave up on a starving film stands its worker down on the way out: the memory goes back
    // now rather than after IDLE_STOP_MS, and the next hover starts a fresh process through resume().
    if (this.drained) {
      this.drained = false;
      this.sleep(true);
    }
  }

  /** One worker's worth of filling. Returns true when that worker has to be replaced: not one bad cell, but
   *  a run of them - an mpv stuck in seeking answers every seek with success and never renders again. */
  private async fill(): Promise<boolean> {
    const pipe = this.pipe;
    const gen = this.gen;
    if (this.dead || !pipe) return false;
    for (;;) {
      if (this.dead || gen !== this.gen) return false;
      // A saved grid that is already complete has nothing left to sweep, but it still has to answer a
      // pointer that stops on it: the demanded second is work of its own, not a cell the queue happens to
      // hold. Leaving it out of this test is what made a completed grid answer every hover with the
      // neighbouring cell and never with the second under the pointer (measured 2026-10-29).
      if (!this.pending.size && !this.demand.length && this.queued === null) {
        this.armIdle();
        return false;
      }
      // A preview made while the film itself is buffering is a preview that made the film stutter. The
      // demand path is included: a pointer that arrives during a stall waits with the picture.
      while (!this.dead && gen === this.gen && this.starving()) {
        // Waiting is the right answer for a short stall; waiting forever is not. A film that has not
        // recovered in STARVE_STAND_DOWN_MS is one this sweep cannot help, and holding 400 MB-1 GB of
        // decoder against it only takes memory from the player that is itself struggling for bandwidth.
        if (!this.starveSince) this.starveSince = Date.now();
        // Held-back demand does not buy an exception: while the film is starving, no seek this worker makes
        // can land either, so an ask that arrives now is dropped and re-asked by the next pointer event.
        if (Date.now() - this.starveSince >= STARVE_STAND_DOWN_MS) {
          this.starveSince = 0;
          this.queued = null;
          this.drained = true;
          return false;
        }
        await new Promise(r => setTimeout(r, 1_000));
      }
      this.starveSince = 0;
      if (gen !== this.gen || this.dead) return false;
      // A worker that lost its file is worth one replacement: reopening it in place is what an idle mpv
      // after a read error needs, and a worker that cannot even hold a file open is the other kind of stuck.
      if (!(await this.ready(pipe, 0, gen))) {
        if (!(await this.reopen(pipe, gen))) return true;
      }
      if (gen !== this.gen) return false;
      // A picture a pointer asked for outranks every cell the sweep had planned: the viewer is looking at
      // one second of the film, the sweep is filling parts nobody has looked at yet.
      if (this.queued !== null) {
        const bucket = this.queued;
        this.queued = null;
        this.asking = bucket;
        const jpeg = await this.frame(pipe, bucket, gen, DEMAND_TIMEOUT_MS, true);
        this.asking = null;
        if (gen !== this.gen) return false;
        // The pointer moved while this second was being decoded; it is not a broken second, just a stale
        // question, so it is neither cached nor held against the worker.
        if (jpeg === 'abort') continue;
        // Seven seconds of a frozen worker buys nothing; three stalls of ordinary slowness do. A worker that
        // cannot answer a property read is replaced now.
        if (jpeg === 'dead') {
          this.badShots.add(bucket);
          return true;
        }
        if (jpeg) {
          this.stalls = 0;
          this.keepShot(bucket, dataUrl(jpeg));
          continue;
        }
        // A second has no slot in `tries`, and a sweep that is already finished would never notice a worker
        // that stopped answering at all, so a failed ask counts as a stall of its own.
        this.badShots.add(bucket);
        this.stalls++;
        if (this.stalls >= STALL_LIMIT) {
          this.stalls = 0;
          return true;
        }
        continue;
      }
      const index = this.nextIndex();
      if (index === null) {
        this.armIdle();
        return false;
      }
      this.pending.delete(index);
      this.demanded.delete(index);
      // The middle of the cell, so one picture is the closest answer to every time inside it.
      const jpeg = await this.frame(pipe, Math.round(index * this.stepMs + this.stepMs / 2), gen);
      if (gen !== this.gen) return false;
      // Outranked by a pointer that asked for its own second: the cell goes back to the queue untried, so
      // the sweep resumes exactly where it stood once the pointer has been answered.
      if (jpeg === 'abort') {
        this.pending.add(index);
        continue;
      }
      if (jpeg === 'dead') {
        // This cell is what the worker died on: handing it back to the next one is how the same offset
        // takes three workers down in a row.
        this.suspect = index;
        this.pending.add(index);
        return true;
      }
      if (jpeg) {
        this.stalls = 0;
        this.tiles.set(index, dataUrl(jpeg));
        void this.save(index, jpeg);
        // Twenty answers in a row is a worker that is working: the replacements it took to get here are
        // history, not budget.
        if (++this.good >= 20) {
          this.good = 0;
          this.restarts = 0;
        }
        continue;
      }
      // A cell that failed is not a cell that is answered: put it back, but only a few times, or a file
      // mpv cannot seek in would keep the queue busy forever.
      const tries = (this.tries.get(index) ?? 0) + 1;
      this.tries.set(index, tries);
      this.suspect = index;
      if (tries < CELL_TRIES && !this.bad.has(index)) this.pending.add(index);
      this.stalls++;
      if (this.stalls >= STALL_LIMIT) {
        this.stalls = 0;
        return true;
      }
    }
  }

  /** Replaces a worker that stopped answering, giving it back every cell it never filled. Bounded: past
   *  MAX_RESTARTS the file keeps what it has, because a file the worker cannot decode at all would
   *  otherwise spawn mpv processes for the whole length of the film. */
  private async revive(): Promise<boolean> {
    const gen = this.gen;
    const url = this.url;
    if (!url || this.dead || gen !== this.gen) return false;
    if (this.restarts >= MAX_RESTARTS) {
      // Giving up on the grid is not a reason to leave a player pulling the film in the background: the
      // worker keeps decoding forward once nobody seeks it, and measured it sat there munching a whole
      // episode after the sweep had retired.
      this.stop(false);
      this.dead = true;
      return false;
    }
    this.restarts++;
    this.stop(false);
    if (gen !== this.gen) return false;
    this.dead = false;
    this.last = null;
    this.stalls = 0;
    this.good = 0;
    // A fresh process deserves a fresh set of tries, and the cells dropped while the old one was stuck are
    // exactly the ones worth retrying - except the one it died on. Handing that one back is what turned a
    // single unreadable offset into three workers and a stalled grid.
    if (this.suspect !== null) this.bad.add(this.suspect);
    this.suspect = null;
    this.tries.clear();
    for (let i = 0; i < this.count; i++) if (!this.tiles.has(i) && !this.bad.has(i)) this.pending.add(i);
    this.dir = path.join(tmpdir(), 'echoemby-thumbs-' + randomUUID().slice(0, 8));
    await this.start(url, gen);
    return gen === this.gen && !this.dead && !!this.pipe;
  }

  /** Seeks, waits for mpv to actually be *showing* that moment, then captures it.
   *
   *  A seek that reports success is not a picture of that moment. A worker that has stopped rendering
   *  accepts every seek, answers error: success, and keeps showing the frame it froze on - and because the
   *  window surface is re-encoded each time, the JPEG bytes are not even identical, so comparing pictures
   *  byte for byte lets them all through (measured 2026-10-29: 19 cells of a 171 min film held one shot
   *  from 11 minutes, and an earlier run filled 48 cells with the title card). What does tell the truth is
   *  time-pos: a working worker moves it to the target before the seek is done. So the seek only counts
   *  once time-pos has arrived and seeking is false, and anything else returns null, which the sweep counts
   *  as a stall and eventually answers by replacing the worker. */
  private async frame(
    pipe: MpvPipe,
    ms: number,
    gen: number,
    timeoutMs = FRAME_TIMEOUT_MS,
    acceptSame = false,
  ): Promise<Buffer | null | 'abort' | 'dead'> {
    // A worker whose upstream stream died still accepts a seek and never answers it: the command call alone
    // can sit for twenty seconds, three times over, and the sweep never gets to look at the answer. The
    // deadline therefore covers the whole attempt, seek included, and a worker that cannot even state its
    // position at the end of it is reported as dead instead of being waited on again.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = this.frameWithin(pipe, ms, gen, timeoutMs, acceptSame);
    const out = await Promise.race([
      work,
      new Promise<'expired'>(res => {
        timer = setTimeout(() => res('expired'), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (out !== 'expired') return out;
    void work.catch(() => undefined);
    const alive = await pipe.call(['get_property', 'time-pos'], 1_500).then(() => true).catch(() => false);
    return alive ? null : 'dead';
  }

  private async frameWithin(
    pipe: MpvPipe,
    ms: number,
    gen: number,
    timeoutMs: number,
    acceptSame: boolean,
  ): Promise<Buffer | null | 'abort'> {
    // The last cell's midpoint can sit past the end of the film; seeking there is an end of file, not a frame.
    const target = Math.min(ms, Math.max(0, this.duration - 1_500)) / 1000;
    const deadline = Date.now() + timeoutMs;
    let arrived = false;
    for (let attempt = 0; attempt < 3 && !arrived; attempt++) {
      const sent = await pipe.call(['seek', target, 'absolute', 'exact'], 20_000).then(() => true).catch(() => false);
      if (!sent) {
        // A rejected seek is cheap (the file may still be opening); a slow one is not, so only the cheap
        // case is retried, after giving the demuxer a moment.
        await new Promise(r => setTimeout(r, 300));
        continue;
      }
      for (;;) {
        const pos = await pipe.call<number>(['get_property', 'time-pos'], 3_000).catch(() => null);
        const seeking = await pipe.call<boolean>(['get_property', 'seeking'], 3_000).catch(() => true);
        if (typeof pos === 'number' && !seeking && Math.abs(pos - target) <= 0.8) {
          arrived = true;
          break;
        }
        if (this.dead || gen !== this.gen || Date.now() > deadline) break;
        // A pointer that moved on has made this seek pointless: the newer second is the one somebody is
        // looking at, and on a long film a seek costs seconds. Handing the loop back is not a failure -
        // the cell keeps its place and is retried after the newer answer.
        if (this.queued !== null) return 'abort';
        await new Promise(r => setTimeout(r, 200));
      }
    }
    if (!arrived || this.dead || gen !== this.gen) return null;
    const shotDeadline = Date.now() + Math.min(4_000, timeoutMs);
    for (;;) {
      const jpeg = await this.shot(pipe);
      // A second the pointer asked for is accepted even when it is byte-identical to the last one: two
      // positions inside a still shot *are* the same picture, and the arrival of time-pos has already said
      // the decoder is showing that moment. The sweep cannot afford that reading - it has no arrival to
      // trust per cell - which is why it keeps the byte test.
      if (jpeg && (acceptSame || !this.last || !jpeg.equals(this.last))) {
        if (gen !== this.gen) return null;
        this.last = jpeg;
        return jpeg;
      }
      if (this.dead || gen !== this.gen || Date.now() > shotDeadline) return null;
      await new Promise(r => setTimeout(r, 160));
    }
  }

  private async shot(pipe: MpvPipe): Promise<Buffer | null> {
    const file = path.join(this.dir, 'frame.jpg');
    const ok = await pipe.call(['screenshot-to-file', file, 'video'], 8_000).then(() => true).catch(() => false);
    if (!ok) return null;
    const jpeg = await readFile(file).catch(() => null);
    void rm(file, { force: true }).catch(() => undefined);
    return jpeg && jpeg.length > 0 ? jpeg : null;
  }

  /** Stands the worker down IDLE_STOP_MS after the last question was answered. A complete grid - or one
   *  whose remaining cells this file cannot decode - leaves an mpv holding the film open with nothing to
   *  do: 600 MB resident and a demuxer still reading ahead of a sweep nobody is waiting for. The grid, the
   *  demanded seconds and the saved folder all stay, so the next hover is answered from them and only the
   *  process is replaced. */
  private armIdle(): void {
    if (this.idleTimer || this.dead || !this.proc) return;
    const t = setTimeout(() => {
      this.idleTimer = null;
      this.sleep();
    }, IDLE_STOP_MS);
    // Never a reason to keep the app alive: this is an accessory to a window that is already closing.
    t.unref?.();
    this.idleTimer = t;
  }

  private disarmIdle(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** The worker's half of the stand-down. `sleeping` goes first: the pipe closing here is this function's
   *  own doing, and the socket-close handler reads an unexpected close as a worker that died. */
  private sleep(drained = false): void {
    this.disarmIdle();
    if (this.dead || !this.proc) return;
    if (this.pumping !== null) return;
    // Work in hand outranks a timer, but not a sweep that gave up on a starving film: those cells are
    // waiting on bandwidth, not on this worker, and the next hover picks them up again.
    if (!drained) {
      if (this.asking !== null || this.queued !== null) return;
      if (this.pending.size || this.demand.length) return;
    }
    const pipe = this.pipe;
    const proc = this.proc;
    this.pipe = null;
    this.proc = null;
    this.last = null;
    this.sleeping = true;
    if (pipe) this.stopLocal(proc, pipe);
    else if (proc) this.killProc(proc);
    this.closeHost();
  }

  /** Brings a stood-down worker back for the same file. Nothing is re-decoded: the tiles and the folder are
   *  untouched, so what a restart costs is the new mpv opening the film again, which the old process would
   *  have to do after any seek anyway. */
  private resume(): void {
    if (this.dead || this.proc || !this.url || !this.stepMs) return;
    this.sleeping = false;
    void this.start(this.url, this.gen);
  }

  private die(): void {
    this.stop(false);
  }

  /** Tears the process down. clean also removes the scratch folder - a worker that died on its own may
   *  still be holding a file open, so only the deliberate path deletes it here. */
  private stop(clean: boolean): void {
    this.dead = true;
    const pipe = this.pipe;
    const proc = this.proc;
    const dir = this.dir;
    this.pipe = null;
    this.proc = null;
    this.dir = '';
    if (pipe) this.stopLocal(proc, pipe);
    else if (proc) this.killProc(proc);
    this.closeHost();
    if (clean && dir) this.rmDir(dir, proc);
  }

  /** Removes a scratch folder once the worker that wrote into it is gone. Windows keeps frame.jpg locked
   *  until then, and a folder removed one line too early stays behind for good - measured: seven viewings
   *  left seven folders, every one of them empty and unremovable while its mpv was still running. */
  private rmDir(dir: string, proc: ChildProcess | null): void {
    const go = (): void => {
      void rm(dir, { recursive: true, force: true }).catch(() => undefined);
    };
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      go();
      return;
    }
    const t = setTimeout(go, 1_500);
    proc.once('exit', () => {
      clearTimeout(t);
      setTimeout(go, 200).unref?.();
    });
  }

  /** The parts of stop that only need the objects themselves, for a worker that close already forgot. */
  private stopLocal(proc: ChildProcess | null, pipe: MpvPipe): void {
    void pipe.call(['quit'], 1_000).catch(() => undefined);
    pipe.close();
    if (proc) this.killProc(proc);
  }

  private killProc(proc: ChildProcess): void {
    proc.removeAllListeners('exit');
    const t = setTimeout(() => proc.kill(), 400);
    proc.once('exit', () => clearTimeout(t));
  }
}
