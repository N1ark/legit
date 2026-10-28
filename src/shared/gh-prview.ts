// A pull request's overview (its conversation tab), shared by server/gh/prview.ts and ui/gh/PrView.svelte.

import type { GhUser, PrState } from './github.ts';

/** A check rollup's state; null when the commit has no checks. */
export type CheckState = 'success' | 'failure' | 'error' | 'pending' | 'expected' | null;
export type ReviewState = 'approved' | 'changes' | 'commented' | 'dismissed' | 'pending';
export type MergeMethod = 'merge' | 'squash' | 'rebase';
export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
/** GitHub's mergeStateStatus, lowercased. */
export type MergeState = 'behind' | 'blocked' | 'clean' | 'dirty' | 'draft' | 'has_hooks' | 'unknown' | 'unstable';

export interface PrLabel {
  name: string;
  /** Hex, without the `#`. */
  color: string;
  /** Only in the pickers' choices. */
  description?: string | null;
}

/** Someone asked to review, or who did: their latest review, else `requested`. */
export interface PrReviewer {
  /** A user's login, or a team's `org/slug`. */
  login: string;
  avatar: string | null;
  team: boolean;
  state: ReviewState | 'requested';
}

export interface PrCommit {
  sha: string;
  short: string;
  headline: string;
  author: string | null;
  checks: CheckState;
}

interface Item {
  id: string;
  actor: GhUser | null;
  /** ISO time. */
  at: string;
}

export interface PrComment extends Item {
  kind: 'comment';
  /** The REST id, to edit or delete it. */
  dbId: number;
  body: string;
  edited: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

export interface PrReview extends Item {
  kind: 'review';
  state: ReviewState;
  body: string;
  /** Its comments on lines of the diff. */
  comments: number;
}

/** Commits pushed in a row, as one entry. */
export interface PrPushed extends Item {
  kind: 'commits';
  commits: { sha: string; short: string; headline: string }[];
}

export type PrEventType =
  | 'merged' | 'closed' | 'reopened' | 'ready' | 'draft' | 'force-pushed' | 'review-requested' | 'review-request-removed'
  | 'labeled' | 'unlabeled' | 'base-changed' | 'renamed' | 'head-deleted';

export interface PrEvent extends Item {
  kind: 'event';
  type: PrEventType;
  /** A reviewer, a label's name, a new base or title, a commit's short SHA, depending on `type`. */
  subject?: string;
  /** What it was before: a force push's old tip, the old base or title. */
  before?: string;
  label?: PrLabel;
}

export type PrItem = PrComment | PrReview | PrPushed | PrEvent;

export interface PrOverview {
  /** GraphQL node id, for mutations. */
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
  state: PrState;
  /** Its place in the merge queue (1 is next) while `queued`. */
  queuePosition: number | null;
  author: GhUser | null;
  createdAt: string;
  mergedAt: string | null;
  mergedBy: GhUser | null;
  base: string;
  head: string;
  headSha: string;
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  mergeState: MergeState;
  reviewDecision: 'approved' | 'changes' | 'required' | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** The signed-in user. */
  viewer: string;
  canUpdate: boolean;
  /** The viewer opened it (so can't approve it). */
  mine: boolean;
  labels: PrLabel[];
  assignees: GhUser[];
  reviewers: PrReviewer[];
  /** GitHub's suggestions, from who touched the changed lines. */
  suggested: GhUser[];
  /** The last 100, oldest first. */
  commits: PrCommit[];
  commitCount: number;
  /** The head commit's checks. */
  checks: CheckState;
  autoMerge: { method: MergeMethod; by: string | null } | null;
  canAutoMerge: boolean;
  /** Merge methods the repository allows, and the one the viewer last used. */
  methods: MergeMethod[];
  defaultMethod: MergeMethod;
  deleteBranchOnMerge: boolean;
  /** A squash commit's title and message, as GitHub prefills them. */
  squash: { title: string; message: string };
  /** The viewer's review in progress (diff comments not yet submitted). */
  pending: { id: string; comments: number } | null;
  /** The last 100 entries, oldest first. */
  timeline: PrItem[];
}

/** What the pickers offer: who can review, the repository's labels and branches. */
export interface PrOptions {
  users: GhUser[];
  labels: PrLabel[];
  branches: string[];
}
