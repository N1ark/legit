// A file's hunks flattened into rows (hunk headers and lines), in typed arrays so a
// 100k-line file costs a few allocations rather than 100k objects.
//
// The unchanged lines between hunks (gaps) can be shown too: gap k is before hunk k, and gap
// hunks.length after the last one. A gap's lines show from its top (continuing the hunk above,
// before the header) and from its bottom (leading into the hunk below, after it). Once a gap is
// all shown its header goes, joining the hunks, except the first one's.

import { moreAfter } from '../../shared/context.ts';
import type { FileLines, HunkData } from '../../shared/types.ts';

export const HUNK = 0;
export const CONTEXT = 1;
export const ADDED = 2;
export const REMOVED = 3;
/** After the last hunk, while the file may go on: shows more of it. */
export const TAIL = 4;

/** Header rows: a hunk's, or the one after the last hunk. */
export const isHead = (kind: number) => kind === HUNK || kind === TAIL;

export interface Gap {
  /** Old line numbers [start, end]; end is null after the last hunk until the file is loaded. */
  start: number;
  end: number | null;
  /** New line number minus old one, in this gap. */
  delta: number;
}

/** Lines shown of each gap, and the old file they come from. */
export interface Expansion {
  file: FileLines | null;
  top: number[];
  bottom: number[];
}

/** Highlighting: per-row runs of [length, class id]; row r spans data[offsets[r]..offsets[r+1]). */
export interface Tokens {
  classes: string[];
  offsets: Uint32Array;
  data: Uint32Array;
}

export interface FileRows {
  hunks: HunkData[];
  kind: Uint8Array;
  text: string[];
  /** Old / new line numbers, 0 when absent. */
  o: Uint32Array;
  n: Uint32Array;
  /** Change index (the split selection's unit) of '+'/'-' rows, else -1. */
  ci: Int32Array;
  eof: Uint8Array;
  /** The gap a header row opens onto, else -1. */
  gap: Int32Array;
  /** Every gap, when the file's other lines can be shown (else empty), and its lines not shown yet. */
  gaps: Gap[];
  hidden: (number | null)[];
}

export const noExpansion = (): Expansion => ({ file: null, top: [], bottom: [] });

/** Lines of gap g not shown yet; null while unknown (after the last hunk, before loading). */
function hiddenIn(g: Gap | undefined, top: number, bottom: number): number | null {
  if (!g) return 0;
  if (g.end === null) return null;
  return Math.max(0, g.end - g.start + 1 - top - bottom);
}

function gapsOf(hunks: HunkData[], file: FileLines | null): Gap[] {
  const gaps: Gap[] = [];
  let oldNext = 1;
  let newNext = 1;
  for (const h of hunks) {
    let oc = 0;
    let nc = 0;
    for (const t of h.types) {
      if (t !== '+') oc++;
      if (t !== '-') nc++;
    }
    // A hunk with no lines on a side sits after line start, rather than at it.
    const oldFirst = oc ? h.oldStart : h.oldStart + 1;
    const newFirst = nc ? h.newStart : h.newStart + 1;
    gaps.push({ start: oldNext, end: oldFirst - 1, delta: newFirst - oldFirst });
    oldNext = oldFirst + oc;
    newNext = newFirst + nc;
  }
  const last = hunks[hunks.length - 1];
  const more = !!last && moreAfter(last.types, last.eof.includes(last.types.length - 1));
  gaps.push({ start: oldNext, end: !more ? oldNext - 1 : file ? file.lines.length : null, delta: newNext - oldNext });
  return gaps;
}

