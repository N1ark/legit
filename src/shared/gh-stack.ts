// Types for stacked pull requests and opening one (server/gh/stack.ts).

import type { PullRequest } from './github.ts';

/** One pull request of the stack the current branch is in. */
export interface StackEntry {
  pr: PullRequest;
  /** Indentation, for a pull request stacked on a branch that has another one stacked on it. */
  indent: number;
  current: boolean;
  /** The local branch for its head, if there's one. */
  branch: string | null;
  /** Its remote-tracking branch (refs/remotes/…), to check it out when there's no local one. */
  remoteRef: string | null;
  /** The other worktree its local branch is checked out in, if any. */
  worktree: string | null;
  /** Commits it has that its base doesn't, and the other way round; null when either isn't here. */
  ahead: number | null;
  behind: number | null;
  /** Its base is another open pull request's branch, which has moved on: it needs rebasing onto it. */
  restack: boolean;
}

export interface PrStack {
  /** The repo's default branch, at the bottom of the stack. */
  trunk: string;
  /** Top of the stack first; each one's descendants are right above it. */
  entries: StackEntry[];
  /** What the current branch needs to be up to date with the pull request it's stacked on, if anything. */
  restack: RestackPlan | null;
}

export interface RestackPlan {
  /** 'moved': the parent's branch has commits this one doesn't; 'merged': the parent was merged. */
  why: 'moved' | 'merged';
  parent: PullRequest;
  /** The branch to rebuild this one on, as the rebuild op takes it (`feature/x` or `origin/main`); null when it's up to date. */
  onto: string | null;
  /** This branch's own commits, kept on top (the parent's old ones are dropped). */
  shas: string[];
  /** For 'merged': the base this branch's pull request should now merge into, if GitHub still has the parent's. */
  retarget: string | null;
}

/** What the "Create pull request" dialog starts from. */
export interface PrCreateInfo {
  /** Bases to pick from: the default branch, the suggested one, then the base repo's other branches. */
  bases: string[];
  trunk: string;
  /** The branch this one was started from, when it has an open pull request: stack on it. */
  suggested: { base: string; number: number } | null;
  /** The commits only on this branch (compared to `base`), oldest first. */
  base: string;
  commits: { subject: string; body: string }[];
  /** The branch's name on GitHub (its upstream's, else its own). */
  head: string;
}

export interface CreatePrRequest {
  title: string;
  body: string;
  base: string;
  head: string;
  draft: boolean;
}
