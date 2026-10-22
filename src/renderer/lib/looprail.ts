/** Seamless looping for the app's horizontal rails.
 *
 *  A rail that stops at its own ends asks the reader to release the wheel and drag back; this makes the two
 *  ends meet instead. The trick is the one every carousel uses: the first few cards are copied onto the row's
 *  right and the last few onto its left, so there is always real content on the side being entered, and when
 *  the offset crosses a copy the row is moved back by exactly one list-length — a position that paints the
 *  same pixels, so the correction is invisible.
 *
 *  The copies are DOM clones rather than a second render of the slot: a rail's cards come from six different
 *  callers through `HScroller`'s slot, and 3× copies of a hundred-episode band is a price the lobby should not
 *  pay for eight extra posters. A clone therefore has to be made to behave like the node it was copied from,
 *  which is what the click forwarding and the art refresh below are for.
 *
 *  A row whose cards already fit the viewport gets nothing: there is no end to walk past, and copies would
 *  have invented an overflow the reader then has to scroll to discover. */

const CLONE = 'data-loop-clone';

/** What a card hears when a copy of itself is on screen while the card is not. Its picture is gated on
 *  being near, and a copy is near for the reader while being nowhere near the thing it was copied from. */
export const LOOP_NEED = 'loop-need';

/** How much of its own width an arrow press travels, and therefore how many copies a row has to keep on the
 *  side it is heading for. Shared so the engines step by it and this file sizes the copies against it. */
export const RAIL_PRESS = 0.82;

export interface LoopRail {
  /** Whether this track is wide enough that looping means anything. */
  readonly looped: boolean;
  /** The offset that puts the first card on the content line — where a non-looping row sits at 0. */
  readonly home: number;
  /** One list-length of travel: the distance after which the row looks exactly like it did. */
  readonly period: number;
  /** One card's width plus the gap between cards, read off two adjacent cards. */
  pitch(): number;
  /** The row's own cards, in order, with the copies left out. Anything that counts a card by position
   *  has to count it in this list: the copies are children of the track too. */
  originals(): HTMLElement[];
  cardAt(i: number): HTMLElement | undefined;
  /** Re-read the geometry and rebuild the copies if the answer changed. Cheap when it did not. */
  sync(): void;
  /** Where a press asking for `to` can actually leave the row: on the card grid, and inside the range the
   *  copies cover — an ask past them becomes the last boundary that is not.
   *  `snap` off for a caller that moves toward its target a frame at a time (the lightbox rail) — a grid
   *  there would quantise the gesture. */
  place(to: number, snap?: boolean): number;
  /** A smooth glide to `x`. Nothing re-anchors the row while it runs, and a re-layout that moves the
   *  content under it sends `x` along instead: a scripted scroll that is told to stop halfway keeps only
   *  the part it already travelled, which is how a wrap used to lose its tail. */
  glideTo(x: number): void;
  /** Put the row somewhere without animating it. */
  jumpTo(x: number): void;
  /** Step over a copy if the row has walked past one. Returns how far the offset moved, so a caller that
   *  keeps its own destination (the lightbox rail's follow loop) can carry it across with the row. */
  normalize(force?: boolean): number;
  destroy(): void;
}

const rails = new WeakMap<HTMLElement, LoopRail>();

export function createLoopRail(
  track: HTMLElement,
  opts: { auto?: boolean; onChange?: (looped: boolean) => void; onShift?: (d: number) => void } = {},
): LoopRail {
  const r = new Rail(track, opts.auto !== false, opts.onChange, opts.onShift);
  rails.set(track, r);
  return r;
}

/** The offset a track has to be at to show its first card on the content line — 0 unless it is looping. */
export function railHome(track: HTMLElement | null): number {
  return (track && rails.get(track)?.home) || 0;
}

class Rail implements LoopRail {
  looped = false;
  home = 0;
  period = 0;

  private head: HTMLElement;
  private tail: HTMLElement;
  /** Copies at either end, and not the same number: a press walks a screen past the end it is heading for,
   *  while the end it came from only has to hold the row up until the next seam. */
  private headK = 0;
  private tailK = 0;
  private p = 0;
  private frozen = false;
  /** Where a glide in flight is heading. Read only while `frozen`: the row's live offset is a third of the
   *  way there, and re-anchoring that would stop the journey short of its destination. */
  private want = 0;
  private frame = 0;
  private hFrame = 0;
  private ro: ResizeObserver | null = null;
  private mo: MutationObserver | null = null;
  private io: IntersectionObserver | null = null;

