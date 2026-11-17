// Older history loaded by scrolling, kept across a state whose list ends elsewhere along it.

import type { CommitInfo, OlderCommits } from '../../shared/types.ts';

export type Older = { from: string } & OlderCommits;

/**
 * The older history loaded after `base` (`older`), continued from where `next` ends instead, when that's
 * along it: on a long linear history a commit on top (or one dropped) moves where the state's list ends.
 * Null when it can't be carried over.
 */
export function carryOlder(base: CommitInfo[], older: Older | null, next: CommitInfo[]): Older | null {
  const to = next.at(-1);
  if (!older || !to || older.from !== base.at(-1)?.sha || older.from === to.sha) return null;
  const all = [...base, ...older.commits];
  const at = all.findIndex((c) => c.sha === to.sha);
  if (at < 0) return null;
  // Past the state's list, nothing is rewritable; what's under a pushed commit is pushed too.
  const commits = all.slice(at + 1).map((c) => (c.editable || (to.pushed && !c.pushed) ? { ...c, editable: false, pushed: c.pushed || to.pushed } : c));
  return { from: to.sha, commits, more: older.more };
}
