// A markdown file shown as a document, built a few milliseconds at a time in the file's order, so however
// big it is the thread is never held long and the first blocks show at once; what's shown above never
// moves. A file's lexed blocks are kept by text, and the elements built for it by a key (the file at that
// version), so coming back to it shows it again without building anything. The blocks are a file's (a
// DocModel) or any others that read as such: a diff of two versions (md-diff.ts) shows its rows so.

import { Lru } from './cache.ts';
import { type Fence, Fences } from './md-code.ts';
import { DomBuilder, type DomOptions } from './md-dom.ts';
import { DocModel, type Token } from './markdown.ts';

/** The top-level blocks a view shows, as far as they're known. */
export interface Blocks {
  readonly length: number;
  /** Whether all are known. */
  readonly done: boolean;
  /** Learn more of them while `more()` says so; whether they're all known. */
  step(more: () => boolean): boolean;
  token(k: number): Token;
  /** The line block k starts at (its `data-line`), if the text shown has it. */
  line(k: number): number | undefined;
  /** The line block k's text starts at, blank lines before it included: never less than the one before's. */
  start(k: number): number;
  readonly slugs: DomOptions['slugs'];
  /** The block each heading's anchor is in. */
  readonly anchors: ReadonlyMap<string, number>;
  /** The blocks of block k (it, or its list items or table rows) that lines `changed` touch. */
  changed?(k: number, changed: ReadonlySet<number>): Set<object>;
  /** Builds block k, saying where it is, instead of the view. */
  build?(k: number, dom: DomBuilder): HTMLElement | null;
}

/** What's been built for a file: each top-level block's element (null when it has none), kept for the next view of it. */
interface Built {
  nodes: (HTMLElement | null)[];
  /** The elements a diff's marks go on: top-level blocks, list items, table rows. */
  elements: Map<object, HTMLElement>;
  /** Each block's code blocks to highlight. */
  fences: Map<number, Fence[]>;
  /** The elements marked changed. */
  marked: HTMLElement[];
  /** The last block shown, which has no margin below. */
  last: HTMLElement | null;
  /** The view showing them. */
  owner: DocView | null;
}

/** Elements built lately, by key: a few files, a couple of MB of text in all (a big file's elements take tens of MB). */
const built = new Lru<string, Built>(6, 2 << 20);

export interface ViewOptions extends Omit<DomOptions, 'slugs' | 'fence'> {
  text: string;
  /** What to show rather than `text`'s blocks. */
  blocks?: Blocks;
  /** Lines (1-based) a diff adds or changes, whose blocks are marked `.changed`. */
  changed?: ReadonlySet<number>;
  /** What the elements built are kept under, to show again at once: the file's path, version and how it's shown. */
  key?: string;
  /** Told, as blocks are shown, the first line of the last one, and whether all that will be shown is. */
  onprogress?: (line: number, done: boolean) => void;
  /** Which top-level blocks to show, as [from, to) ranges in order (to may be Infinity); all of them by default. Told
   *  once all the blocks are known, as a function: nothing's shown till then. */
  ranges?: [number, number][] | ((blocks: Blocks) => [number, number][]);
  /** The element standing for blocks `from` to `to` not shown, between ranges (`to` is the end's once it's known).
   *  Its buttons' `data-dir`, the one focused, is focused again in the gap replacing it. */
  gap?: (from: number, to: number) => HTMLElement;
  /** Told of the blocks shown besides `ranges`, as they are. */
  onopen?: (from: number, to: number) => void;
  /** The blocks to show to reveal block k, in the gap [from, to) (block k alone by default). */
  span?: (k: number, gap: [number, number]) => [number, number];
}

/** A stretch of blocks shown, [from, to): those before `done` are in place. */
interface Run {
  from: number;
  to: number;
  done: number;
  /** The gap shown before it, if any. */
  gap: HTMLElement | null;
}

