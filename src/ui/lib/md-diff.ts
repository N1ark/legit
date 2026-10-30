// A markdown file's diff as the file reads, as GitHub's rich diff shows it: both versions lexed (a section
// at a time, as a view of either would be), lined up block by block (md-align.ts) a stretch of changes at a
// time, and shown by a DocView as one document: the blocks a commit added and removed in place, the ones it
// edited once with what changed in them marked. Only the changes and a little around them show; the rest
// folds into gaps that open on asking. Each block built says where it is in both versions (`data-line`,
// `data-old-line`), so a place in it maps to the diff's lines and back (place.ts).

import { tooltip } from 'purr';
import { ArrowLineDownRegular, ArrowLineUpRegular, ArrowsOutLineVerticalRegular } from 'purr/glyphs';
import { type DiffSpan, type Marks, type Row, alignSteps, blockKey, blockKind, foldRanges, invisible, joinRanges, mergeBlock, pairRun, similarity } from './md-align.ts';
import { type DomBuilder, type DomOptions, icon } from './md-dom.ts';
import type { Blocks } from './md-view.ts';
import { DocModel, type Token } from './markdown.ts';
import { Ids } from './seqdiff.ts';

/** Blocks shown either side of a change. */
const CONTEXT = 2;
/** A gap opens this many blocks at a time, or all of it when it's no more. */
export const STEP = 10;
/** Model blocks given ids between asking whether there's time for more. */
const INTERN = 512;
/** Diffs kept, and the text they're of in all, at most. */
const KEPT = 4;
const KEPT_TEXT = 6 << 20;
/** Milliseconds of idle time a slice of warming takes at most. */
const IDLE = 8;

/** What a view of a diff opened besides its changes, kept while the diff view lives (by the texts it was of). */
export interface Fold {
  old?: string;
  text?: string;
  opened: [number, number][];
}

export class DocDiff implements Blocks {
  readonly a: DocModel;
  readonly b: DocModel;
  /** Rows lined up: `o` and `n` are blocks of the old and new model. */
  private rows: Row[] = [];
  private ready = false;
  private ids = new Ids();
  /** Each side's visible blocks: their ids, and which of the model's they are. */
  private sides = [
    { ids: [] as number[], at: [] as number[], seen: 0 },
    { ids: [] as number[], at: [] as number[], seen: 0 },
  ];
  private steps: Generator<void, Row[]> | null = null;
  private aligned: Row[] = [];
  private starts: number[] = [];
  readonly marks: Marks = { marks: new WeakMap(), alias: new Map() };
  readonly anchors = new Map<string, number>();
  /** A heading's anchor, as the new version has it (an edited one's too). */
  readonly slugs: DomOptions['slugs'] = { get: (t) => this.b.slugs.get(this.marks.alias.get(t) ?? t) };

  private constructor(old: string, text: string) {
    this.a = DocModel.of(old);
    this.b = DocModel.of(text);
    // The new version first, so the old one takes what it can of it (or the other way, when the old one's in already).
    this.a.share(this.b);
    this.b.share(this.a);
  }

  /** Diffs worked out lately, a few MB of text in all: going back to one shows it at once. */
  private static kept: DocDiff[] = [];

  /** The diff of `old` to `text`, worked out as far as any view got. */
  static of(old: string, text: string): DocDiff {
    const list = DocDiff.kept;
    const k = list.findIndex((d) => d.old === old && d.text === text);
    const d = k >= 0 ? list.splice(k, 1)[0] : new DocDiff(old, text);
    list.unshift(d);
    let size = 0;
    for (let n = 0; n < list.length; n++) {
      size += list[n].old.length + list[n].text.length;
      if (n && (n >= KEPT || size > KEPT_TEXT)) list.length = n;
    }
    return d;
  }

  /** Works out the diff of `old` to `text` when the page is idle, a little at a time, to show it at once when it's asked for. */
  static warm(old: string, text: string) {
    const d = DocDiff.of(old, text);
    if (d.ready || d.warming) return;
    d.warming = true;
    const idle = (f: (budget: number) => void) =>
      typeof requestIdleCallback === 'function' ? requestIdleCallback((e) => f(e.timeRemaining())) : setTimeout(() => f(IDLE), IDLE * 4);
    const run = (budget: number) => {
      const end = performance.now() + Math.min(IDLE, budget);
      if (d.step(() => performance.now() < end)) d.warming = false;
      else idle(run);
    };
    idle(run);
  }

