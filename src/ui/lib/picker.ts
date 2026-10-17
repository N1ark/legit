/**
 * Where a filtered picker's keyboard cursor starts: on the best-scoring row (on a tie, one that
 * `opens` something, then the earlier), or on `fallback` when no row has a score.
 */
export function startCursor<T extends { score?: number }>(
  rows: readonly T[],
  opens: (row: T) => boolean = () => true,
  fallback = 0,
): number {
  let best = -1;
  for (let k = 0; k < rows.length; k++) {
    const s = rows[k].score;
    if (s === undefined) continue;
    const b = best < 0 ? undefined : rows[best].score!;
    if (b === undefined || s > b || (s === b && opens(rows[k]) && !opens(rows[best]))) best = k;
  }
  return best >= 0 ? best : Math.min(Math.max(fallback, 0), Math.max(rows.length - 1, 0));
}