/** A slice of work takes this many milliseconds at most, then a frame is drawn. */
const SLICE = 12;
/** And places this much of the file's text at most: laying it out is the frame's work (blocks built before cost nothing to place). */
const SLICE_TEXT = 24_000;
/** The first slice, done at once, places this much: about a screenful, drawn in the next frame. */
const FIRST_TEXT = 6_000;

let channel: MessageChannel | null = null;
const tasks: (() => void)[] = [];
/** `f` as a task of its own, right after the next frame (at once when none is drawn, hidden): one slice a frame. */
function nextFrame(f: () => void) {
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => tasks.shift()?.();
  }
  tasks.push(f);
  if (document.hidden) channel.port2.postMessage(null);
  else requestAnimationFrame(() => channel!.port2.postMessage(null));
}

let soonChannel: MessageChannel | null = null;
const soonTasks: (() => void)[] = [];
/** `f` as a task of its own, as soon as may be: work that draws nothing needn't wait for a frame. */
function nextTask(f: () => void) {
  if (!soonChannel) {
    soonChannel = new MessageChannel();
    soonChannel.port1.onmessage = () => soonTasks.shift()?.();
  }
  soonTasks.push(f);
  soonChannel.port2.postMessage(null);
}

/** What a slice's blocks go in, together: a frame then lays out the parts before as they were, rather than every
 *  block. It has no box of its own (margins collapse through it), so the blocks show as if they were the document's.
 *  While the document grows it's a paint layer too (`md-layer`), so a frame checks the new part alone before
 *  painting, not every block above; once all are shown it's not, and the text is drawn exactly as before. */
function part() {
  const e = document.createElement('div');
  e.className = 'md-part md-layer';
  return e;
}

/** Parts no longer layers, a frame. */
const SETTLE = 8;

/** The nearest ancestor of `el` that scrolls. */
function scroller(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return p;
  return null;
}

/** Shows a markdown file's blocks in `root`, as much of it as `ranges` says, in slices of time. */
export class DocView {
  readonly model: Blocks;
  private o: ViewOptions;
  private b: Built;
  private dom: DomBuilder;
  private fences: Fences;
  private runs: Run[];
  private changed: ReadonlySet<number> | undefined;
  private queued = false;
  private destroyed = false;
  private reported = 0;
  /** The ranges to show, until the blocks are all known. */
  private pending: ((blocks: Blocks) => [number, number][]) | null = null;
  /** The `data-dir` of the end's gap's button that was focused, to focus again once it's made anew. */
  private refocus: string | undefined;

  constructor(
    private root: HTMLElement,
    o: ViewOptions,
  ) {
    this.o = o;
    // What an earlier view of another text left in the same element goes, but it keeps its height till
    // this one is all shown: what's below doesn't jump up and back down as the file changes.
    if (root.firstChild) root.style.minHeight = `${root.offsetHeight}px`;
    root.replaceChildren(this.end);
    this.model = o.blocks ?? DocModel.of(o.text);
    this.changed = o.changed;
    const kept = o.key === undefined ? undefined : built.get(o.key);
    // Elements another view still shows can't be shown here too.
    if (kept && !kept.owner) {
      this.b = kept;
      for (const e of kept.marked) e.classList.remove('changed');
      kept.marked = [];
      kept.last?.classList.remove('md-last');
    } else {
      this.b = { nodes: [], elements: new Map(), fences: new Map(), marked: [], last: null, owner: null };
      if (o.key !== undefined && !kept) built.set(o.key, this.b, o.text.length);
    }
    this.b.owner = this;
    this.fences = new Fences(scroller(root));
    let at: Fence[] | undefined;
    this.dom = new DomBuilder({
      ...o,
      slugs: this.model.slugs,
      each: (t, el) => {
        if ('type' in t ? t.type === 'list_item' : Array.isArray(t)) this.b.elements.set(t, el);
        o.each?.(t, el);
      },
      fence: (code, text, path, lines) => (at ??= []).push({ code, text, path, lines }),
    });
    this.build = (k) => {
      at = undefined;
      const m = this.model;
      let e: HTMLElement | null;
      if (m.build) e = m.build(k, this.dom);
      else {
        e = this.dom.block(m.token(k), m.line(k));
        if (e) this.b.elements.set(m.token(k), e);
      }
      if (at) this.b.fences.set(k, at);
      return e;
    };
    const ranges = o.ranges ?? [[0, Infinity]];
    this.runs = [];
    if (typeof ranges === 'function') this.pending = ranges;
    else this.start(ranges);
    // Blocks still to be worked out are, after this task (which is showing the view): a frame or so.
    if (this.pending && !this.model.done) this.schedule(true);
    else this.work(-1, FIRST_TEXT);
  }

