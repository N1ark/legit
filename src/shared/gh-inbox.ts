// The repository's pull requests as the inbox lists them: shared by server/gh/inbox.ts and the UI.

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