  private warming = false;

  private get old() {
    return this.a.text;
  }

  private get text() {
    return this.b.text;
  }

  get length() {
    return this.ready ? this.rows.length : 0;
  }

  get done() {
    return this.ready;
  }

  step(more: () => boolean): boolean {
    while (!this.ready && more()) {
      if (!this.b.done || this.sides[1].seen < this.b.length) {
        if (this.sides[1].seen < this.b.length) this.intern(this.b, this.sides[1]);
        else this.b.step(more);
      } else if (!this.a.done || this.sides[0].seen < this.a.length) {
        if (this.sides[0].seen < this.a.length) this.intern(this.a, this.sides[0]);
        else this.a.step(more);
      } else if (!this.steps) this.steps = alignSteps(this.sides[0].ids, this.sides[1].ids, this.pair, this.aligned);
      else if (this.steps.next().done) this.finish();
    }
    return this.ready;
  }

  /** Ids for the next of model m's blocks, the same text the same id on either side. */
  private intern(m: DocModel, side: (typeof this.sides)[number]) {
    const end = Math.min(m.length, side.seen + INTERN);
    for (let k = side.seen; k < end; k++) {
      const t = m.token(k);
      if (invisible(t)) continue;
      side.ids.push(this.ids.of(blockKey(t)));
      side.at.push(k);
    }
    side.seen = end;
  }

  private pair = (ra: number[], rb: number[]) => {
    const ta = (x: number) => this.a.token(this.sides[0].at[ra[x]]);
    const tb = (y: number) => this.b.token(this.sides[1].at[rb[y]]);
    return pairRun(
      ra.length,
      rb.length,
      (x) => blockKind(ta(x)),
      (y) => blockKind(tb(y)),
      (x, y) => similarity(ta(x), tb(y)),
    );
  };

  private finish() {
    const [sa, sb] = this.sides;
    this.rows = this.aligned.map((r) => ({ op: r.op, o: r.o >= 0 ? sa.at[r.o] : -1, n: r.n >= 0 ? sb.at[r.n] : -1 }));
    const rowOf = new Map<number, number>();
    this.rows.forEach((r, k) => r.n >= 0 && rowOf.set(r.n, k));
    for (const [slug, n] of this.b.anchors) {
      const r = rowOf.get(n);
      if (r !== undefined) this.anchors.set(slug, r);
    }
    let next = this.b.length ? this.b.lines[this.b.length - 1][1] + 1 : 1;
    this.starts = new Array(this.rows.length);
    for (let k = this.rows.length - 1; k >= 0; k--) {
      const n = this.rows[k].n;
      this.starts[k] = next = n >= 0 ? this.b.start(n) : next;
    }
    this.ready = true;
  }

  token(k: number): Token {
    const r = this.rows[k];
    return r.n >= 0 ? this.b.token(r.n) : this.a.token(r.o);
  }

  line(k: number): number | undefined {
    const n = this.rows[k].n;
    return n >= 0 ? this.b.line(n) : undefined;
  }

  start(k: number): number {
    return this.starts[k];
  }

  /** The rows to show: the changes and a little around them, and what the reader opened besides. */
  fold(opened: [number, number][]): [number, number][] {
    const rows = this.rows;
    const shown = foldRanges(
      rows.length,
      (r) => rows[r].op !== 'same',
      (r) => this.token(r).type === 'heading',
      CONTEXT,
    );
    return joinRanges(shown, opened);
  }

  /** Lines of the new version rows [from, to) span (the lines of a gap: rows kept, on both sides). */
  lines(from: number, to: number): number {
    let first = 0;
    let last = 0;
    for (let k = from; k < to; k++) {
      const n = this.rows[k].n;
      if (n < 0) continue;
      if (!first) first = this.b.lines[n][0];
      last = this.b.lines[n][1];
    }
    return first ? last - first + 1 : 0;
  }