  /** Builds top-level block k (the model has it). */
  private build: (k: number) => HTMLElement | null;

  /** Shows `ranges`; each one's gap as the blocks before it are in (until then, a place past them isn't laid out yet). */
  private start(ranges: [number, number][]) {
    this.runs = ranges.map(([from, to]) => ({ from, to, done: from, gap: null }));
    this.ungapped = new Set(this.runs);
  }

  /** Runs whose gap isn't placed yet. */
  private ungapped = new Set<Run>();

  /** Mark the blocks lines `changed` touch, rather than those the view started with. */
  mark(changed: ReadonlySet<number> | undefined) {
    if (changed === this.changed) return;
    this.changed = changed;
    for (const e of this.b.marked) e.classList.remove('changed');
    this.b.marked = [];
    for (const r of this.runs) for (let k = r.from; k < r.done; k++) this.markBlock(k);
  }

  /** Show blocks [from, to) too, besides those shown: joined to the stretches they touch, the ones above
   *  at once (they're few: a gap opened), the ones below as the rest are. */
  show(from: number, to: number) {
    if (this.destroyed || this.pending || from >= to) return;
    this.o.onopen?.(from, to);
    let k = this.runs.findIndex((r) => r.to >= from);
    if (k < 0) k = this.runs.length;
    const r = this.runs[k];
    if (r && r.from <= to) {
      if (from < r.from) {
        // Above it: built now, put before its first block (after its gap).
        if (this.ungapped.delete(r)) this.placeGap(r, this.runs[k + 1]);
        const before = this.firstNode(r);
        const p = part();
        this.need(r.from - 1);
        for (let j = from; j < r.from; j++) this.place(j, p);
        this.root.insertBefore(p, before);
        r.from = from;
        if (r.done < from) r.done = from;
        this.refreshGap(k);
      }
      if (to > r.to) {
        r.to = to;
        // What's below it shows more of the gap after it, which is less.
        if (k === this.runs.length - 1) this.dropTail();
        else this.refreshGap(k + 1);
      }
    } else {
      const run = { from, to, done: from, gap: null };
      this.runs.splice(k, 0, run);
      // The end's gap is made again, for what's after it now.
      if (!this.runs[k + 1]) this.dropTail();
      this.placeGap(run, this.runs[k + 1]);
      this.refreshGap(k + 1);
    }
    this.join();
    this.schedule();
  }

  /** Shows at once (if it's to be shown) the block line `line` is in, and those before it; its element. */
  reach(line: number): HTMLElement | null {
    const m = this.model;
    if (this.pending) return null;
    // Lexed a step at a time until a block starts past the line.
    while (!m.done && !(m.length && m.start(m.length - 1) > line)) {
      let once = true;
      m.step(() => once && !(once = false));
    }
    let k = m.length - 1;
    while (k >= 0 && m.start(k) > line) k--;
    if (k < 0) return null;
    this.work(k);
    while (k >= 0 && !this.b.nodes[k]) k--;
    return this.b.nodes[k] ?? null;
  }

  /** The heading with anchor `slug`, shown at once if it wasn't yet (in a gap, the gap opens); null if there's none. */
  reveal(slug: string): HTMLElement | null {
    const sel = `[data-anchor="${CSS.escape(slug)}"]`;
    const at = this.root.querySelector<HTMLElement>(sel);
    if (at || this.destroyed || this.pending) return at;
    this.model.step(() => true);
    const k = this.model.anchors.get(slug);
    if (k === undefined) return null;
    const gap = this.gapAround(k);
    const [from, to] = gap && this.o.span ? this.o.span(k, gap) : [k, k + 1];
    this.show(Math.min(from, k), Math.max(to, k + 1));
    this.work(k);
    return this.root.querySelector<HTMLElement>(sel);
  }

