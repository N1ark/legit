// What two sequences of ids (blocks, lines, words, each interned as a number) have in common, in order:
// Myers' diff while the sequences are close, else anchored on the ids unique to both (patience), so even a
// rewrite of a big file costs a few milliseconds. Within its budget the result is a longest common subsequence.

/** Steps of Myers' search one call may take, all its parts together. */
const BUDGET = 400_000;
/** Patience anchors nest no deeper than this. */
const DEPTH = 6;

/** Index pairs [i, j], a[i] === b[j], in order on both sides. */
export function commonItems(a: ArrayLike<number>, b: ArrayLike<number>, budget = BUDGET): [number, number][] {
  const out: [number, number][] = [];
  run(a, 0, a.length, b, 0, b.length, { left: budget }, out, 0);
  return out;
}

/** Interns strings as numbers, the same string the same number, for `commonItems`. */
export class Ids {
  private ids = new Map<string, number>();
  of(s: string): number {
    let id = this.ids.get(s);
    if (id === undefined) this.ids.set(s, (id = this.ids.size));
    return id;
  }
}

type Budget = { left: number };

function run(a: ArrayLike<number>, a0: number, a1: number, b: ArrayLike<number>, b0: number, b1: number, budget: Budget, out: [number, number][], depth: number) {
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) out.push([a0++, b0++]);
  let s = 0;
  while (a1 - s > a0 && b1 - s > b0 && a[a1 - 1 - s] === b[b1 - 1 - s]) s++;
  const ea = a1 - s;
  const eb = b1 - s;
  if (a0 < ea && b0 < eb) {
    const found = myers(a, a0, ea, b, b0, eb, budget);
    if (found) for (const p of found) out.push(p);
    else if (depth < DEPTH) patience(a, a0, ea, b, b0, eb, budget, out, depth);
  }
  for (let k = 0; k < s; k++) out.push([ea + k, eb + k]);
}

/** Myers' shortest edit script, as the pairs it keeps; null when it would take more than the budget left. */
function myers(a: ArrayLike<number>, a0: number, a1: number, b: ArrayLike<number>, b0: number, b1: number, budget: Budget): [number, number][] | null {
  const n = a1 - a0;
  const m = b1 - b0;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // V as each round of edits started, for the way back: round d's holds diagonals -d..d.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d, off + d + 1));
    budget.left -= d + 1;
    if (budget.left < 0) return null;
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      const x0 = x;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++;
        y++;
      }
      budget.left -= x - x0;
      v[off + k] = x;
      if (x >= n && y >= m) return back(trace, d, n, m, a0, b0);
    }
  }
  return null;
}

function back(trace: Int32Array[], last: number, n: number, m: number, a0: number, b0: number): [number, number][] {
  const out: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = last; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && v[k - 1 + d] < v[k + 1 + d]);
    const pk = down ? k + 1 : k - 1;
    const px = v[pk + d];
    const sx = down ? px : px + 1;
    while (x > sx && y > sx - k) out.push([a0 + --x, b0 + --y]);
    x = px;
    y = px - pk;
  }
  while (x > 0 && y > 0) out.push([a0 + --x, b0 + --y]);
  return out.reverse();
}

/** Pairs the ids found once on each side, the longest run of them in order on both, then the stretches between them. */
function patience(a: ArrayLike<number>, a0: number, a1: number, b: ArrayLike<number>, b0: number, b1: number, budget: Budget, out: [number, number][], depth: number) {
  const seen = new Map<number, { na: number; nb: number; i: number; j: number }>();
  for (let i = a0; i < a1; i++) {
    const e = seen.get(a[i]);
    if (e) e.na++;
    else seen.set(a[i], { na: 1, nb: 0, i, j: -1 });
  }
  for (let j = b0; j < b1; j++) {
    const e = seen.get(b[j]);
    if (e) {
      e.nb++;
      e.j = j;
    }
  }
  const pairs: [number, number][] = [];
  for (let i = a0; i < a1; i++) {
    const e = seen.get(a[i])!;
    if (e.na === 1 && e.nb === 1) pairs.push([i, e.j]);
  }
  const anchors = increasing(pairs);
  if (!anchors.length) return;
  let pa = a0;
  let pb = b0;
  for (const [i, j] of anchors) {
    run(a, pa, i, b, pb, j, budget, out, depth + 1);
    out.push([i, j]);
    pa = i + 1;
    pb = j + 1;
  }
  run(a, pa, a1, b, pb, b1, budget, out, depth + 1);
}

/** The longest subsequence of `pairs` (in order of their first) whose seconds increase too. */
function increasing(pairs: [number, number][]): [number, number][] {
  const tails: number[] = [];
  const prev = new Int32Array(pairs.length);
  for (let k = 0; k < pairs.length; k++) {
    const j = pairs[k][1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < j) lo = mid + 1;
      else hi = mid;
    }
    prev[k] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = k;
  }
  const out: [number, number][] = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) out.push(pairs[k]);
  return out.reverse();
}