  constructor(
    private el: HTMLElement,
    private auto: boolean,
    private onChange?: (looped: boolean) => void,
    private onShift?: (d: number) => void,
  ) {
    // The copies are inserted and removed behind the viewport. Scroll anchoring would treat that as the
    // content moving and "helpfully" move the offset to compensate — which is the one thing that must
    // never happen to a position chosen by this file.
    el.style.overflowAnchor = 'none';
    this.head = segment('h');
    this.tail = segment('t');
    el.prepend(this.head);
    el.append(this.tail);
    el.addEventListener('scroll', this.onScroll, { passive: true });
    el.addEventListener('scrollend', this.onEnd);
    el.addEventListener('click', this.onClick);
    this.ro = new ResizeObserver(() => this.queue());
    this.ro.observe(el);
    /* The copies are only worth having if they say what their source says. A poster's ★, its 「看到 15:00」
       and its picture all arrive after the row is first laid out, so watch the row and re-copy; the records
       this file itself causes are dropped, or the rebuild would schedule the next one forever. */
    this.mo = new MutationObserver(recs => {
      if (recs.some(r => !this.inside(r.target))) this.queue();
    });
    this.mo.observe(el, { childList: true, subtree: true, attributes: true });
    /* A lobby row starts out below the fold and `content-visibility: auto` keeps its cards unmeasured there,
       which is the one moment this file has nothing to go on. Ask again when it is nearly on screen. */
    this.io = new IntersectionObserver(() => this.queue(), { rootMargin: '600px' });
    this.io.observe(el);
  }

