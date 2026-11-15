// The repository's pull requests as the inbox lists them, and checking one out: shared by
// server/gh/inbox.ts, server/gh/checkout.ts and the UI.

import type { CheckState } from './gh-prview.ts';
import type { PullRequest } from './github.ts';

/** GitHub's tabs: review requested from you, yours, assigned to you, every open one. */
export type InboxList = 'review' | 'mine' | 'assigned' | 'open';

export interface InboxPr extends PullRequest {
  /** ISO time. */
  updatedAt: string;
  reviewDecision: 'approved' | 'changes' | 'required' | null;
  /** The head commit's checks. */
  checks: CheckState;
  /** `owner/repo` the head is in when that's another repository (a fork). */
  fork: string | null;
  /** Your review is asked for: `you`, or the team's `org/slug` it was asked of; null when it isn't. */
  requested: string | null;
  mine: boolean;
  assigned: boolean;
  comments: number;
}

export interface PrInbox {
  viewer: string;
  /** Every pull request in any list, most recently updated first. */
  items: InboxPr[];
  /** How many each list has on GitHub: more than `items` holds of it past the first 50. */
  counts: Record<InboxList, number>;
}

/** How a local branch stands to a pull request's head. */
export type CheckoutRelation = 'new' | 'same' | 'behind' | 'ahead' | 'diverged';

/** What checking out a pull request would do, worked out once its head is fetched (see server/gh/checkout.ts). */
export interface CheckoutPlan {
  number: number;
  /** The head, fetched into refs/legit/pull/<number>/head. */
  sha: string;
  branch: string;
  /** The branch's tip now; null when it's to be created. */
  tip: string | null;
  relation: CheckoutRelation;
  /** Commits only on the branch, and only on the pull request. */
  ahead: number;
  behind: number;
  /** The head branch as `owner:branch`: a branch tracking nothing is linked to its pull request by it. */
  head: string;
  /** What the branch tracks (set when it's created): the head branch, on a remote you have for its repository. */
  upstream: { remote: string; branch: string } | null;
  /** It's the branch checked out here. */
  current: boolean;
  /** The other worktree it's checked out in. */
  worktree: string | null;
  /** A free name to check it out as instead, when the branch has diverged. */
  alternative: string;
  /** A fork's remote to add for `upstream` to be on: its branch takes your pushes (maintainers may push, or it's yours). */
  addRemote: { name: string; url: string } | null;
}
