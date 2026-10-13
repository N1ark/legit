// Wrapped lines: how many rows a line takes when the diff wraps at `cols` columns. The code
// breaks anywhere (CSS `word-break: break-all`), so for a monospaced font this is exact and the
// layout stays known without measuring anything.

import { type FileRows, isHead } from './rows.ts';

/** Rows `text` takes wrapped at `cols` columns (tabs to the next multiple of 4), at least 1. */
export function wrappedRows(text: string, cols: number): number {
  if (cols <= 0 || text.length <= cols && !text.includes('\t')) return 1;
  let rows = 1;
  let col = 0;
  for (const ch of text) {
    let w = ch === '\t' ? 4 - (col % 4) : 1;
    if (col + w > cols && col > 0) {
      rows++;
      col = 0;
      if (ch === '\t') w = 4;
    }
    col += w;
  }
  return rows;
}

/** Each row's first visual row in the file (headers never wrap), plus the total at the end. */
export function wrappedOffsets(rows: FileRows, cols: number): Uint32Array {
  const out = new Uint32Array(rows.kind.length + 1);
  for (let r = 0; r < rows.kind.length; r++) out[r + 1] = out[r] + (isHead(rows.kind[r]) ? 1 : wrappedRows(rows.text[r], cols));
  return out;
}
