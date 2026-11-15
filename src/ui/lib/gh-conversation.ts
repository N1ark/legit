// A pull request's conversation as one list in the order things happened, as GitHub's tab shows
// it: the overview's timeline, each review with the threads started in it, threads started alone
// at their own time, and commits the timeline doesn't reach (it holds the last 100 entries) first.

import type { PrComment, PrCommit, PrEvent, PrItem, PrPushed, PrReview } from '../../shared/gh-prview.ts';
import type { ReviewThread } from '../../shared/gh-review.ts';
import type { GhUser } from '../../shared/github.ts';

export type Entry =
  | { kind: 'item'; key: string; at: string; item: PrComment | PrEvent }
  /** `review` is null for the viewer's review in progress. */
  | { kind: 'review'; key: string; at: string; review: PrReview | null; threads: ReviewThread[]; replies: ReviewThread[] }
  /** `at` is null for commits only the full list has: older than anything the timeline holds. */
  | { kind: 'commits'; key: string; at: string | null; actor: GhUser | null; commits: PrPushed['commits'] }
  | { kind: 'thread'; key: string; at: string; thread: ReviewThread };

export interface ConversationInput {
  timeline: PrItem[];
  threads: readonly ReviewThread[];
  /** Every commit of the pull request as far as it's loaded, oldest first. */
  commits: readonly PrCommit[];
  /** The viewer's review in progress. */
  pending: string | null;
}

const time = (at: string | null) => (at ? Date.parse(at) || 0 : -Infinity);

/** The conversation, oldest first (`newest`: newest first; a review's threads and a push's commits keep their order). */
export function conversation({ timeline, threads, commits, pending }: ConversationInput, newest = false): Entry[] {
  const out: Entry[] = [];
  const reviews = new Map<string, Extract<Entry, { kind: 'review' }>>();
  const seen = new Set<string>();
  for (const item of timeline) {
    if (item.kind === 'review') {
      const e = { kind: 'review' as const, key: item.id, at: item.at, review: item, threads: [], replies: [] };
      reviews.set(item.id, e);
      out.push(e);
    } else if (item.kind === 'commits') {
      for (const c of item.commits) seen.add(c.sha);
      out.push({ kind: 'commits', key: item.id, at: item.at, actor: item.actor, commits: item.commits });
    } else {
      out.push({ kind: 'item', key: item.id, at: item.at, item });
    }
  }

  const sorted = [...threads].sort((a, b) => time(a.comments[0]?.createdAt ?? null) - time(b.comments[0]?.createdAt ?? null));
  for (const t of sorted) {
    const first = t.comments[0];
    if (!first) continue;
    let home = first.reviewId ? reviews.get(first.reviewId) : undefined;
    if (!home && first.reviewId && first.reviewId === pending) {
      home = { kind: 'review', key: pending, at: first.createdAt, review: null, threads: [], replies: [] };
      reviews.set(pending, home);
      out.push(home);
    }
    if (home) {
      home.threads.push(t);
      // In progress, it sits where its latest comment is.
      if (!home.review && time(first.createdAt) > time(home.at)) home.at = first.createdAt;
    } else {
      out.push({ kind: 'thread', key: t.id, at: first.createdAt, thread: t });
    }
    // Replies made in another review are said there, pointing at the thread.
    for (const c of t.comments.slice(1)) {
      const r = c.reviewId && c.reviewId !== first.reviewId ? reviews.get(c.reviewId) : undefined;
      if (r && !r.replies.includes(t)) r.replies.push(t);
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

/** The unresolved threads in the order the conversation shows them. */
export function unresolvedOf(entries: Entry[]): ReviewThread[] {
  return entries.flatMap((e) => (e.kind === 'review' ? e.threads : e.kind === 'thread' ? [e.thread] : [])).filter((t) => !t.resolved);
}
