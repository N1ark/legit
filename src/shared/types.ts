// Types shared between the server and the UI.

export interface Person {
  name: string;
  email: string;
}

export interface CommitInfo {
  sha: string;
  subject: string;
  /** Message body without the subject line and without Co-authored-by trailers. */
  body: string;
  coauthors: Person[];
  author: Person & { time: number };
  /** Reachable from a remote-tracking branch: rewriting it will need a force-push. */
  pushed: boolean;
  /** Merge commits (and anything below them) can't be rewritten. */
  editable: boolean;
  merge: boolean;
}

export interface RepoState {
  root: string;
  name: string;
  /** Branch name, or null when HEAD is detached. */
  branch: string | null;
  head: string | null;
  /** Newest first. */
  commits: CommitInfo[];
  /** Why history can't be edited right now (e.g. a rebase is in progress). */
  blocked: string | null;
  canUndo: boolean;
  canRedo: boolean;
}

export type LineKind = ' ' | '+' | '-';

export interface DiffLine {
  t: LineKind;
  s: string;
  /** Index among the file's changed lines; present on '+' and '-' lines only. */
  i?: number;
  /** Old / new line numbers. */
  o?: number;
  n?: number;
  /** Line has no trailing newline. */
  eof?: boolean;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldCount: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  status: 'A' | 'M' | 'D' | 'T';
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
  binary: boolean;
  /** Individual lines can be selected (regular text file). */
  partial: boolean;
  hunks: Hunk[];
  added: number;
  removed: number;
}

export interface CommitDiff {
  sha: string;
  files: FileDiff[];
}

/** Per-file selection: 'all' or the indices of the selected changed lines. */
export type Selection = Record<string, 'all' | number[]>;

export interface EditRequest {
  sha: string;
  subject: string;
  body: string;
  author: Person;
  coauthors: Person[];
}

export interface SplitRequest {
  sha: string;
  selection: Selection;
  /** Message of the new commit made from the selected changes. */
  message: string;
  /** Put the new commit before the original instead of after it. */
  before: boolean;
}

export interface SquashRequest {
  /** Commits to squash, any order; they're folded into the oldest one. */
  shas: string[];
  message: string;
}

export interface ReorderRequest {
  /** SHAs of the editable commits in their new order, newest first. */
  order: string[];
}

export interface DropRequest {
  shas: string[];
}

export interface OpResult {
  state: RepoState;
  /** Old SHA -> new SHA for every commit that was rewritten. */
  renamed: Record<string, string>;
  /** SHAs of the commits the UI should select after the operation. */
  focus: string[];
}

export interface Backup {
  ref: string;
  sha: string;
  /** Subject of the backed-up tip commit. */
  subject: string;
  /** Milliseconds since epoch. */
  time: number;
  /** Operation the backup was taken before. */
  label: string;
}
