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
  /** Listed under a merge (the SHA) as one of the commits it brought in. */
  side?: string;
}

/** A page of history past what `RepoState.commits` lists. */
export interface OlderCommits {
  commits: CommitInfo[];
  more: boolean;
}

/** The commits a merge brought in (at most a few hundred of `total`). */
export interface MergedCommits {
  commits: CommitInfo[];
  total: number;
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
  /** Uncommitted changes, counted in files. */
  work: { staged: number; unstaged: number; untracked: number };
  /** Where the current branch pushes to; null when detached or there's no remote. */
  push: PushInfo | null;
  /** `owner/repo` on GitHub, from the push remote (or origin), for linking `#123`; null if not on GitHub. */
  github: string | null;
  /** When this repo last fetched (ms since epoch), from any tool; null if never. */
  fetchedAt: number | null;
  /** A merge, rebase, cherry-pick or revert that stopped halfway (on conflicts, usually). */
  conflict: Conflict | null;
  /** Changes legit stashed when leaving this branch, which can be brought back. */
  stashed: StashEntry | null;
  /** The default branch to rebase onto (see server/base.ts); null when on it, detached, or there's none. */
  base: BaseBranch | null;
}

export interface BaseBranch {
  /** As the rebase takes it: "main", or "origin/main". */
  name: string;
  /** Commits it has that HEAD doesn't: a rebase would change something. */
  behind: number;
}

export interface PushInfo {
  remote: string;
  /** Branch on the remote. */
  branch: string;
  /** No upstream yet (or it was deleted): pushing publishes the branch. */
  publish: boolean;
  /** Commits only here / only on the remote, as of the last fetch. */
  ahead: number;
  behind: number;
  /**
   * Diverged because commits that were pushed got rewritten here (the upstream's tip was once
   * part of this branch), so a force push is what's wanted; otherwise the remote has new
   * commits, and pulling is.
   */
  rewritten: boolean;
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
  newStart: number;
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
  /** Untracked file (working-tree changes only). */
  untracked?: boolean;
  /** Identifies this exact version of the file's diff (working-tree changes only). */
  token?: string;
  hunks: Hunk[];
  added: number;
  removed: number;
}

export interface CommitDiff {
  sha: string;
  files: FileDiff[];
}

/** A file of a commit's diff without its content, for layout before anything is loaded. */
export interface FileSummary extends Omit<FileDiff, 'hunks'> {
  /** Generated (lockfile, minified, `linguist-generated`...): collapsed by default. */
  generated: boolean;
  /** A tree-sitter grammar to highlight it with (from the settings), instead of Prism's guess. */
  syntax?: string;
  /** Rows the file renders: one per hunk header and per diff line, and one after the last hunk when the file may go on. */
  rows: number;
  /** Widest line, in columns (tabs count as 4). */
  width: number;
}

export interface DiffSummary {
  sha: string;
  files: FileSummary[];
}

/** One hunk in compact form: line kinds as a string of ' ', '+', '-' plus the line texts. */
export interface HunkData {
  header: string;
  oldStart: number;
  newStart: number;
  types: string;
  text: string[];
  /** Indices of lines without a trailing newline. */
  eof: number[];
}

/** A modified file's old version, for the unchanged lines between its hunks. */
export interface FileLines {
  lines: string[];
  /** The last line has no newline. */
  noNewline: boolean;
}

/** File contents by file index. */
export type FileContents = Record<number, HunkData[]>;

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

export interface RemoveChangesRequest {
  sha: string;
  /** Changes to take out of the commit: picked '+' lines aren't added, picked '-' lines stay. */
  selection: Selection;
}

export interface EditLineRequest {
  sha: string;
  path: string;
  /** Line number in the commit's version of the file (an added or unchanged line), from 1. */
  line: number;
  /** What replaces the line: its new text, or several lines separated by '\n'. */
  text: string;
}