  /** Blocks to show to reveal row k in gap [from, to): all of a short gap, else from k to the next heading (a few at most). */
  span = (k: number, [from, to]: [number, number]): [number, number] => {
    if (to - from <= 2 * STEP) return [from, to];
    let end = k + 1;
    while (end < Math.min(to, k + STEP) && this.token(end).type !== 'heading') end++;
    return [k, end];
  };

  /** Builds row k: a block kept, added, removed, or edited (one block showing the edits, or the two). */
  build(k: number, dom: DomBuilder): HTMLElement | null {
    const r = this.rows[k];
    const say = (e: HTMLElement | null, n: number, o: number) => {
      if (e && n >= 0) e.dataset.line = String(this.b.line(n));
      if (e && o >= 0) e.dataset.oldLine = String(this.a.line(o));
      return e;
    };
    if (r.op !== 'mod') {
      const t = this.token(k);
      if (r.op !== 'same') this.marks.marks.set(t, { op: r.op });
      return say(dom.block(t), r.n, r.o);
    }
    const out = mergeBlock(this.a.token(r.o), this.b.token(r.n), this.marks, { line: this.b.line(r.n), old: this.a.line(r.o) });
    if (out.length === 1) return say(dom.block(out[0]), r.n, r.o);
    const pair = document.createElement('div');
    pair.className = 'md-pair';
    for (const [t, n, o] of [
      [out[0], -1, r.o],
      [out[1], r.n, -1],
    ] as const) {
      const e = say(dom.block(t), n, o);
      if (e) pair.append(e);
    }
    return pair;
  }

  /** Marks what a block, list item or table row built is: added, removed or edited, and where. */
  each = (t: object, el: HTMLElement) => {
    const m = this.marks.marks.get(t);
    if (!m) return;
    if (m.op !== 'same') el.classList.add(`md-${m.op}`);
    if (m.line) el.dataset.line = String(m.line);
    if (m.old) el.dataset.oldLine = String(m.old);
    if (m.num !== undefined && el instanceof HTMLLIElement) el.value = m.num;
  };

  /** Words removed and added, as `<del>` and `<ins>`. */
  inline = (t: Token, into: Node, spans: (list: Token[], into: Node) => void): boolean => {
    if (t.type !== 'diff') return false;
    const e = document.createElement((t as DiffSpan).op === '+' ? 'ins' : 'del');
    e.className = 'md-w';
    spans(t.tokens!, e);
    into.appendChild(e);
    return true;
  };

  /** The gap standing for rows [from, to), its arrows opening it (`show`) as the code diff's do. */
  gap(from: number, to: number, show: (from: number, to: number) => void): HTMLElement {
    const n = to - from;
    const lines = this.lines(from, to);
    const e = document.createElement('div');
    e.className = 'md-gap';
    if (from === 0) e.classList.add('first');
    if (to >= this.rows.length) e.classList.add('last');
    const r = this.rows[from];
    if (r?.n >= 0) e.dataset.line = String(this.b.line(r.n));
    if (r?.o >= 0) e.dataset.oldLine = String(this.a.line(r.o));
    const arrows = document.createElement('span');
    arrows.className = 'md-xp';
    const button = (dir: string, label: string, glyph: Parameters<typeof icon>[0], from: number, to: number) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.dir = dir;
      b.setAttribute('aria-label', label);
      tooltip(b, label);
      b.append(icon(glyph));
      b.onclick = () => show(from, to);
      arrows.append(b);
    };
    const blocks = (k: number) => `${k} ${k === 1 ? 'block' : 'blocks'}`;
    if (n <= STEP) button('all', `Show ${blocks(n)} hidden`, ArrowsOutLineVerticalRegular, from, to);
    else {
      // Opened downwards from the blocks above it, or from the top when it's all there is.
      if (from > 0 || to >= this.rows.length) button('down', from > 0 ? `Show ${blocks(STEP)} more below the ones above` : `Show ${blocks(STEP)} more`, ArrowLineDownRegular, from, from + STEP);
      if (to < this.rows.length) button('up', `Show ${blocks(STEP)} more above`, ArrowLineUpRegular, to - STEP, to);
    }
    const what = document.createElement('span');
    what.className = 'md-gap-text';
    what.textContent = `${n} unchanged ${n === 1 ? 'block' : 'blocks'} · ${lines} ${lines === 1 ? 'line' : 'lines'}`;
    e.append(arrows, what);
    return e;
  }
}