  /** The blocks not shown, [from, to), that block k is among; null when it's to be shown. */
  private gapAround(k: number): [number, number] | null {
    let start = 0;
    for (const r of this.runs) {
      if (k < r.from) return [start, r.from];
      if (k < r.to) return null;
      start = r.to;
    }
    return [start, this.model.length];
  }

  destroy() {
    this.destroyed = true;
    this.fences.destroy();
    if (this.b.owner === this) this.b.owner = null;
  }

  /** Lexes until block k is, or all is. */
  private need(k: number) {
    while (this.model.length <= k && !this.model.done) this.model.step(() => this.model.length <= k);
  }

  private markBlock(k: number) {
    if (!this.changed?.size || !this.model.changed) return;
    for (const t of this.model.changed(k, this.changed)) {
      const e = this.b.elements.get(t);
      if (!e) continue;
      e.classList.add('changed');
      this.b.marked.push(e);
    }
  }

  /** Block k into `into`, built unless it was. */
  private place(k: number, into: Node) {
    let e = this.b.nodes[k];
    if (e === undefined) e = this.b.nodes[k] = this.build(k);
    if (!e) return;
    into.appendChild(e);
    this.markBlock(k);
    for (const f of this.b.fences.get(k) ?? []) this.fences.add(f);
  }

  /** The first part of run `r`, or what follows it when it has none yet. */
  private firstNode(r: Run): Node | null {
    for (let k = r.from; k < r.done; k++) {
      const e = this.b.nodes[k];
      if (e) return e.parentNode;
    }
    return this.after(r);
  }

  /** What follows run r's blocks: the next one's gap or first block. */
  private after(r: Run): Node | null {
    const next = this.runs[this.runs.indexOf(r) + 1];
    return next ? (next.gap ?? this.firstNode(next)) : (this.tail ?? this.end);
  }

  /** The gap after the last run, once the file's end is known. */
  private tail: HTMLElement | null = null;

  /** The end's gap goes, to be made again once the blocks before it are in. */
  private dropTail() {
    if (!this.tail) return;
    this.refocus = focusedDir(this.tail);
    this.tail.remove();
    this.tail = null;
  }
  /** Always the root's last child, so adding a part never changes which is (purr's `.md > :last-child` would
   *  restyle all of the part before). */
  private end = Object.assign(document.createElement('div'), { hidden: true });

  /** Puts run r's gap (if blocks before it aren't shown) before `next`'s, or at the end. */
  private placeGap(r: Run, next?: Run) {
    const i = this.runs.indexOf(r);
    const start = i > 0 ? this.runs[i - 1].to : 0;
    if (r.from <= start || !this.o.gap) return;
    r.gap = this.o.gap(start, r.from);
    this.root.insertBefore(r.gap, next ? (next.gap ?? this.firstNode(next)) : (this.tail ?? this.end));
  }

  /** Run i's gap, again, for the blocks now between it and the one before. */
  private refreshGap(i: number) {
    const r = this.runs[i];
    if (!r?.gap) return;
    const old = r.gap;
    r.gap = null;
    const start = i > 0 ? this.runs[i - 1].to : 0;
    const dir = focusedDir(old);
    if (r.from > start && this.o.gap) {
      old.replaceWith((r.gap = this.o.gap(start, r.from)));
      refocus(r.gap, dir);
    } else old.remove();
  }

  /** Joins runs that meet, once the first is in place up to the second. */
  private join() {
    for (let i = 0; i + 1 < this.runs.length; i++) {
      const [r, n] = [this.runs[i], this.runs[i + 1]];
      if (r.to < n.from || r.done < n.from) continue;
      n.gap?.remove();
      this.ungapped.delete(n);
      this.runs.splice(i + 1, 1);
      r.to = Math.max(r.to, n.to);
      r.done = n.done;
      i--;
    }
  }