/** The file's rows: `expandable` when its other lines can be shown, with `x` of them shown. */
export function buildRows(hunks: HunkData[], expandable = false, x: Expansion = noExpansion()): FileRows {
  const gaps = expandable && hunks.length ? gapsOf(hunks, x.file) : [];
  const kind: number[] = [];
  const text: string[] = [];
  const o: number[] = [];
  const n: number[] = [];
  const ci: number[] = [];
  const eof: number[] = [];
  const gap: number[] = [];
  const push = (k: number, s: string, on: number, nn: number, c = -1, e = 0, g = -1) => {
    kind.push(k);
    text.push(s);
    o.push(on);
    n.push(nn);
    ci.push(c);
    eof.push(e);
    gap.push(g);
  };
  const shown = (g: Gap, from: number, to: number) => {
    const lines = x.file!.lines;
    for (let l = from; l <= to; l++) push(CONTEXT, lines[l - 1], l, l + g.delta, -1, +(l === lines.length && x.file!.noNewline));
  };
  const hidden = gaps.map((g, k) => hiddenIn(g, x.top[k] ?? 0, x.bottom[k] ?? 0));
  let change = 0;
  for (let k = 0; k <= hunks.length; k++) {
    const g = gaps[k];
    const top = x.top[k] ?? 0;
    const bottom = x.bottom[k] ?? 0;
    if (g && top) shown(g, g.start, g.start + top - 1);
    const left = gaps.length ? hidden[k] : 0;
    if (k === hunks.length) {
      if (left !== 0) push(TAIL, '', 0, 0, -1, 0, k);
      break;
    }
    const h = hunks[k];
    if (!g || k === 0 || left !== 0) push(HUNK, h.header, 0, 0, -1, 0, g ? k : -1);
    if (g && bottom) shown(g, g.end! - bottom + 1, g.end!);
    let ol = h.oldStart;
    let nl = h.newStart;
    const ends = new Set(h.eof);
    for (let j = 0; j < h.text.length; j++) {
      const t = h.types[j];
      const e = +ends.has(j);
      if (t === '+') push(ADDED, h.text[j], 0, nl++, change++, e);
      else if (t === '-') push(REMOVED, h.text[j], ol++, 0, change++, e);
      else push(CONTEXT, h.text[j], ol++, nl++, -1, e);
    }
  }
  return {
    hunks,
    kind: Uint8Array.from(kind),
    text,
    o: Uint32Array.from(o),
    n: Uint32Array.from(n),
    ci: Int32Array.from(ci),
    eof: Uint8Array.from(eof),
    gap: Int32Array.from(gap),
    gaps,
    hidden,
  };
}

/** The rows as hunks (a header row, then lines) for the highlighter, which works row for row. */
export function rowHunks(rows: FileRows): HunkData[] {
  const out: HunkData[] = [];
  for (let r = 0; r < rows.kind.length; r++) {
    if (isHead(rows.kind[r])) {
      out.push({ header: rows.text[r], oldStart: 0, newStart: 0, types: '', text: [], eof: [] });
      continue;
    }
    const h = out[out.length - 1];
    h.types += rows.kind[r] === ADDED ? '+' : rows.kind[r] === REMOVED ? '-' : ' ';
    h.text.push(rows.text[r]);
  }
  return out;
}

const lineKey = (rows: FileRows, r: number) => `${rows.o[r]},${rows.n[r]}`;

/** Where each line is in `to`, for the rows of `from` (the same file, with more or less shown). */
export function rowMap(from: FileRows, to: FileRows): Int32Array {
  const at = new Map<string, number>();
  for (let r = 0; r < to.kind.length; r++) if (!isHead(to.kind[r])) at.set(lineKey(to, r), r);
  return Int32Array.from(from.kind, (k, r) => (isHead(k) ? -1 : (at.get(lineKey(from, r)) ?? -1)));
}

/** Highlighting of `from`'s rows moved to theirs in `to`, rows new in `to` left plain. */
export function moveTokens(t: Tokens, from: FileRows, to: FileRows): Tokens {
  const map = rowMap(from, to);
  const runs: (Uint32Array | null)[] = new Array(to.kind.length).fill(null);
  map.forEach((r, k) => {
    if (r >= 0) runs[r] = t.data.subarray(t.offsets[k], t.offsets[k + 1]);
  });
  const offsets = new Uint32Array(to.kind.length + 1);
  let len = 0;
  runs.forEach((d, r) => {
    offsets[r] = len;
    len += d?.length ?? 0;
  });
  offsets[to.kind.length] = len;
  const data = new Uint32Array(len);
  runs.forEach((d, r) => d && data.set(d, offsets[r]));
  return { classes: t.classes, offsets, data };
}
