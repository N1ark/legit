// Keeping the reader's place when a file switches between its diff and its rendered view: both
// sides are mapped to a position in the file's text, a line number with a fraction (how far into
// the line, or into a rendered block's share of lines).
//
// The rendered side is a list of knots, (y, line) points read off its layout: each block's top at
// the first line it shows (`data-line`), plus finer ones inside blocks whose lines are known (a code
// block's code, a table's rows). Between knots, lines and pixels go along proportionally.

import { type FileRows, REMOVED, TAIL, isHead } from './rows.ts';

/** A place in a file's text: `line` (1-based, with a fraction) on the side shown rendered; `old`, on the
 *  old side, for a place only that side has (a removed line), which a view showing removed blocks can find. */
export interface Anchor {
  line: number;
  old?: number;
}

/** A point of a rendered file's layout: `y` (px from its top) shows line `line`; `old` where it shows a removed one. */
export interface Knot {
  y: number;
  line: number;
  old?: number;
}

/** The place row r of `rows` shows, `frac` of the way down it; `side` is the side shown rendered (old for a deleted file). */
export function rowAnchor(rows: FileRows, r: number, frac: number, side: 'old' | 'new' = 'new'): Anchor {
  const num = side === 'old' ? rows.o : rows.n;
  const count = rows.kind.length;
  if (r >= count) return { line: lastLine(num) + 1 };
  r = Math.max(0, r);
  const kind = rows.kind[r];
  if (!isHead(kind) && num[r]) return { line: num[r] + Math.min(1, Math.max(0, frac)) };
  // A header leads into its hunk, a removed line sits before the next line kept: the first one shown below, in its hunk.
  let line = 0;
  for (let k = isHead(kind) ? r + 1 : r; k < count && !isHead(rows.kind[k]) && !line; k++) line = num[k];
  for (let k = r - 1; k >= 0 && !line; k--) if (num[k]) line = num[k] + 1;
  const out: Anchor = { line: line || 1 };
  if (side === 'new' && kind === REMOVED) out.old = rows.o[r] + Math.min(1, Math.max(0, frac));
  return out;
}

function lastLine(num: Uint32Array): number {
  for (let k = num.length - 1; k >= 0; k--) if (num[k]) return num[k];
  return 0;
}

/**
 * The row showing place `a`, and how far down it: the line's own row; for a line hidden between
 * hunks, the header of the gap it's in (after the last hunk, the row showing there are more).
 */
export function rowOfAnchor(rows: FileRows, a: Anchor, side: 'old' | 'new' = 'new'): { r: number; frac: number } {
  const count = rows.kind.length;
  if (!count) return { r: 0, frac: 0 };
  if (side === 'new' && a.old !== undefined) {
    const m = Math.floor(a.old);
    for (let r = 0; r < count; r++) if (rows.kind[r] === REMOVED && rows.o[r] === m) return { r, frac: a.old - m };
  }
  const num = side === 'old' ? rows.o : rows.n;
  const l = Math.max(1, Math.floor(a.line));
  const frac = Math.max(0, a.line - l);
  let r = 0;
  while (r < count && (isHead(rows.kind[r]) || num[r] < l)) r++;
  if (r === count) {
    const end = count - 1;
    return rows.kind[end] === TAIL ? { r: end, frac: 0 } : { r: end, frac: 1 };
  }
  if (num[r] === l) return { r, frac: Math.min(1, frac) };
  for (let k = r - 1; k >= 0 && !num[k]; k--) if (isHead(rows.kind[k])) return { r: k, frac: 0 };
  return { r, frac: 0 };
}

/** Knots in order, keeping only those going down the layout and the text together, then the end: `height` at line `end`. */
export function knotList(points: readonly Knot[], height: number, end: number): Knot[] {
  const out: Knot[] = [];
  for (const p of [...points, { y: height, line: end }]) {
    const last = out[out.length - 1];
    if (last && (p.y < last.y || p.line < last.line)) continue;
    if (last && p.y === last.y && p.line === last.line && p.old === last.old) continue;
    out.push(p);
  }
  return out;
}

/** The place at `y` in a rendered file laid out as `knots`. */
export function anchorAt(knots: readonly Knot[], y: number): Anchor {
  if (!knots.length) return { line: 1 };
  if (y <= knots[0].y) return { line: knots[0].line };
  for (let k = 0; k + 1 < knots.length; k++) {
    const a = knots[k];
    const b = knots[k + 1];
    if (y >= b.y) continue;
    const t = (y - a.y) / (b.y - a.y);
    const out: Anchor = { line: a.line + t * (b.line - a.line) };
    if (a.old !== undefined && b.old !== undefined) out.old = a.old + t * (b.old - a.old);
    return out;
  }
  return { line: knots[knots.length - 1].line };
}