export interface SquashRequest {
  /** Commits to squash, any order; they're folded into the oldest one. */
  shas: string[];
  subject: string;
  body: string;
  coauthors: Person[];
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

export interface BranchInfo {
  name: string;
  sha: string;
  subject: string;
  time: number;
  upstream: string | null;
  /** e.g. "ahead 2, behind 1" or "gone". */
  track: string | null;
  current: boolean;
}

/** Uncommitted changes. Each summary's `sha` is a snapshot key usable with the diff APIs. */
export interface WorkState {
  staged: DiffSummary;
  /** Unstaged changes to tracked files, then untracked files. */
  unstaged: DiffSummary;
}

export interface StageRequest {
  /** Snapshot key the selection was made on. */
  key: string;
  selection: Selection;
}

export interface CommitRequest {
  subject: string;
  body: string;
  coauthors: Person[];
  /** Fold what's staged into HEAD and replace its message. */
  amend?: boolean;
}

export interface DiscardResult {
  state: RepoState;
  /** Where what was discarded is saved (refs/legit/discarded/<time>); null if it all went to the Trash. */
  ref: string | null;
  /** Files discarded. */
  files: number;
  /** Files too big to save in git, moved to the Trash instead. */
  trashed: string[];
}

/** Changes that were discarded, saved before they were. */
export interface Discarded {
  ref: string;
  sha: string;
  /** Milliseconds since epoch. */
  time: number;
  /** e.g. "discarded changes to 2 files". */
  label: string;
  /** The files (the first 50). */
  files: string[];
  count: number;
}

export interface RestoreDiscardedRequest {
  ref: string;
  /** Also write files that changed since the discard (their current content is saved first). */
  overwrite?: boolean;
}

export interface RestoreDiscardedResult {
  state: RepoState;
  restored: number;
  /** Files that changed since the discard; when not overwriting, nothing was restored. */
  conflicts: string[];
  /** Where the overwritten content was saved, when there was any. */
  saved: string | null;
}

export interface Conflict {
  kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'am';
  /** What's going on, e.g. "Merge branch 'feature'" or "Rebasing main onto 1a2b3c4 (2 of 5)". */
  title: string;
  /** Files with unmerged entries. */
  files: ConflictFile[];
  /** Files merged automatically or marked resolved (staged, different from HEAD). */
  resolved: string[];
  /** In a rebase, tracked files changed since they were staged: it won't continue until they're staged again. */
  unstaged: string[];
  /** A rebase that stopped to edit a commit (not on a conflict); null otherwise. */
  edit: EditStop | null;
}

/** A commit checked out to edit its files, in the middle of a rebase that replays the ones after it. */
export interface EditStop {
  /** The commit being edited (HEAD). */
  sha: string;
  subject: string;
  /** Commits still to replay on top of it, oldest first. */
  pending: { sha: string; subject: string }[];
  /** Started from legit, which knows which untracked files were there before (they're left out). */
  legit: boolean;
}

export interface ConflictFile {
  path: string;
  /** As `git status` puts it: "both modified", "deleted by them"... */
  status: string;
  /** The working-tree file exists. */
  exists: boolean;
  /** It still has conflict markers (<<<<<<<, =======, >>>>>>> at a line start). */
  markers: boolean;
  /** Line of the first marker, to open the file at. */
  line: number | null;
}

/** Result of a fetch, pull, merge, rebase, continue or abort: the new state plus what happened. */
export interface SyncResult extends OpResult {
  message: string;
}

export interface CreateBranchRequest {
  name: string;
  /** Commit to start from; HEAD when absent. */
  from?: string;
  /** Switch to the new branch (`git switch -c`); otherwise only create it. */
  checkout?: boolean;
  /** Stash uncommitted changes first, leaving them on the current branch. */
  stash?: boolean;
}

/** A remote-tracking branch with no local branch of its own. */
export interface RemoteBranchInfo {
  /** e.g. refs/remotes/origin/feature */
  ref: string;
  remote: string;
  /** Branch name on the remote, e.g. feature. */
  name: string;
  sha: string;
  subject: string;
  /** Seconds since epoch. */
  time: number;
}

/** A deleted branch, saved under refs/legit/deleted/<branch>/<time>[-<remote>]. */
export interface DeletedBranch {
  ref: string;
  name: string;
  sha: string;
  subject: string;
  /** When it was deleted, in milliseconds since epoch. */
  time: number;
  /** Set when it was deleted on a remote (this one) rather than locally. */
  remote: string | null;
}

export interface StashEntry {
  sha: string;
  /** e.g. "On main: legit: on main". */
  message: string;
  /** The branch legit stashed it from; null for stashes legit didn't make. */
  branch: string | null;
  legit: boolean;
  /** Milliseconds since epoch. */
  time: number;
  /** Paths it touches, untracked files included. */
  files: string[];
}

/** A stash that left the stash list (popped or dropped), kept under refs/legit/stashes. */
export interface DroppedStash {
  ref: string;
  sha: string;
  message: string;
  /** When it left the list, in milliseconds since epoch. */
  time: number;
  /** "pop" or "drop". */
  label: string;
}

export interface Stashes {
  /** The stash list, newest first. */
  entries: StashEntry[];
  /** Newest first. */
  dropped: DroppedStash[];
}

/** Where a setting applies: this repo, or every repo. */
export type Scope = 'repo' | 'global';

export interface ScopeSettings {
  /** Globs of files to collapse as generated, on top of the built-in ones. */
  collapse: string[];
  /** Tree-sitter grammars to highlight files with, by glob; the last matching rule wins. */
  syntax: { pattern: string; grammar: string }[];
}

export interface Settings {
  repo: ScopeSettings;
  global: ScopeSettings;
}

/** A grammar in Zed's installed extensions. */
export interface ZedGrammar {
  grammar: string;
  /** The language's name, e.g. "ULLBC Crate". */
  language: string;
  /** Its files' suffixes, e.g. ["crate"]. */
  suffixes: string[];
}

/** What the settings page shows. */
export interface SettingsInfo extends Settings {
  /** Where each scope is stored. */
  files: Record<Scope, string>;
  grammars: ZedGrammar[];
  /** Why a grammar in a rule can't be used, by grammar. */
  problems: Record<string, string>;
}
