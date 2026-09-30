// A file's hunks flattened into rows (hunk headers and lines), in typed arrays so a
// 100k-line file costs a few allocations rather than 100k objects.

import type { HunkData } from '../../shared/types.ts';

export const HUNK = 0;
export const CONTEXT = 1;
export const ADDED = 2;
export const REMOVED = 3;

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
}

export function buildRows(hunks: HunkData[]): FileRows {
  const count = hunks.reduce((n, h) => n + h.text.length + 1, 0);
  const rows: FileRows = {
    hunks,
    kind: new Uint8Array(count),
    text: new Array(count),
    o: new Uint32Array(count),
    n: new Uint32Array(count),
    ci: new Int32Array(count).fill(-1),
    eof: new Uint8Array(count),
  };
  let r = 0;
  let change = 0;
  for (const h of hunks) {
    rows.kind[r] = HUNK;
    rows.text[r++] = h.header;
    let o = h.oldStart;
    let n = h.newStart;
    const eof = new Set(h.eof);
    for (let k = 0; k < h.text.length; k++, r++) {
      rows.text[r] = h.text[k];
      if (eof.has(k)) rows.eof[r] = 1;
      const t = h.types[k];
      if (t === '+') {
        rows.kind[r] = ADDED;
        rows.n[r] = n++;
        rows.ci[r] = change++;
      } else if (t === '-') {
        rows.kind[r] = REMOVED;
        rows.o[r] = o++;
        rows.ci[r] = change++;
      } else {
        rows.kind[r] = CONTEXT;
        rows.o[r] = o++;
        rows.n[r] = n++;
      }
    }
  }
  return rows;
}
