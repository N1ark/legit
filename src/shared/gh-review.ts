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
  /** The review it was made in (GraphQL node id), as the overview's timeline has it. */
  reviewId: string | null;
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
  /** On the whole file: lines and sides are then left out. */
  subject?: 'LINE' | 'FILE';
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

/** A file's lines GitHub takes comments on at a commit, worked out from the local repo (server/gh/review.ts's `reviewLines`). */
export interface PrLines {
  /** The hunks of the pull request's diff of the file at the commit (three lines of context): [first, last] lines on each side, last < first when none. None when it doesn't change the file. */
  hunks: { left: [number, number]; right: [number, number] }[];
  /** The diff shown's old side against the base, `git diff -U0` hunks [baseStart, baseCount, oldStart, oldCount]: how its removed lines map to the base's. */
  moved: [number, number, number, number][];
}

/** Suggestions committed together (server/gh/suggestions.ts), each with its thread and author. */
export interface ApplySuggestions {
  /** The branch checked out and its head, as the page saw them: the pull request's. */
  branch: string;
  head: string;
  suggestions: (ApplySuggestion & { threadId: string; author: GhUser | null })[];
}

/** One of a batch that wasn't applied (its index in it), and why. */
export interface SuggestionRefused {
  index: number;
  path: string;
  startLine: number;
  why: string;
}

/** What came of a batch: the indices of those committed, and those refused. */
export interface SuggestionsApplied {
  applied: number[];
  refused: SuggestionRefused[];
}
