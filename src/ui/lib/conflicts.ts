// Where a conflicted file's conflicts are, row by row: git's markers and the sides between them.

import type { RowsLike } from './gh-threads.ts';

export const NONE = 0;
/** `<<<<<<<`, `|||||||`, `=======` and `>>>>>>>` lines. */
export const MARKER = 1;
/** Above `|||||||` (or `=======`): the side merged into. */
export const OURS = 2;
/** Between `|||||||` and `=======` (diff3): what both sides started from. */
export const BASE = 3;
/** Below `=======`: the side merged in. */
export const THEIRS = 4;

const OPEN = /^<{7}(?: |$)/;
const BASE_LINE = /^\|{7}(?: |$)/;
const SPLIT = /^={7}$/;
const CLOSE = /^>{7}(?: |$)/;

// lib/rows.ts's header kinds, repeated so this stays a leaf.
const isHead = (k: number) => k === 0 || k === 4;

/**
 * Each row's part in a conflict (`NONE` outside one). Lines of the file only: removed lines and
 * headers are `NONE`, and a conflict goes on across a folded gap (a long side of it unchanged).
 */
export function conflictRoles(rows: RowsLike): Uint8Array {
  const out = new Uint8Array(rows.kind.length);
  let side = NONE;
  for (let r = 0; r < rows.kind.length; r++) {
    if (isHead(rows.kind[r]) || !rows.n[r]) continue;
    const t = rows.text[r].replace(/\r$/, '');
    if (OPEN.test(t)) {
      side = OURS;
      out[r] = MARKER;
    } else if (side === NONE) continue;
    else if (BASE_LINE.test(t) && side === OURS) {
      side = BASE;
      out[r] = MARKER;
    } else if (SPLIT.test(t) && side !== THEIRS) {
      side = THEIRS;
      out[r] = MARKER;
    } else if (CLOSE.test(t) && side === THEIRS) {
      side = NONE;
      out[r] = MARKER;
    } else out[r] = side;
  }
  return out;
}
