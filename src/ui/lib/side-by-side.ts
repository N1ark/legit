// A file's rows side by side: old on the left, new on the right. Headers, unchanged lines (and
// whitespace-only changes shown as one) are on both sides; in each run of changed lines between
// them, a removed line sits beside the added line it was edited into, and the lines between such
// pairs row by row, the shorter side padded (shared/side-by-side.ts). Rows keep their index in the
// FileRows, so picking, threads, highlighting and ⌘F work as they do above one another: only
// where they're drawn changes.

import { sideRows } from '../../shared/side-by-side.ts';
import { ADDED, type FileRows, REMOVED, isHead } from './rows.ts';
import { changedSpans } from './worddiff.ts';
import { wrappedRows } from './wrap.ts';

export interface SideBySide {
  /** The row (of the FileRows) on each side of each row side by side, -1 for a filler. */
  left: Int32Array;
  right: Int32Array;
  /** The row side by side each row is on. */
  at: Int32Array;
}

export function sideBySide(rows: FileRows): SideBySide {
  const left: number[] = [];
  const right: number[] = [];
  const at = new Int32Array(rows.kind.length);
  let removed: number[] = [];
  let added: number[] = [];
  const pairUp = () => {
    const text = (k: number) => rows.text[k];
    const paired = removed.length && added.length ? sideRows(removed.map(text), added.map(text)) : null;
    for (let k = 0; k < (paired?.length ?? removed.length + added.length); k++) {
      const [x, y] = paired?.[k] ?? [k < removed.length ? k : -1, k < removed.length ? -1 : k];
      const [l, r] = [x < 0 ? -1 : removed[x], y < 0 ? -1 : added[y]];
      if (l >= 0) at[l] = left.length;
      if (r >= 0) at[r] = left.length;
      left.push(l);
      right.push(r);
    }
    removed = [];
    added = [];
  };
  for (let r = 0; r < rows.kind.length; r++) {
    const k = rows.kind[r];
    if (k === REMOVED) removed.push(r);
    else if (k === ADDED) added.push(r);
    else {
      pairUp();
      at[r] = left.length;
      left.push(r);
      right.push(r);
    }
  }
  pairUp();
  return { left: Int32Array.from(left), right: Int32Array.from(right), at };
}

/** A row of the FileRows shown on row s side by side: the left one, else the right one. */
export const rowOn = (s: SideBySide, v: number) => (s.left[v] >= 0 ? s.left[v] : s.right[v]);

/** Each row's first visual row side by side when lines wrap at `cols` (each side's), plus the total: a row is as tall as its taller side. */
export function sideOffsets(rows: FileRows, s: SideBySide, cols: number): Uint32Array {
  const out = new Uint32Array(s.left.length + 1);
  const span = (r: number) => (r < 0 || isHead(rows.kind[r]) ? 1 : wrappedRows(rows.text[r], cols));
  for (let v = 0; v < s.left.length; v++) {
    const [l, r] = [s.left[v], s.right[v]];
    out[v + 1] = out[v] + (l === r ? span(l) : Math.max(span(l), span(r)));
  }
  return out;
}

/** The changed ranges of the rows (null for none): a removed line's against the added line beside it, worked out as rows are asked for. */
export function sideWords(rows: FileRows, s: SideBySide): (r: number) => number[] | null {
  const spans = new Map<number, number[] | null>();
  return (r) => {
    if (rows.kind[r] !== ADDED && rows.kind[r] !== REMOVED) return null;
    if (!spans.has(r)) {
      const [o, n] = [s.left[s.at[r]], s.right[s.at[r]]];
      if (o < 0 || n < 0) return null;
      const d = changedSpans(rows.text[o], rows.text[n], rows.ws);
      spans.set(o, d?.a.length ? d.a : null);
      spans.set(n, d?.b.length ? d.b : null);
    }
    return spans.get(r)!;
  };
}

/** Blocks under rows (review threads, comments being written) under the rows side by side that show those rows, in order. */
export function sideBlocks<B extends { row: number; start: number }>(blocks: Iterable<B>, s: SideBySide): B[] {
  return [...blocks].map((b) => ({ ...b, row: s.at[b.row], start: s.at[b.row] })).sort((a, b) => a.row - b.row);
}
