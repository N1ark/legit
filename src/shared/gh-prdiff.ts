// A pull request's changes read without checking it out (server/gh/prdiff.ts): what was fetched
// of it, and the diffs between its versions.

/** A pull request's head and base as fetched into hidden refs (refs/worktree/legit/pull/<n>/…). */
export interface PrFetched {
  number: number;
  head: string;
  base: string;
  /** Where the head branched off the base: the old side of the Files changed diff (null when they share no history). */
  mergeBase: string | null;
  /** Why it couldn't be fetched just now, when what was fetched before (or is here anyway) is shown instead. */
  offline: string | null;
}

/** The diff between two versions of a pull request (two pushes, or a review's commit and the head). */
export interface PrCompare {
  /** Its diff key (see Repo.rangeDiff). */
  key: string;
  from: string;
  to: string;
  /**
   * `from` isn't in `to`'s history (a rebase, or a force-push): the two versions' trees are compared,
   * only in the files either version changes against its base.
   */
  rebased: boolean;
  /** The commits from `from` to `to`, newest first (none when rebased). */
  commits: string[];
}

/** What a pull request diff view shows (see ui/gh/PrDiffView.svelte). */
export type PrDiffShow =
  | { kind: 'files' }
  | { kind: 'since' }
  /** `from` may end in `^`: that commit's first parent. */
  | { kind: 'compare'; from: string; to: string; label: string }
  | { kind: 'commit'; sha: string };
