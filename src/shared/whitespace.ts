// Changes that only touch whitespace: a removed line and an added one that read the same once
// whitespace is ignored (as `git diff -w`), shown as one unchanged line when whitespace is hidden.

/** A line's text without whitespace (ASCII only, as git's: a byte of a UTF-8 character is never one). */
export const bare = (s: string) => s.replace(/[ \t\n\v\f\r]+/g, '');

/** Above this many cells, matching is greedy instead of a longest common subsequence. */
const LCS_CELLS = 1 << 20;

/** Index pairs [a, b] of equal keys, in order in both lists: as many as can be (or, for huge lists, greedily). */
export function matchKeys(a: string[], b: string[]): [number, number][] {
  const m = a.length;
  const n = b.length;
  const out: [number, number][] = [];
  if (!m || !n) return out;
  if (m * n > LCS_CELLS) {
    const at = new Map<string, number[]>();
    for (let j = n - 1; j >= 0; j--) (at.get(b[j]) ?? at.set(b[j], []).get(b[j])!).push(j);
    let last = -1;
    for (let i = 0; i < m; i++) {
      const js = at.get(a[i]);
      while (js?.length && js[js.length - 1] <= last) js.pop();
      if (js?.length) out.push([i, (last = js.pop()!)]);
    }
    return out;
  }
  // A common start pairs up as the walk below would take it, without a table (a reindented block is all start).
  let s = 0;
  for (; s < m && s < n && a[s] === b[s]; s++) out.push([s, s]);
  // len[(i - s) * w + j - s]: the longest common subsequence of a[i..] and b[j..].
  const w = n - s + 1;
  const len = new Uint32Array(s < m && s < n ? (m - s + 1) * w : 0);
  for (let i = m - 1; i >= s; i--) {
    for (let j = n - 1; j >= s; j--) {
      const k = (i - s) * w + j - s;
      len[k] = a[i] === b[j] ? len[k + w + 1] + 1 : Math.max(len[k + w], len[k + 1]);
    }
  }
  for (let i = s, j = s; i < m && j < n; ) {
    const k = (i - s) * w + j - s;
    if (a[i] === b[j]) out.push([i++, j++]);
    else if (len[k + w] >= len[k + 1]) i++;
    else j++;
  }
  return out;
}

/**
 * A hunk's whitespace-only changes (`types` of ' ', '+', '-', and its lines): in each run of
 * changed lines, removed line → the added line it equals but for whitespace (positions in the
 * hunk). Lines that differ in a missing newline at the end of the file never pair.
 */
export function whitespacePairs(types: string, text: string[], noNewline: (k: number) => boolean): Map<number, number> {
  const out = new Map<number, number>();
  for (let k = 0; k < types.length; ) {
    if (types[k] === ' ') {
      k++;
      continue;
    }
    const removed: number[] = [];
    const added: number[] = [];
    for (; k < types.length && types[k] !== ' '; k++) (types[k] === '-' ? removed : added).push(k);
    if (!removed.length || !added.length) continue;
    const key = (j: number) => bare(text[j]) + (noNewline(j) ? '\n' : '');
    for (const [a, b] of matchKeys(removed.map(key), added.map(key))) out.set(removed[a], added[b]);
  }
  return out;
}