  /** Marks the last block shown as such, once all are (unless a gap follows it). */
  private lastBlock() {
    this.b.last?.classList.remove('md-last');
    this.b.last = null;
    const r = this.tail ? undefined : this.runs.at(-1);
    for (let k = (r?.done ?? 0) - 1; r && k >= r.from && !this.b.last; k--) this.b.last = this.b.nodes[k];
    this.b.last?.classList.add('md-last');
  }

  /** Parts made plain again, a few a frame. */
  private settle() {
    const layers = this.root.getElementsByClassName('md-layer');
    if (!layers.length || this.destroyed) return;
    for (let n = 0; n < SETTLE && layers.length; n++) layers[0].classList.remove('md-layer');
    if (layers.length) nextFrame(() => this.settle());
  }

  /** The next slice of work, after the next frame (or `soon`, when it draws nothing). */
  private schedule(soon = false) {
    if (this.queued || this.destroyed) return;
    this.queued = true;
    (soon ? nextTask : nextFrame)(() => {
      this.queued = false;
      this.work();
    });
  }

  /** Whether block k is to be shown but isn't yet. */
  private due(k: number) {
    return this.runs.some((r) => r.from <= k && k < r.to && r.done <= k);
  }

  /** A slice of work: lex and place the next blocks, in order (all of them up to block `upTo` at least). */
  private work(upTo = -1, most = SLICE_TEXT) {
    if (this.destroyed) return;
    const end = performance.now() + SLICE;
    let text = 0;
    const more = () => (upTo >= 0 && this.due(upTo)) || (text < most && performance.now() < end);
    if (this.pending) {
      if (!this.model.step(more)) return this.schedule(true);
      this.start(this.pending(this.model));
      this.pending = null;
    }
    let i = 0;
    let into: HTMLElement | null = null;
    let last = -1;
    const flush = () => {
      if (into?.firstChild) this.root.insertBefore(into, this.after(this.runs[i]));
      into = null;
    };
    while (i < this.runs.length) {
      const r = this.runs[i];
      const next = this.runs[i + 1];
      if (r.done >= r.to || (next && r.done >= next.from)) {
        flush();
        if (next && r.done >= next.from) this.join();
        else i++;
        continue;
      }
      if (!more()) break;
      if (r.done >= this.model.length) {
        if (this.model.done) {
          r.to = this.model.length;
          continue;
        }
        this.model.step(() => more() && this.model.length <= r.done);
        continue;
      }
      if (this.ungapped.delete(r)) this.placeGap(r, next);
      this.place(r.done, (into ??= part()));
      text += this.model.token(r.done).raw.length;
      last = r.done++;
    }
    flush();
    const done = i >= this.runs.length;
    if (done && this.model.done && this.o.gap && !this.tail) {
      const from = this.runs.at(-1)?.to ?? 0;
      if (from < this.model.length) {
        this.end.before((this.tail = this.o.gap(from, this.model.length)));
        refocus(this.tail, this.refocus);
      }
      this.refocus = undefined;
    }
    if (done) {
      this.lastBlock();
      this.root.style.minHeight = '';
      this.settle();
    }
    if (last >= 0 || done) {
      const line = last >= 0 ? (this.model.line(last) ?? this.model.start(last)) : this.reported;
      this.reported = line;
      this.o.onprogress?.(line, done);
    }
    if (!done) this.schedule();
  }
}

/** The `data-dir` of the button focused in `gap`, if one is. */
function focusedDir(gap: HTMLElement): string | undefined {
  const a = document.activeElement;
  return a instanceof HTMLElement && gap.contains(a) ? (a.dataset.dir ?? '') : undefined;
}

/** Focus `gap`'s button `dir` (or its first) when one of the gap it replaced was. */
function refocus(gap: HTMLElement, dir: string | undefined) {
  if (dir === undefined) return;
  (gap.querySelector<HTMLElement>(`[data-dir="${dir}"]`) ?? gap.querySelector<HTMLElement>('button'))?.focus();
}
