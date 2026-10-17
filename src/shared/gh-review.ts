// Types shared between the server and the UI for pull request review threads (server/gh/review.ts).

import type { GhUser } from './github.ts';

export type DiffSide = 'LEFT' | 'RIGHT';

/** GitHub's reaction contents (GraphQL's ReactionContent). */
export type Reaction = 'THUMBS_UP' | 'THUMBS_DOWN' | 'LAUGH' | 'HOORAY' | 'CONFUSED' | 'HEART' | 'ROCKET' | 'EYES';

export interface ReviewComment {
  /** GraphQL node id, and the REST id replies go to. */
  id: string;
  databaseId: number;
  body: string;
  author: GhUser | null;
  createdAt: string;
  lastEditedAt: string | null;
  url: string;
  /** The diff it was made on, up to (and including) the last line it's on, with ' ', '+', '-' prefixes. */
  diffHunk: string;
  originalCommit: string | null;
  /** The commit its current position is in; null when outdated. */
  commit: string | null;
  canEdit: boolean;
  canDelete: boolean;
  /** Part of the viewer's review that isn't submitted yet. */
  pending: boolean;
  reactions: { content: Reaction; count: number; mine: boolean }[];
}

export interface ReviewThread {
  id: string;
  path: string;
  resolved: boolean;
  /** The lines it was on changed since. */
  outdated: boolean;
  /** Where it is in the pull request's diff now (null when outdated), and where it was made. */
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  originalStartLine: number | null;
  side: DiffSide;
  startSide: DiffSide | null;
  /** 'FILE' for a comment on the whole file. */
  subject: 'LINE' | 'FILE';
  resolvedBy: string | null;
  canResolve: boolean;
  canUnresolve: boolean;
  canReply: boolean;
  comments: ReviewComment[];
}

export interface PrReview {
  number: number;
  /** The pull request's commits as GitHub has them, oldest first. */
  commits: string[];
  headSha: string;
  baseSha: string;
  viewer: string;
  threads: ReviewThread[];
  /** The viewer's review that isn't submitted yet, if any. */
  pending: { id: string; comments: number } | null;
}

/** Where a new comment goes: lines of `path` in the diff GitHub has for `commitId` (the head, or a commit of the PR). */
export interface NewComment {
  number: number;
  commitId: string;
  path: string;
  line: number;
  side: DiffSide;
  startLine?: number;
  startSide?: DiffSide;
  body: string;
  /** Add it to the viewer's pending review (starting one) rather than posting it now. */
  pending?: boolean;
}

export interface ApplySuggestion {
  path: string;
  /** Where the commented lines are expected in the file (1-based), and what they read. */
  startLine: number;
  lines: string[];
  /** What replaces them. */
  replacement: string[];
}
