// Side by side, each run of changed lines shows its removed lines beside its added ones: a line
// beside the one it was edited into, the lines between such pairs row by row. ui/lib/side-by-side.ts
// lays files out so; the diff's summary counts the rows it saves.

import { pairLines } from './line-pairs.ts';

/** The rows side by side of `removed` lines beside `added` ones: [removed, added] indices, -1 for a filler. */
export function sideRows(removed: string[], added: string[]): [number, number][] {
  const out: [number, number][] = [];
  let a = 0;
  let b = 0;
  const upTo = (x: number, y: number) => {
    while (a < x || b < y) out.push([a < x ? a++ : -1, b < y ? b++ : -1]);
  };
  for (const [x, y] of pairLines(removed, added)) {
    upTo(x, y);
    out.push([a++, b++]);
  }
  upTo(removed.length, added.length);
  return out;
}

/**
 * Rows a hunk (`types` of ' ', '+', '-', and its lines) takes fewer side by side than one above the
 * other. With `pairs` (whitespace hidden: removed line → the added one shown with it as one row, see
 * whitespacePairs), each pair is a row of its own, and the lines between pairs are laid out apart.
 */
export function pairedRows(types: string, text: string[], pairs?: Map<number, number> | null): number {
  let saved = 0;
  const paired = new Set(pairs?.values() ?? []);
  const lines = (t: string, from: number, to: number) => {
    const out: string[] = [];
    for (let k = from; k < to; k++) if (types[k] === t && !(t === '+' && paired.has(k))) out.push(text[k]);
    return out;
  };
  const apart = (removed: string[], added: string[]) => {
    if (removed.length && added.length) saved += removed.length + added.length - sideRows(removed, added).length;
  };
  for (let j = 0; j < types.length; ) {
    if (types[j] === ' ') {
      j++;
      continue;
    }
    let end = j;
    while (end < types.length && types[end] !== ' ') end++;
    // As lib/rows.ts lays a run out around its pairs: the removed lines before each, then the added ones.
    let a = j;
    let b = j;
    for (let p = j; p < end; p++) {
      const d = pairs?.get(p);
      if (d === undefined) continue;
      apart(lines('-', a, p), lines('+', b, d));
      a = p + 1;
      b = d + 1;
    }
    apart(lines('-', a, end), lines('+', b, end));
    j = end;
  }
  return saved;
}
