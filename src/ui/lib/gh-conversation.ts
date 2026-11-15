// A pull request's conversation as one list in the order things happened, as GitHub's tab shows
// it: the overview's timeline, and commits it doesn't reach (it holds the last 100 entries) first.

import type { PrComment, PrCommit, PrEvent, PrItem, PrPushed, PrReview } from '../../shared/gh-prview.ts';
import type { GhUser } from '../../shared/github.ts';

export type Entry =
  | { kind: 'item'; key: string; at: string; item: PrComment | PrEvent }
  | { kind: 'review'; key: string; at: string; review: PrReview }
  /** `at` is null for commits only the full list has: older than anything the timeline holds. */
  | { kind: 'commits'; key: string; at: string | null; actor: GhUser | null; commits: PrPushed['commits'] };

export interface ConversationInput {
  timeline: PrItem[];
  /** Every commit of the pull request as far as it's loaded, oldest first. */
  commits: readonly PrCommit[];
}

const time = (at: string | null) => (at ? Date.parse(at) || 0 : -Infinity);

/** The conversation, oldest first (`newest`: newest first; a push's commits keep their order). */
export function conversation({ timeline, commits }: ConversationInput, newest = false): Entry[] {
  const out: Entry[] = [];
  const seen = new Set<string>();
  for (const item of timeline) {
    if (item.kind === 'review') {
      out.push({ kind: 'review', key: item.id, at: item.at, review: item });
    } else if (item.kind === 'commits') {
      for (const c of item.commits) seen.add(c.sha);
      out.push({ kind: 'commits', key: item.id, at: item.at, actor: item.actor, commits: item.commits });
    } else {
      out.push({ kind: 'item', key: item.id, at: item.at, item });
    }
  }

  // Commits before the timeline's reach, pushed in a row by one author as one entry.
  const earlier: Entry[] = [];
  for (const c of commits) {
    if (seen.has(c.sha)) continue;
    const last = earlier.at(-1);
    const entry = { sha: c.sha, short: c.short, headline: c.headline, checks: c.checks };
    if (last?.kind === 'commits' && (last.actor?.login ?? null) === c.author) last.commits.push(entry);
    else earlier.push({ kind: 'commits', key: `earlier:${c.sha}`, at: null, actor: c.author ? { login: c.author, avatar: '' } : null, commits: [entry] });
  }

  // Stable: what happened at the same time keeps GitHub's order.
  const all = [...earlier, ...out.sort((a, b) => time(a.at) - time(b.at))];
  return newest ? all.reverse() : all;
}