  destroy(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.hFrame) cancelAnimationFrame(this.hFrame);
    this.hFrame = 0;
    this.ro?.disconnect();
    this.mo?.disconnect();
    this.io?.disconnect();
    this.el.removeEventListener('scroll', this.onScroll);
    this.el.removeEventListener('scrollend', this.onEnd);
    this.el.removeEventListener('click', this.onClick);
    this.head.remove();
    this.tail.remove();
    rails.delete(this.el);
  }

  originals(): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const n of Array.from(this.el.children) as HTMLElement[]) if (n !== this.head && n !== this.tail) out.push(n);
    return out;
  }

  cardAt(i: number): HTMLElement | undefined {
    return this.originals()[i];
  }

  pitch(): number {
    return this.pitchOf(this.originals());
  }

  private pitchOf(orig: HTMLElement[]): number {
    if (!orig.length) return 0;
    if (orig.length > 1) return orig[1].getBoundingClientRect().left - orig[0].getBoundingClientRect().left;
    return orig[0].getBoundingClientRect().width + (parseFloat(getComputedStyle(this.el).columnGap) || 0);
  }

  /** Content-x of a card's left edge, in the track's own scrollable coordinates. */
  private x(n: HTMLElement): number {
    return n.getBoundingClientRect().left - this.el.getBoundingClientRect().left + this.el.scrollLeft;
  }

  private inside(n: Node): boolean {
    return n === this.head || n === this.tail || this.head.contains(n) || this.tail.contains(n);
  }

  private queue(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.sync();
    });
  }

  private soon(): void {
    if (this.hFrame) return;
    this.hFrame = requestAnimationFrame(() => {
      this.hFrame = 0;
      this.hydrate();
    });
  }

  /* A copy of a card whose picture nobody asked for is a grey box the reader can see. Two things keep it
     that way: the card behind the copy withholds its art until its own IntersectionObserver says it is
     near — and a copy parked in the left gutter, or one the loop has just slid into view, is near for the
     reader while being nowhere near it — and the copy's own `img` is `loading="lazy"`, so a node sitting
     outside the scrollport never fetches. Say so to both, for the copies that are actually wanted: the
     rest stay cheap. */
  private hydrate(): void {
    const el = this.el;
    if (!this.looped || !el.clientWidth) return;
    const orig = this.originals();
    const l = el.scrollLeft - this.p;
    const r = el.scrollLeft + el.clientWidth + this.p;
    for (const c of Array.from(this.head.children) as HTMLElement[]) this.need(c, l, r, orig);
    for (const c of Array.from(this.tail.children) as HTMLElement[]) this.need(c, l, r, orig);
  }

  private need(clone: HTMLElement, l: number, r: number, orig: HTMLElement[]): void {
    const x0 = this.x(clone);
    if (x0 > r || x0 + clone.offsetWidth < l) return;
    for (const img of Array.from(clone.querySelectorAll<HTMLImageElement>('img'))) img.loading = 'eager';
    const src = orig[Number(clone.getAttribute(CLONE))];
    if (src && !src.querySelector('img')) src.dispatchEvent(new Event(LOOP_NEED));
  }

  /** Move the row without animating it. `scroll-behavior: smooth` is on the track's own rule, so writing
   *  `scrollLeft` starts a glide rather than a jump — and a glide that a second measure reads back as the
   *  row's position drifts the row one band further on every pass. */
  private put(x: number): void {
    this.el.scrollTo({ left: x, behavior: 'instant' });
  }

  sync(): void {
    const el = this.el;
    // A row that has not been laid out has nothing to say: `content-visibility: auto` keeps the lobby's
    // below-the-fold rows unmeasured until they come on screen, and 0 of everything means "fits".
    if (!el.clientWidth) return;
    const orig = this.originals();
    if (orig.length < 2) return this.stop();
    const p = this.pitchOf(orig);
    const last = orig[orig.length - 1];
    const cs = getComputedStyle(el);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const span = this.x(last) + last.offsetWidth - this.x(orig[0]);
    // Nothing measured, which is not the same answer as "it fits": a row caught mid-layout would otherwise
    // have its copies thrown away and nothing left to tell it to come back.
    if (p <= 0 || span <= 0) return;
    if (padL + span <= el.clientWidth + 1) return this.stop();
    /* Nor is a band that holds less than a screen and a half of travel worth looping: one press is longer
       than the band itself, so the wrap arrives at the far end going the wrong way round. Measured on the
       detail page — 12 cast heads across 1.1 screens, and 4 stills across 1.2, both walked backwards.
       Those bands keep the behaviour they had: arrows that hide at either end. */
    if (span <= 1.5 * (el.clientWidth - padL - padR)) return this.stop();

    /* Enough copies on the right that the widest press the engines make — a share of the viewport, which is
       what nudge() steps by — lands inside them rather than against the end of the row. */
    const screen = Math.ceil(el.clientWidth / p) + 1;
    const n = orig.length;
    this.headK = Math.min(n, screen);
    this.tailK = Math.min(n, screen + Math.ceil((el.clientWidth * RAIL_PRESS) / p));
    const was = this.looped;
    /* The reader keeps looking at the same card across a re-layout: a sweep of the rail or a late payload
       changes how many copies there are, and the content moves by exactly that many cards. So the offset is
       corrected by the shift in 「home」 and by nothing else — not snapped to a card boundary, because a
       band re-measures constantly (every poster that loads mutates the row) and a snap would stop a glide
       that is still travelling (measured: a press of four cards landed one card along). */
    const from = this.home;
    const gliding = this.frozen;
    const scroll = gliding ? this.want : el.scrollLeft;
    this.p = p;
    this.copy(orig);
    const t0 = this.tail.firstElementChild as HTMLElement | null;
    this.period = t0 ? this.x(t0) - this.x(orig[0]) : orig.length * p;
    this.home = this.x(orig[0]) - padL;
    this.looped = true;
    /* A caller that is still walking towards somewhere has that somewhere in the old coordinates. The
       copies just went in front of the row, so its target has to move by the same amount — otherwise the
       caller stops one band short of the card it was asked to show (measured on the 灯箱 thumb rail: the
       centring ask for 第 34 张 landed 1506px short, and the rail opened with the selected thumb off the
       end of it, which read as 「没有选中当前卡片」). */
    if (this.home !== from) this.onShift?.(this.home - from);
    const target = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, scroll + (this.home - from)));
    /* A glide whose destination just moved has to be sent on its way again from where it actually is;
       writing the offset would cut it off. Measured on the player's 选集条, which is asked to centre on the
       episode being played before its copies exist: the first re-layout translated the third of the glide
       the row had travelled and the strip opened on 第 221 集 with 第 224 集 playing. */
    if (Math.abs(target - scroll) >= 1) {
      if (gliding) this.glideTo(target);
      else this.put(target);
    }
    if (!was) this.onChange?.(true);
    this.hydrate();
  }

  private stop(): void {
    const was = this.looped;
    const back = this.home;
    this.looped = false;
    // The row is about to be moved by hand, so a glide that has not finished is over: leaving `frozen` set
    // would have the next measure chase a destination nobody asked for any more.
    this.frozen = false;
    this.home = 0;
    this.period = 0;
    this.headK = 0;
    this.tailK = 0;
    this.head.replaceChildren();
    this.tail.replaceChildren();
    // The copies in front of the first card were holding the row that many pixels along; take them away
    // with the row, or the next measure reads the leftover as a position the reader asked for.
    if (back) {
      const to = Math.max(0, this.el.scrollLeft - back);
      this.onShift?.(to - this.el.scrollLeft);
      this.put(to);
    }
    if (was) this.onChange?.(false);
  }

  /** Re-place the two segments and refill them. They stay in the DOM even when empty so that a row flipping
   *  back and forth across the "does it fit" line never mutates the track's own child list — Vue owns that
   *  list, and the slot's patch anchors are the reason the copies live in wrappers at all. */
  private copy(orig: HTMLElement[]): void {
    const el = this.el;
    if (this.head !== el.firstElementChild) el.insertBefore(this.head, orig[0]);
    if (this.tail !== el.lastElementChild) el.appendChild(this.tail);
    const a = document.createDocumentFragment();
    for (let i = orig.length - this.headK; i < orig.length; i++) a.appendChild(harvest(orig[i], i));
    this.head.replaceChildren(a);
    const b = document.createDocumentFragment();
    for (let i = 0; i < this.tailK; i++) b.appendChild(harvest(orig[i], i));
    this.tail.replaceChildren(b);
  }

  glideTo(x: number): void {
    this.frozen = true;
    this.want = x;
    this.el.scrollTo({ left: x, behavior: 'smooth' });
  }

  jumpTo(x: number): void {
    this.frozen = false;
    this.put(x);
    this.normalize(true);
  }

  /* A press asks for a destination a screen further along, and a short row's copies can run out before it.
     Clamping there left the row holding a card's worth of nothing — measured, an 18-card row asked 6120
     against a reachable 5812 and parked 100px between two posters, because the maximum is not a card
     boundary. So the ask is put onto the grid first, and a grid point beyond the range becomes the last
     one inside it: the row then travels less than asked, never between two cards. */
  place(to: number, snap = true): number {
    const el = this.el;
    const max = el.scrollWidth - el.clientWidth;
    const p = this.looped ? this.p : this.pitch();
    if (!snap || p <= 0) return Math.max(0, Math.min(to, max));
    const base = this.looped ? this.home : 0;
    const x = Math.round((to - base) / p) * p + base;
    // A row that does not loop has its own ends, and the end of it is a legitimate place to stop.
    if (!this.looped) return Math.max(0, Math.min(x, max));
    if (x > max) return base + Math.floor((max - base) / p) * p;
    if (x < 0) return base + Math.ceil((0 - base) / p) * p;
    return x;
  }

  normalize(force = false): number {
    if (this.frozen && !force) return 0;
    this.frozen = false;
    if (!this.looped) return 0;
    const el = this.el;
    const s = el.scrollLeft;
    /* Half a card of slack either side: a row that rests a device pixel or two short of its beginning has
       not walked into the copies at all, and reading it as having done so moves the whole list. */
    const slack = this.p / 2;
    let d = 0;
    if (s < this.home - slack) d = this.period;
    else if (s >= this.home + this.period - slack) d = -this.period;
    else return 0;
    this.put(s + d);
    this.onShift?.(d);
    // Re-copying at the seam is also what hands a clone the art its source loaded while nobody was looking.
    this.copy(this.originals());
    return d;
  }

  private onScroll = (): void => {
    this.soon();
    if (this.auto) this.normalize();
  };

  private onEnd = (): void => {
    this.hydrate();
    if (this.auto) this.normalize(true);
  };

  /* A clone has no component behind it, so nothing listens to it: the click is replayed on the card it was
     copied from, at the same place in that card's tree. The path matters — a still card's play disc is a
     span inside the button, and forwarding the press to the button would open the page instead. */
  private onClick = (e: MouseEvent): void => {
    const hit = e.target as Element | null;
    const cl = hit?.closest<HTMLElement>(`[${CLONE}]`);
    if (!cl || !this.inside(cl)) return;
    const src = this.originals()[Number(cl.getAttribute(CLONE))];
    if (!src) return;
    const path: number[] = [];
    for (let n: Element | null = hit; n && n !== cl; n = n.parentElement) {
      const parent = n.parentElement;
      if (!parent) break;
      path.unshift(Array.prototype.indexOf.call(parent.children, n));
    }
    let t: Element = src;
    for (const i of path) {
      const next = t.children[i];
      if (!next) break;
      t = next;
    }
    (t as HTMLElement).click();
  };
}

function segment(side: string): HTMLElement {
  const el = document.createElement('div');
  el.dataset.loopSeg = side;
  // The copies have to sit in the row's own flex line, and `contents` is what lets a wrapper hold them
  // without becoming a flex item itself.
  el.style.display = 'contents';
  return el;
}

function harvest(src: HTMLElement, i: number): HTMLElement {
  const n = src.cloneNode(true) as HTMLElement;
  n.setAttribute(CLONE, String(i));
  n.setAttribute('aria-hidden', 'true');
  n.tabIndex = -1;
  for (const f of Array.from(n.querySelectorAll<HTMLElement>('button, a, [tabindex]'))) f.tabIndex = -1;
  // A node inserted under `.in .card` replays the row's staggered entrance. The copies arrive at a seam,
  // where the last thing wanted is sixteen cards rising into place.
  n.style.animation = 'none';
  for (const img of Array.from(n.querySelectorAll('img'))) {
    if (!img.getAttribute('src') || img.classList.contains('show') || img.classList.contains('on')) continue;
    img.addEventListener(
      'load',
      () => {
        img.classList.add('show', 'on');
        n.querySelector('.skeleton')?.remove();
      },
      { once: true },
    );
  }
  return n;
}
