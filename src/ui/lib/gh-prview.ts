// What a pull request's overview says in words: its events, review and check states, and
// whether (and why not) it can be merged.

import type { CheckState, MergeMethod, PrEvent, PrOverview, ReviewEvent, ReviewState } from '../../shared/gh-prview.ts';

export const METHOD_LABEL: Record<MergeMethod, string> = { merge: 'Merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge' };
export const METHOD_NOTE: Record<MergeMethod, string> = {
  merge: 'All commits are added to the base branch with a merge commit.',
  squash: 'The commits are combined into one commit on the base branch.',
  rebase: 'The commits are replayed one by one onto the base branch.',
};

export const REVIEW_LABEL: Record<ReviewState | 'requested', string> = {
  approved: 'Approved',
  changes: 'Changes requested',
  commented: 'Commented',
  dismissed: 'Dismissed',
  pending: 'Pending',
  requested: 'Awaiting review',
};

export function checksLabel(c: CheckState): string {
  return c === 'success' ? 'All checks have passed'
    : c === 'failure' || c === 'error' ? 'Some checks were not successful'
    : c === 'pending' || c === 'expected' ? "Some checks haven't completed yet"
    : 'No checks';
}

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

/** An event's line, after its actor's name. */
export function eventText(e: PrEvent): string {
  switch (e.type) {
    case 'merged': return `merged commit ${e.subject ?? ''} into ${e.before ?? 'the base branch'}`;
    case 'closed': return 'closed this';
    case 'reopened': return 'reopened this';
    case 'ready': return 'marked this ready for review';
    case 'draft': return 'converted this to a draft';
    case 'force-pushed': return e.before && e.subject ? `force-pushed the branch from ${e.before} to ${e.subject}` : 'force-pushed the branch';
    case 'review-requested': return e.subject === e.actor?.login ? 'asked themself for a review' : `requested a review from ${e.subject}`;
    case 'review-request-removed': return `removed the review request for ${e.subject}`;
    case 'labeled': return 'added the label';
    case 'unlabeled': return 'removed the label';
    case 'base-changed': return `changed the base branch from ${e.before} to ${e.subject}`;
    case 'renamed': return `changed the title from “${e.before}” to “${e.subject}”`;
    case 'head-deleted': return `deleted the ${e.subject} branch`;
  }
}

export const pushedText = (n: number) => `added ${plural(n, 'commit')}`;

export type Tone = 'success' | 'warn' | 'danger' | 'neutral';

export interface MergeStatus {
  tone: Tone;
  title: string;
  detail: string;
  /** The merge button works. */
  canMerge: boolean;
  /** Merging waits on something auto-merge can wait for (checks, a review). */
  waits: boolean;
}

/** Whether an open pull request can be merged, and why not, in words. */
export function mergeStatus(pr: PrOverview): MergeStatus {
  const checks = checksLabel(pr.checks);
  const no = (tone: Tone, title: string, detail: string, waits = false): MergeStatus => ({ tone, title, detail, canMerge: false, waits });
  if (pr.state === 'draft' || pr.mergeState === 'draft') return no('neutral', 'This pull request is still a draft', 'Mark it ready for review to merge it.');
  if (pr.mergeable === 'conflicting' || pr.mergeState === 'dirty') {
    const how = `Rebase ${pr.head} on ${pr.base} (or merge ${pr.base} into it) and push, or resolve them on GitHub.`;
    return no('danger', 'This branch has conflicts that must be resolved', how);
  }
  if (pr.mergeState === 'behind') {
    return no('warn', `This branch is out of date with ${pr.base}`, `${pr.base} must be in it before merging: rebase on it, or merge it in, and push.`);
  }
  if (pr.mergeState === 'blocked') {
    if (pr.reviewDecision === 'changes') {
      return no('danger', 'Changes were requested', 'A reviewer asked for changes; their approval (or a dismissal) is needed to merge.', true);
    }
    if (pr.checks === 'failure' || pr.checks === 'error') return no('danger', 'Required checks failed', `${checks}. Fix them and push again.`);
    if (pr.reviewDecision === 'required') {
      const also = pr.checks === 'pending' || pr.checks === 'expected' ? ` ${checks}.` : '';
      return no('warn', 'Review required', `An approving review from someone with write access is needed to merge.${also}`, true);
    }
    if (pr.checks === 'pending' || pr.checks === 'expected') return no('warn', 'Waiting for checks', `${checks}; required ones must pass before merging.`, true);
    return no('warn', 'Merging is blocked', "A branch protection rule isn't satisfied yet.", true);
  }
  if (pr.mergeState === 'unknown' || pr.mergeable === 'unknown') return no('neutral', 'Checking whether it can be merged…', 'GitHub is still working it out.');
  const ok = (tone: Tone, title: string, detail: string): MergeStatus => ({ tone, title, detail, canMerge: true, waits: false });
  if (pr.mergeState === 'unstable') return ok('warn', 'Some checks were not successful', "They aren't required, so it can still be merged.");
  if (pr.mergeState === 'has_hooks') return ok('success', 'Ready to merge', `${checks}. The repository's hooks run when it's merged.`);
  return ok('success', 'Ready to merge', `${checks}. This branch has no conflicts with ${pr.base}.`);
}

/** Why the viewer can't send this review, if they can't. */
export function reviewRefusal(pr: PrOverview, event: ReviewEvent): string | null {
  if (event === 'COMMENT' || !pr.mine) return null;
  return event === 'APPROVE' ? "You can't approve your own pull request." : "You can't request changes on your own pull request.";
}

/** What submitting needs first, if anything: GitHub wants words unless it's an approval or carries diff comments. */
export function reviewNeeds(pr: PrOverview, event: ReviewEvent, body: string): string | null {
  if (event === 'APPROVE' || body.trim() || (pr.pending?.comments ?? 0) > 0) return null;
  return event === 'COMMENT' ? 'Write a comment first.' : 'Say what needs to change first.';
}

/** A GitHub avatar at a small size (doubled for retina); null without one, for initials. */
export function ghAvatar(url: string | null | undefined, px = 40): string | null {
  if (!url) return null;
  return `${url}${url.includes('?') ? '&' : '?'}s=${px}`;
}
