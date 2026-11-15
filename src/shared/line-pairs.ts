// Which removed lines of a run of changes were edited into which added ones, by the words they
// share: worddiff.ts highlights what changed in each pair, and side by side shows each on one row.

/** Longer lines aren't compared. */
export const MAX_LENGTH = 1000;
/** Below this share of their text in common, two lines are too different to highlight. */
export const MIN_SIMILARITY = 0.5;
/** Blocks of more removed × added lines than this pair by position, and only when the counts match. */
const MAX_CELLS = 400;

const TOKEN = /[\p{L}\p{M}\p{N}_]+|\s+|[^\p{L}\p{M}\p{N}_\s]/gu;
export const SPACE = /^\s/;

/** Words (identifiers, numbers), runs of whitespace, and single punctuation characters. */
export const tokenize = (s: string): string[] => s.match(TOKEN) ?? [];

/** Share of their non-whitespace text two token lists have in common, ignoring order (at least the in-order share). */
export function overlap(a: string[], b: string[]): number {
  const count = new Map<string, number>();
  let total = 0;
  for (const t of a) {
    if (SPACE.test(t)) continue;
    count.set(t, (count.get(t) ?? 0) + 1);
    total += t.length;
  }
  let common = 0;
  for (const t of b) {
    if (SPACE.test(t)) continue;
    total += t.length;
    const n = count.get(t);
    if (n) {
      count.set(t, n - 1);
      common += t.length;
    }
  }
  return total ? (2 * common) / total : 1;
}

/** Index pairs [removed, added] of the lines that were edited into each other, in order. */
export function pairLines(removed: string[], added: string[]): [number, number][] {
  const m = removed.length;
  const n = added.length;
  if (!m || !n) return [];
  if (m * n > MAX_CELLS) return m === n ? removed.map((_, k) => [k, k]) : [];
  const ta = removed.map((s) => (s.length > MAX_LENGTH ? null : tokenize(s)));
  const tb = added.map((s) => (s.length > MAX_LENGTH ? null : tokenize(s)));
  const sim = (i: number, j: number) => {
    const s = ta[i] && tb[j] ? overlap(ta[i]!, tb[j]!) : 0;
    return s >= MIN_SIMILARITY ? s : 0;
  };
  // best[i][j]: the most similarity pairing removed[i..] with added[j..] can have, in order.
  const w = n + 1;
  const best = new Float64Array((m + 1) * w);
  const s = new Float64Array(m * n);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      s[i * n + j] = sim(i, j);
      const pair = s[i * n + j] ? s[i * n + j] + best[(i + 1) * w + j + 1] : 0;
      best[i * w + j] = Math.max(pair, best[(i + 1) * w + j], best[i * w + j + 1]);
    }
  }
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < m && j < n; ) {
    if (s[i * n + j] && best[i * w + j] === s[i * n + j] + best[(i + 1) * w + j + 1]) out.push([i++, j++]);
    else if (best[(i + 1) * w + j] >= best[i * w + j + 1]) i++;
    else j++;
  }
  return out;
}
