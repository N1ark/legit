// Word-level highlighting in changed lines, as GitHub and Zed do: a removed line is paired with the
// added line it became, and the words that differ in each get a stronger tint.

import { MAX_LENGTH, MIN_SIMILARITY, SPACE, pairLines, tokenize } from '../../shared/line-pairs.ts';
import { ADDED, type FileRows, REMOVED } from './rows.ts';

export { overlap, pairLines, tokenize } from '../../shared/line-pairs.ts';

/** Lines of more words (and spaces and punctuation) than this aren't compared. */
const MAX_TOKENS = 300;

/** Character ranges [start, end, start, end, ...] of what changed between `a` and `b`, on each side. */
export interface Changed {
  a: number[];
  b: number[];
}

/**
 * What changed between a removed line and the added line it became, word by word; null when the
 * lines are too long or too different to be worth it. `ignoreSpace`: whitespace never counts.
 */
export function changedSpans(a: string, b: string, ignoreSpace = false): Changed | null {
  if (a.length > MAX_LENGTH || b.length > MAX_LENGTH) return null;
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length > MAX_TOKENS || tb.length > MAX_TOKENS) return null;
  // The tokens compared (whitespace left out when it's ignored), and which of them are common.
  const ia = ta.flatMap((t, k) => (ignoreSpace && SPACE.test(t) ? [] : [k]));
  const ib = tb.flatMap((t, k) => (ignoreSpace && SPACE.test(t) ? [] : [k]));
  const sameA = new Uint8Array(ta.length);
  const sameB = new Uint8Array(tb.length);
  let lo = 0;
  while (lo < ia.length && lo < ib.length && ta[ia[lo]] === tb[ib[lo]]) {
    sameA[ia[lo]] = sameB[ib[lo]] = 1;
    lo++;
  }
  let ha = ia.length;
  let hb = ib.length;
  while (ha > lo && hb > lo && ta[ia[ha - 1]] === tb[ib[hb - 1]]) sameA[ia[--ha]] = sameB[ib[--hb]] = 1;
  const m = ha - lo;
  const n = hb - lo;
  if (m && n) {
    const w = n + 1;
    const len = new Uint16Array((m + 1) * w);
    const at = (i: number, j: number) => ta[ia[lo + i]] === tb[ib[lo + j]];
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        len[i * w + j] = at(i, j) ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
      }
    }
    for (let i = 0, j = 0; i < m && j < n; ) {
      if (at(i, j)) sameA[ia[lo + i++]] = sameB[ib[lo + j++]] = 1;
      else if (len[(i + 1) * w + j] >= len[i * w + j + 1]) i++;
      else j++;
    }
  }
  let common = 0;
  let total = 0;
  ta.forEach((t, k) => {
    if (SPACE.test(t)) return;
    total += t.length;
    if (sameA[k]) common += t.length;
  });
  tb.forEach((t, k) => {
    if (!SPACE.test(t)) total += t.length;
  });
  if (!total || (2 * common) / total < MIN_SIMILARITY) return null;
  const out = { a: ranges(ta, sameA, ignoreSpace), b: ranges(tb, sameB, ignoreSpace) };
  return out.a.length || out.b.length ? out : null;
}

/** Ranges of the tokens not in common, joined across the whitespace between them. */
function ranges(tokens: string[], same: Uint8Array, ignoreSpace: boolean): number[] {
  const out: number[] = [];
  let pos = 0;
  let gap = false;
  tokens.forEach((t, k) => {
    const end = pos + t.length;
    if (!same[k] && !(ignoreSpace && SPACE.test(t))) {
      if (out.length && (out[out.length - 1] === pos || gap)) out[out.length - 1] = end;
      else out.push(pos, end);
      gap = false;
    } else if (out.length && out[out.length - 1] === pos && SPACE.test(t)) gap = true;
    else if (!SPACE.test(t)) gap = false;
    pos = end;
  });
  return out;
}

/** `segs` (runs of a line's text) cut at `changed`'s ranges: `w` is true within one. */
export function cutWords<S extends { t: string }>(segs: S[], changed: number[]): (S & { w: boolean })[] {
  const out: (S & { w: boolean })[] = [];
  let pos = 0;
  let k = 0;
  for (const s of segs) {
    let from = 0;
    while (from < s.t.length) {
      const at = pos + from;
      while (k < changed.length && changed[k + 1] <= at) k += 2;
      const inside = k < changed.length && changed[k] <= at;
      const end = inside ? changed[k + 1] : k < changed.length ? changed[k] : Infinity;
      const to = Math.min(s.t.length, end - pos);
      out.push({ ...s, t: s.t.slice(from, to), w: inside });
      from = to;
    }
    pos += s.t.length;
  }
  return out;
}

/**
 * The changed ranges of a file's rows (null for none), worked out as rows are asked for: each run
 * of changed rows is paired when one of its rows first is, each pair compared when it first is.
 */
export function wordDiff(rows: FileRows): (r: number) => number[] | null {
  const partner = new Map<number, number>();
  const spans = new Map<number, number[] | null>();
  const changed = (r: number) => rows.kind[r] === ADDED || rows.kind[r] === REMOVED;

  function pairRun(r: number) {
    let a = r;
    let b = r;
    while (a > 0 && changed(a - 1)) a--;
    while (b + 1 < rows.kind.length && changed(b + 1)) b++;
    const removed: number[] = [];
    const added: number[] = [];
    for (let k = a; k <= b; k++) {
      (rows.kind[k] === REMOVED ? removed : added).push(k);
      partner.set(k, -1);
    }
    const text = (k: number) => rows.text[k];
    for (const [x, y] of pairLines(removed.map(text), added.map(text))) {
      partner.set(removed[x], added[y]);
      partner.set(added[y], removed[x]);
    }
  }

  return (r) => {
    if (!changed(r)) return null;
    if (!partner.has(r)) pairRun(r);
    const p = partner.get(r)!;
    if (p < 0) return null;
    if (!spans.has(r)) {
      const [o, n] = rows.kind[r] === REMOVED ? [r, p] : [p, r];
      const d = changedSpans(rows.text[o], rows.text[n], rows.ws);
      spans.set(o, d?.a.length ? d.a : null);
      spans.set(n, d?.b.length ? d.b : null);
    }
    return spans.get(r)!;
  };
}
