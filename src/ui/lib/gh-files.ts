// Keeping track during a review, the pure parts: how many files are viewed.

import type { ViewedState } from '../../shared/gh-files.ts';

/** Of the files shown that are in the pull request, how many are marked viewed (a mark dismissed by a later change doesn't count). */
export function viewedCount(paths: string[], viewed: Record<string, ViewedState>): { viewed: number; total: number } {
  let n = 0;
  let total = 0;
  for (const p of paths) {
    const s = viewed[p];
    if (!s) continue;
    total++;
    if (s === 'VIEWED') n++;
  }
  return { viewed: n, total };
}