/**
 * Where place `a` is in a rendered file laid out as `knots`: within the block showing its line (the
 * last knot at or before it), as far down as the line is into the block's lines; a removed line,
 * in the removed block showing it, when there is one.
 */
export function yOf(knots: readonly Knot[], a: Anchor): number {
  if (!knots.length) return 0;
  if (a.old !== undefined) {
    for (let k = 0; k + 1 < knots.length; k++) {
      const p = knots[k];
      const q = knots[k + 1];
      if (p.old === undefined || q.old === undefined || a.old < p.old || a.old >= q.old) continue;
      return p.y + ((a.old - p.old) / (q.old - p.old)) * (q.y - p.y);
    }
  }
  if (a.line <= knots[0].line) return knots[0].y;
  for (let k = 0; k + 1 < knots.length; k++) {
    const p = knots[k];
    const q = knots[k + 1];
    if (a.line < p.line || a.line >= q.line) continue;
    return p.y + ((a.line - p.line) / (q.line - p.line)) * (q.y - p.y);
  }
  return knots[knots.length - 1].y;
}

/** Offsets where each line of `text` starts (line l at [l - 1]). */
export function lineStarts(text: string): Uint32Array {
  let n = 1;
  for (let k = text.indexOf('\n'); k >= 0; k = text.indexOf('\n', k + 1)) n++;
  const out = new Uint32Array(n);
  let l = 1;
  for (let k = text.indexOf('\n'); k >= 0; k = text.indexOf('\n', k + 1)) out[l++] = k + 1;
  return out;
}

let starts: { text: string; at: Uint32Array } | null = null;

/**
 * The knots of a rendered file (`el`, showing `text`), from its elements' `data-line` (and a removed
 * block's `data-old-line`): a fenced code block's code starts the line after its fence, a markdown
 * table's rows are a line each, as a CSV row is (a gap row after one, rows not shown, stands for the lines after it).
 * A code block or table whose lines or rows say their own lines (a diff's) is read by those.
 */
export function readKnots(el: HTMLElement, text: string): Knot[] {
  if (starts?.text !== text) starts = { text, at: lineStarts(text) };
  const at = starts.at;
  const lines = text.endsWith('\n') ? at.length - 1 : at.length;
  const top = el.getBoundingClientRect().top;
  const points: Knot[] = [];
  const point = (e: Element, line: number, old?: number, dy = 0) => {
    const p: Knot = { y: e.getBoundingClientRect().top - top + dy, line };
    if (old !== undefined) p.old = old;
    points.push(p);
  };
  for (const e of el.querySelectorAll<HTMLElement>('[data-line], [data-old-line]')) {
    // A removed block (only the old side has it) sits before the line after it: the line above ends where it starts.
    const line = e.dataset.line ? Number(e.dataset.line) : NaN;
    const old = e.dataset.oldLine === undefined ? undefined : Number(e.dataset.oldLine);
    point(e, line, old);
    const own = (e.tagName === 'PRE' || e.tagName === 'TABLE') && e.querySelector('[data-line], [data-old-line]');
    if (own) continue;
    if (e.tagName === 'PRE' && e.dataset.line) {
      const code = e.textContent ?? '';
      let n = 1;
      for (let k = code.indexOf('\n'); k >= 0; k = code.indexOf('\n', k + 1)) n++;
      const fenced = /^\s{0,3}(```|~~~)/.test(text.slice(at[line - 1], at[line] ?? text.length));
      const s = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      const first = line + (fenced ? 1 : 0);
      point(e, first, undefined, parseFloat(s.paddingTop) + parseFloat(s.borderTopWidth));
      point(e, first + n, undefined, r.height - parseFloat(s.paddingBottom) - parseFloat(s.borderBottomWidth));
    } else if (e.tagName === 'TABLE' && e.dataset.line) {
      const rows = e.querySelectorAll(':scope > tbody > tr');
      rows.forEach((tr, j) => point(tr, line + 2 + j));
      // Its last row ends at its own last line, not with the blank lines after the table.
      const last = rows[rows.length - 1];
      if (last) point(last, line + 2 + rows.length, undefined, last.getBoundingClientRect().height);
    } else if (e.tagName === 'TR' && e.dataset.line) {
      for (let g = e.nextElementSibling; g && !g.hasAttribute('data-line'); g = g.nextElementSibling) point(g, line + 1);
      if (!e.nextElementSibling) point(e, line + 1, undefined, e.getBoundingClientRect().height);
    }
  }
  for (let k = points.length - 1, next = lines + 1; k >= 0; k--) {
    if (Number.isNaN(points[k].line)) points[k].line = next;
    next = points[k].line;
  }
  return knotList(points, el.getBoundingClientRect().height, lines + 1);
}
