// History rewriting. Every operation replays the affected tail of the first-parent
// chain in memory (commit objects are written directly, cherry-picks go through
// `git merge-tree`), then moves HEAD once. Nothing touches the working tree unless
// the final tree differs from the old one.

import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type {
  Backup, BranchInfo, CommitDiff, CommitInfo, MergedCommits, OlderCommits, CommitRequest, DropRequest, EditLineRequest, FileDiff, PushInfo, StageRequest, EditRequest, OpResult, RemoveChangesRequest, RepoState, ReorderRequest, Selection, SplitRequest, SquashRequest,
} from '../shared/types.ts';
import { baseBranch } from './base.ts';
import { switchBranch } from './branches.ts';
import { RENAME_ARGS, applyLines, commitDiff, parseDiff } from './diff.ts';
import { Git, GitError, type Merger, type RawCommit, formatIdent, fromUtf8, parseIdent, toUtf8 } from './git.ts';
import { pickGithubRepo } from './github.ts';
import { buildMessage, parseMessage } from './message.ts';
import { runWithProgress } from './progress.ts';
import { pruneRefs } from './retention.ts';
import { fetchFrom, networkEnv, syncState } from './sync.ts';
import { stashDiff, stashFor } from './stash.ts';
import { stagingOf, workCounts, workDiff } from './work.ts';
import { emit, restage } from './staging.ts';

/** How many commits to show, and how many past the first merge (not editable). */
const LIMIT = 1000;
const PAST_MERGE = 20;
/** How many older commits each scroll loads, and how many of a merge's commits are listed. */
const PAGE = 200;
const MERGED = 500;
const BACKUPS = 'refs/legit/backups';

/** A commit being replayed conflicts with what it's replayed onto, in `files` (UTF-8). */
export class ReplayConflict extends GitError {
  readonly files: string[];
  constructor(message: string, files: string[]) {
    super(message);
    this.files = files;
  }
}

interface Item {
  src: RawCommit;
  tree?: string;
  message?: string;
  author?: string;
  /** Commits whose changes get folded into this one, oldest first. */
  squash?: RawCommit[];
  /** The replayed commit is new (not a rewrite of `src`), e.g. the second half of a split. */
  fresh?: boolean;
}

interface Move {
  label: string;
  before: string;
  after: string;
  /** Only HEAD moves; the index and working tree are left as they are (commit, amend, uncommit). */
  soft?: boolean;
  /** Another branch moved (refs/heads/<name>), not HEAD: commits copied to it. */
  ref?: string;
}

/** What `state()` reads of the refs: the branch (its SHA and upstream) and every remote-tracking ref. */
interface RefView {
  sha: string | null;
  upstream: string;
  remote: string;
  remoteRef: string;
  /** refname → SHA. */
  remotes: Map<string, string>;
  /** Changes whenever a remote-tracking ref does. */
  fingerprint: string;
}

/** The remote a branch syncs with, as `remoteFor` (sync.ts) picks it. */
const remoteOf = (view: RefView, names: string[]) =>
  view.remote && names.includes(view.remote) ? view.remote : names.includes('origin') ? 'origin' : (names[0] ?? null);

/** What the commit list shows of a commit. `local`: SHAs not on any remote-tracking branch. */
export function info(c: RawCommit, local: Set<string>, editable: boolean): CommitInfo {
  let parsed = parsedCommits.get(c);
  if (!parsed) {
    const a = parseIdent(toUtf8(c.author));
    parsed = { ...parseMessage(toUtf8(c.message)), author: { name: a.name, email: a.email, time: a.time } };
    parsedCommits.set(c, parsed);
  }
  const { subject, body, coauthors, author } = parsed;
  return { sha: c.sha, subject, body, coauthors, author, pushed: !local.has(c.sha), editable, merge: c.parents.length > 1 };
}

/** Commits' messages and authors as `info` gives them, parsed once (commits never change). */
const parsedCommits = new WeakMap<RawCommit, Pick<CommitInfo, 'subject' | 'body' | 'coauthors' | 'author'>>();

export class Repo {
  readonly git: Git;
  /** Undo/redo history per branch (or detached HEAD). */
  history = new Map<string, { undo: Move[]; redo: Move[] }>();
  private diffs = new Map<string, CommitDiff>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastBackup = 0;
  /** Working-tree diffs by snapshot key; a key is reused while its content is unchanged. */
  snapshots = new Map<string, CommitDiff>();
  snapshotIds = new Map<string, string>();
  private nextSnapshot = 1;

  constructor(git: Git) {
    this.git = git;
  }

  static async open(path: string) {
    const git = await Git.open(path);
    await pruneRefs(git);
    return new Repo(git);
  }

  /** Resolves once no operation is running. */
  idle(): Promise<void> {
    return this.queue.then(() => {});
  }

  /** Serialise mutating operations. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }

  async head(): Promise<string | null> {
    return (await this.git.headState()).head;
  }

  blocked(): string | null {
    const d = this.git.gitDir;
    if (existsSync(join(d, 'rebase-merge')) || existsSync(join(d, 'rebase-apply'))) return 'A rebase is in progress.';
    if (existsSync(join(d, 'MERGE_HEAD'))) return 'A merge is in progress.';
    if (existsSync(join(d, 'CHERRY_PICK_HEAD'))) return 'A cherry-pick is in progress.';
    if (existsSync(join(d, 'REVERT_HEAD'))) return 'A revert is in progress.';
    if (existsSync(join(d, 'BISECT_LOG'))) return 'A bisect is in progress.';
    return null;
  }

  async state(): Promise<RepoState> {
    const { branch, head } = await this.git.headState();
    const stacks = this.stacksFor(branch);
    const [view, remotes, work, sync, stashed, list] = await Promise.all([
      this.refView(branch),
      this.git.remotes(),
      workCounts(this.git),
      syncState(this),
      stashFor(this.git, branch),
      head ? this.git.firstParent(head, LIMIT) : [],
    ]);
    const [push, canUndo, canRedo, base, unpushed, commits] = await Promise.all([
      head && branch ? this.pushInfo(branch, view, remotes.names) : null,
      this.applies(stacks.undo.at(-1), 'after', head),
      this.applies(stacks.redo.at(-1), 'before', head),
      baseBranch(this.git, branch, head, { remote: remoteOf(view, remotes.names), refs: view.remotes }),
      head ? this.unpushed(head, LIMIT, view) : [],
      this.git.loadCommits(list),
    ]);
    const state: RepoState = {
      root: this.git.root,
      name: basename(this.git.root),
      branch,
      head,
      commits: [],
      blocked: head ? this.blocked() : 'This branch has no commits yet.',
      canUndo,
      canRedo,
      push,
      github: pickGithubRepo(remotes.urls, push?.remote),
      work,
      ...sync,
      stashed,
      base,
    };
    if (!head) return state;

    const local = new Set(unpushed);
    let editable = true;
    let past = 0;
    for (const c of commits) {
      if (c.parents.length > 1) editable = false;
      if (!editable && past++ > PAST_MERGE) break;
      state.commits.push(info(c, local, editable));
    }
    return state;
  }

  /** The branch's upstream, and every remote-tracking ref, in one `for-each-ref`. */
  private async refView(branch: string | null): Promise<RefView> {
    const out = await this.git.text([
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)',
      ...(branch ? [`refs/heads/${branch}`] : []),
      'refs/remotes/',
    ]);
    const view: RefView = { sha: null, upstream: '', remote: '', remoteRef: '', remotes: new Map(), fingerprint: '' };
    const hash = createHash('sha1');
    for (const line of out.split('\n')) {
      const [ref, sha, upstream, remote, remoteRef] = line.split('\0');
      if (ref.startsWith('refs/remotes/')) {
        view.remotes.set(ref, sha);
        hash.update(`${ref} ${sha}\n`);
      } else if (ref === `refs/heads/${branch}`) Object.assign(view, { sha, upstream, remote, remoteRef });
    }
    view.fingerprint = hash.digest('hex');
    return view;
  }

  /**
   * Of the first `n` commits of `sha`'s first-parent history, those on no remote-tracking branch
   * (`rev-list --first-parent --max-count=<n> <sha> --not --remotes`), cached while the remotes don't move.
   */
  private unpushed(sha: string, n: number, view: RefView): Promise<string[]> {
    if (!view.remotes.size) return this.git.firstParent(sha, n);
    return this.git.memo(
      `unpushed ${sha} ${n} ${view.fingerprint}`,
      async () => (await this.git.text(['rev-list', '--first-parent', `--max-count=${n}`, sha, '--not', '--remotes'])).split('\n').filter(Boolean),
      true,
    );
  }

  /**
   * First-parent history older than `sha` (the oldest commit shown so far), newest first.
   * It's never editable: it's past what `state()` lists. `pushed`: `sha` is on a remote, so all of it is.
   */
  async older(sha: string, pushed = false): Promise<OlderCommits> {
    const parent = (await this.git.commit(sha)).parents[0];
    if (!parent) return { commits: [], more: false };
    const [list, unpushed] = await Promise.all([
      this.git.firstParent(parent, PAGE + 1),
      pushed ? '' : this.git.text(['rev-list', '--first-parent', `--max-count=${PAGE + 1}`, parent, '--not', '--remotes']),
    ]);
    const local = new Set(unpushed.split('\n'));
    const commits = await this.git.loadCommits(list);
    return { commits: commits.slice(0, PAGE).map((c) => info(c, local, false)), more: commits.length > PAGE };
  }

  /** The commits a merge brought in: reachable from its other parents but not its first. Newest first. */
  async merged(sha: string): Promise<MergedCommits> {
    const [first, ...others] = (await this.git.commit(sha)).parents;
    if (!others.length) return { commits: [], total: 0 };
    const range = [...others, '--not', first];
    const [list, unpushed, total] = await Promise.all([
      this.git.text(['rev-list', '--topo-order', `--max-count=${MERGED}`, ...range]),
      this.git.text(['rev-list', '--topo-order', `--max-count=${MERGED}`, ...range, '--remotes']),
      this.git.text(['rev-list', '--count', ...range]),
    ]);
    const local = new Set(unpushed.split('\n'));
    const commits = list ? await this.git.loadCommits(list.split('\n')) : [];
    return { commits: commits.map((c) => ({ ...info(c, local, false), side: sha })), total: Number(total) };
  }

  /** The editable part of the first-parent chain, newest first. */
  async chain(): Promise<RawCommit[]> {
    const why = this.blocked();
    if (why) throw new GitError(why);
    const head = await this.head();
    if (!head) throw new GitError('This branch has no commits yet.');
    const all = await this.git.loadCommits(await this.git.firstParent(head, LIMIT));
    const end = all.findIndex((c) => c.parents.length > 1);
    return end < 0 ? all : all.slice(0, end);
  }

  static indexOf(chain: RawCommit[], sha: string): number {
    const i = chain.findIndex((c) => c.sha === sha);
    if (i < 0) throw new GitError(`Commit ${sha.slice(0, 7)} is not editable (history may have changed; refresh).`);
    return i;
  }

  /**
   * A commit's diff, a stash's (`s<sha>`), a working-tree snapshot (`w<n>`, from `work()`), or what
   * squashing some commits would make (`q…`, see `squashDiff`).
   */
  async diff(sha: string): Promise<CommitDiff> {
    if (/^w\d+$/.test(sha)) {
      const snap = this.snapshots.get(sha);
      if (!snap) throw new GitError('Those changes are out of date; refresh.');
      return snap;
    }
    let d = this.diffs.get(sha);
    if (!d) {
      // `s<sha>`: a stash's changes, untracked files included.
      d = sha.startsWith('s')
        ? await stashDiff(this.git, sha.slice(1), sha)
        : sha.startsWith('q')
          ? await this.squashDiff(sha)
          : await commitDiff(this.git, sha);
      if (this.diffs.size > 200) this.diffs.delete(this.diffs.keys().next().value!);
      this.diffs.set(sha, d);
    }
    return d;
  }

  /**
   * The diff of the commit squashing would make, for key `q<run>.<run>…`: runs of consecutive commits
   * (`<newest>-<oldest>`, or one SHA), newest first. As in `squash`, the others' changes are picked onto
   * the oldest in order, and the result is diffed against its parent.
   */
  private async squashDiff(key: string): Promise<CommitDiff> {
    const list: RawCommit[] = [];
    for (const run of key.slice(1).split('.').reverse()) {
      const [newest, oldest = newest] = run.split('-');
      const after = newest === oldest ? [] : (await this.git.text(['rev-list', '--first-parent', '--reverse', newest, `^${oldest}`])).split('\n');
      const commits = await this.git.loadCommits([oldest, ...after]);
      if (commits.some((c, i) => i && c.parents[0] !== commits[i - 1].sha)) throw new GitError('History changed; refresh.');
      list.push(...commits);
    }
    let tree = list[0].tree;
    const merger = this.git.merger();
    try {
      for (const c of list.slice(1)) {
        const r = await merger.pick(await this.git.treeOf(c.parents[0] ?? null), tree, c.tree);
        if (!('tree' in r)) {
          const subject = parseMessage(toUtf8(c.message)).subject;
          throw new GitError(
            `These commits' changes conflict: ${c.sha.slice(0, 7)} "${subject}" with the ones before it, in ${r.conflicts.map(toUtf8).join(', ')}. Squashing stops there for you to resolve.`,
          );
        }
        tree = r.tree;
      }
    } finally {
      merger.close();
    }
    const { out } = await this.git.run(['diff-tree', ...RENAME_ARGS, list[0].parents[0] ?? this.git.emptyTree, tree]);
    return parseDiff(out.toString('latin1'), key);
  }

  /**
   * Replace `chain[0..k]` with `items` (newest first) and move HEAD.
   * Returns the new SHA for each item, in the same order.
   *
   * `keepsTree`: the operation only restructures history, so the final snapshot must be
   * byte-identical to the current one; anything else aborts before HEAD moves.
   */
  private async rewrite(label: string, chain: RawCommit[], k: number, items: Item[], keepsTree: boolean): Promise<string[]> {
    const base = chain[k].parents[0] ?? null;
    const committer = await this.git.committerIdent();
    let parent = base;
    let parentTree = await this.git.treeOf(base);
    const out: string[] = [];
    const merger = this.git.merger();
    try {
      for (const item of items.toReversed()) {
        const c = item.src;
        let tree = item.tree;
        if (!tree) {
          const origParentTree = await this.git.treeOf(c.parents[0] ?? null);
          tree = await this.pickOrThrow(merger, origParentTree, parentTree, c);
        }
        for (const s of item.squash ?? []) {
          tree = await this.pickOrThrow(merger, await this.git.treeOf(s.parents[0] ?? null), tree, s);
        }
        const unchanged =
          !item.fresh && !item.message && !item.author && !item.squash?.length &&
          tree === c.tree && (c.parents[0] ?? null) === parent;
        const sha = unchanged
          ? c.sha
          : this.git.writeCommit({
              tree,
              parents: parent ? [parent] : [],
              author: item.author ?? c.author,
              committer,
              // A new message is written as UTF-8, so a legacy encoding header would be wrong.
              extra: item.message ? c.extra.filter((h) => !h.startsWith('encoding ')) : c.extra,
              message: item.message ?? c.message,
            });
        out.push(sha);
        parent = sha;
        parentTree = tree;
      }
      await this.git.flush();
    } finally {
      merger.close();
    }
    const tip = parent!;
    if (keepsTree && (await this.git.treeOf(tip)) !== chain[0].tree) {
      throw new GitError(`Safety check failed: ${label} would change the final content of your files. Nothing was changed.`);
    }
    await this.verify(base, tip, out);
    await this.moveHead(chain[0].sha, tip, label);
    await this.record({ label, before: chain[0].sha, after: tip });
    return out.reverse();
  }

  /** Have git itself re-read the new commits and check they are what we meant to write. */
  async verify(base: string | null, tip: string, oldestFirst: string[]) {
    const args = ['rev-list', '--first-parent', '--no-commit-header', '--format=%H %T %P', tip];
    if (base) args.push('--not', base);
    const listed = (await this.git.text(args)).split('\n').reverse();
    let parent = base ?? '';
    const ok =
      listed.length === oldestFirst.length &&
      (await this.git.loadCommits(oldestFirst)).every((c, i) => {
        const ok = listed[i]?.trimEnd() === `${c.sha} ${c.tree} ${parent}`.trimEnd();
        parent = c.sha;
        return ok;
      });
    if (!ok) throw new GitError('Safety check failed: the rewritten commits did not read back correctly. Nothing was changed.');
  }

  async pickOrThrow(merger: Merger, base: string, onto: string, c: RawCommit): Promise<string> {
    const r = await merger.pick(base, onto, c.tree);
    if ('tree' in r) return r.tree;
    const subject = parseMessage(toUtf8(c.message)).subject;
    const files = r.conflicts.map(toUtf8);
    throw new ReplayConflict(`${c.sha.slice(0, 7)} "${subject}" conflicts in ${files.join(', ')}. Nothing was changed.`, files);
  }

  /**
   * Point HEAD at `to`. The old tip is first saved under refs/legit/backups. The index and
   * working tree are only touched if the snapshot changes, and then only when there are no
   * uncommitted changes to tracked files (git itself refuses to overwrite untracked ones).
   */
  private async moveHead(from: string, to: string, label: string) {
    if (from === to) return;
    const treeChanged = (await this.git.treeOf(from)) !== (await this.git.treeOf(to));
    if (treeChanged) await this.requireClean();
    await this.backup(from, label);
    if (treeChanged) {
      const r = await this.git.run(['read-tree', '-m', '-u', from, to], { allowFail: true });
      if (r.code !== 0) throw new GitError(`Git refused to update the working tree; nothing was changed.\n${r.err.trim()}`);
    }
    const r = await this.git.run(['update-ref', '-m', `legit: ${label}`, 'HEAD', to, from], { allowFail: true });
    if (r.code !== 0) {
      if (treeChanged) await this.git.run(['read-tree', '-m', '-u', to, from], { allowFail: true });
      throw new GitError(`HEAD moved while rewriting; nothing was changed. ${r.err.trim()}`);
    }
  }

  /** Refuse if any tracked file has uncommitted changes (staged or not). */
  async requireClean() {
    await this.git.run(['update-index', '-q', '--refresh'], { allowFail: true });
    const status = await this.git.text(['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=none']);
    if (status) {
      throw new GitError(
        `This would change files in your working tree, but you have uncommitted changes:\n${status}\nCommit or stash them first. Nothing was changed.`,
      );
    }
  }

  backupPrefix(branch: string | null) {
    return `${BACKUPS}/${branch ?? '_detached'}/`;
  }

  /**
   * Save `sha` under refs/legit/backups/<branch>/<time>-<label>, pruning old ones (see retention.ts).
   * `branch` defaults to the current one (e.g. a rebase in progress passes the branch being rebased).
   */
  async backup(sha: string, label: string, branch?: string | null) {
    if (branch === undefined) branch = await this.currentBranch();
    const prefix = this.backupPrefix(branch);
    label = label.replace(/[^\w]+/g, '-');
    const time = Math.max(Date.now(), this.lastBackup + 1);
    this.lastBackup = time;
    await this.git.run(['update-ref', '-m', `legit: backup before ${label}`, `${prefix}${time}-${label}`, sha, '']);
    await pruneRefs(this.git);
  }

  async backups(): Promise<Backup[]> {
    const branch = await this.currentBranch();
    const prefix = this.backupPrefix(branch);
    const out = await this.git.text([
      'for-each-ref', '--sort=-refname', '--format=%(refname)%00%(objectname)%00%(subject)', prefix,
    ]);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref, sha, subject] = line.split('\0');
        const m = /^(\d+)-([\w-]+)$/.exec(ref.slice(prefix.length));
        return m && { ref, sha, subject, time: Number(m[1]), label: m[2] };
      })
      .filter((b): b is Backup => !!b);
  }

  restore(req: { ref: string }): Promise<OpResult> {
    return this.exclusive(async () => {
      const why = this.blocked();
      if (why) throw new GitError(why);
      if (!req.ref.startsWith(`${BACKUPS}/`)) throw new GitError('Not a legit backup.');
      const sha = await this.git.text(['rev-parse', '--verify', `${req.ref}^{commit}`]);
      const head = await this.head();
      if (!head) throw new GitError('This branch has no commits yet.');
      await this.moveHead(head, sha, 'restore');
      await this.record({ label: 'restore', before: head, after: sha });
      return { state: await this.state(), renamed: {}, focus: [] };
    });
  }

  private result(state: RepoState, renamed: [RawCommit, string][], focus: string[]): OpResult {
    return {
      state,
      renamed: Object.fromEntries(renamed.filter(([c, s]) => c.sha !== s).map(([c, s]) => [c.sha, s])),
      focus,
    };
  }

  edit(req: EditRequest): Promise<OpResult> {
    return this.exclusive(async () => {
      if (!req.subject?.trim()) throw new GitError('A commit needs a title.');
      const chain = await this.chain();
      const k = Repo.indexOf(chain, req.sha);
      const orig = parseIdent(chain[k].author);
      const items: Item[] = chain.slice(0, k + 1).map((src) => ({ src }));
      items[k].message = fromUtf8(buildMessage(req.subject, req.body, req.coauthors));
      items[k].author = formatIdent({ ...orig, name: fromUtf8(req.author.name.trim()), email: fromUtf8(req.author.email.trim()) });
      const shas = await this.rewrite('edit', chain, k, items, true);
      return this.result(await this.state(), chain.slice(0, k + 1).map((c, i) => [c, shas[i]]), [shas[k]]);
    });
  }

  split(req: SplitRequest): Promise<OpResult> {
    return this.exclusive(async () => {
      const chain = await this.chain();
      const k = Repo.indexOf(chain, req.sha);
      const c = chain[k];
      const diff = await this.diff(c.sha);
      const selected = Repo.picker(req.selection, 'split out');

      // The first of the two commits applies the changes for which `first` is true.
      const first = req.before ? selected : (path: string, i: number) => !selected(path, i);
      const mid = await this.buildTree(c, diff, first);

      const splitMsg = fromUtf8(buildMessage(req.message, '', []));
      const orig: Item = { src: c, tree: req.before ? c.tree : mid };
      const fresh: Item = { src: c, tree: req.before ? mid : c.tree, message: splitMsg, fresh: true };
      // Force the original to be rewritten even if its tree happens to be unchanged.
      if (!req.before) orig.fresh = true;
      const items: Item[] = [
        ...chain.slice(0, k).map((src) => ({ src })),
        ...(req.before ? [orig, fresh] : [fresh, orig]),
      ];
      const shas = await this.rewrite('split', chain, k, items, true);
      const origSha = req.before ? shas[k] : shas[k + 1];
      const renamed: [RawCommit, string][] = chain.slice(0, k).map((x, i) => [x, shas[i]]);
      renamed.push([c, origSha]);
      return this.result(await this.state(), renamed, [origSha]);
    });
  }

  /** A selection (paths in UTF-8) as a test of whether change `i` of `path` is picked; refuses an empty one. */
  private static picker(selection: Selection, what: string): (path: string, i: number) => boolean {
    const sel = new Map(Object.entries(selection).map(([p, v]) => [fromUtf8(p), v]));
    if (![...sel.values()].some((v) => v === 'all' || v.length)) throw new GitError(`Select some changes to ${what} first.`);
    return (path, i) => {
      const v = sel.get(path);
      return v === 'all' || (v?.includes(i) ?? false);
    };
  }

  /**
   * Take changes out of a commit: picked added lines are no longer added, picked removed lines
   * are kept (a whole file goes back to how it was before the commit). The commits after it are
   * replayed on top, so the change is gone from them too, and from your files; a later commit
   * that conflicts with it refuses the whole operation.
   */
  removeChanges(req: RemoveChangesRequest): Promise<OpResult> {
    return this.exclusive(async () => {
      const chain = await this.chain();
      const k = Repo.indexOf(chain, req.sha);
      const c = chain[k];
      const picked = Repo.picker(req.selection, 'remove');
      const tree = await this.buildTree(c, await this.diff(c.sha), (path, i) => !picked(path, i));
      return this.retree('remove changes', chain, k, tree);
    });
  }

  /**
   * Replace one line of a commit's version of a file (an added line, or an unchanged one, which
   * the commit then changes) with new text, which may be several lines. The commits after it are
   * replayed on top, as with `removeChanges`.
   */
  editLine(req: EditLineRequest): Promise<OpResult> {
    return this.exclusive(async () => {
      const chain = await this.chain();
      const k = Repo.indexOf(chain, req.sha);
      const c = chain[k];
      const path = fromUtf8(req.path);
      const f = (await this.diff(c.sha)).files.find((x) => x.path === path);
      if (!f) throw new GitError(`${req.path} isn't changed by this commit.`);
      if (!f.partial || f.status === 'D') throw new GitError(`${req.path} can't be edited line by line.`);
      const blob = (await this.git.readObjects([f.newSha])).get(f.newSha)!.data.toString('latin1');
      const lines = blob.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      if (!Number.isInteger(req.line) || req.line < 1 || req.line > lines.length) {
        throw new GitError(`${req.path} has no line ${req.line} in this commit; refresh.`);
      }
      const old = lines[req.line - 1];
      // The text arrives as UTF-8: a line in another encoding would come back garbled.
      if (fromUtf8(toUtf8(old)) !== old) throw new GitError(`Line ${req.line} of ${req.path} isn't UTF-8 text, so it can't be edited here.`);
      if (typeof req.text !== 'string') throw new GitError('Missing the new text.');
      // Keep the file's line endings: the line's own, or (on a last line without one) the file's.
      const ending = /\r?\n$/.exec(old)?.[0] ?? '';
      const eol = ending || (lines.at(-2)?.endsWith('\r\n') ? '\r\n' : '\n');
      const text = fromUtf8(req.text).split('\n').map((l) => l.replace(/\r$/, '')).join(eol) + ending;
      if (text === old) throw new GitError('That line is unchanged.');
      lines[req.line - 1] = text;
      const sha = this.git.writeObject('blob', Buffer.from(lines.join(''), 'latin1'));
      await this.git.flush();
      const tree = await this.treeWith(c.tree, [`${f.newMode} ${sha}\t${f.path}`]);
      return this.retree('edit line', chain, k, tree);
    });
  }

  /**
   * Give `chain[k]` a new tree and replay the commits after it on top. The final files change,
   * so this goes through the same checks as a drop (no uncommitted changes). The replay happens
   * in memory; if a later commit conflicts with the change, it's handed to `git rebase`, which
   * stops on the conflict for the conflict view to resolve (or abort, back to how it was).
   */
  private async retree(label: string, chain: RawCommit[], k: number, tree: string): Promise<OpResult> {
    const items: Item[] = chain.slice(0, k + 1).map((src) => ({ src }));
    items[k].tree = tree;
    try {
      const shas = await this.rewrite(label, chain, k, items, false);
      return this.result(await this.state(), chain.slice(0, k + 1).map((c, i) => [c, shas[i]]), [shas[k]]);
    } catch (e) {
      if (!(e instanceof ReplayConflict)) throw e;
      const c = chain[k];
      const base = c.parents[0] ?? null;
      const edited = this.git.writeCommit({
        tree,
        parents: base ? [base] : [],
        author: c.author,
        committer: await this.git.committerIdent(),
        extra: c.extra,
        message: c.message,
      });
      await this.git.flush();
      await this.verify(base, edited, [edited]);
      const todo = [`pick ${edited}`, ...chain.slice(0, k).reverse().map((x) => `pick ${x.sha}`)];
      const finished = await this.rebaseTodo(label, chain, k, todo);
      return finished ? this.result(await this.state(), [[c, edited]], [edited]) : this.result(await this.state(), [], []);
    }
  }

  /**
   * `rewrite`; but if a commit conflicts, `todo()` (lines of a rebase todo, oldest first) is handed
   * to `git rebase -i` instead, which stops at the conflict for the conflict view (see `rebaseTodo`).
   * Null then: there are no new SHAs to tell yet.
   */
  private async rewriteOrStop(
    label: string, chain: RawCommit[], k: number, items: Item[], keepsTree: boolean, todo: () => Promise<string[]>,
  ): Promise<string[] | null> {
    try {
      return await this.rewrite(label, chain, k, items, keepsTree);
    } catch (e) {
      if (!(e instanceof ReplayConflict)) throw e;
      await this.rebaseTodo(label, chain, k, await todo(), e);
      return null;
    }
  }

  /**
   * Replace `chain[0..k]` by a `git rebase -i` onto `chain[k]`'s parent doing `todo`: git replays
   * it and stops at each conflict like any rebase. It starts from a clean working tree (so
   * `git rebase --abort` gets back exactly), after a backup of the tip. True if it finished
   * without stopping. `conflict`: the one that made the in-memory replay give up, for the refusal.
   */
  private async rebaseTodo(label: string, chain: RawCommit[], k: number, todo: string[], conflict?: ReplayConflict): Promise<boolean> {
    const base = chain[k].parents[0] ?? null;
    await this.git.run(['update-index', '-q', '--refresh'], { allowFail: true });
    const status = await this.git.text(['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=none']);
    if (status) {
      throw new GitError(
        conflict
          ? `Resolving the conflict in ${conflict.files.join(', ')} needs a working tree without uncommitted changes (untracked files are fine), so it can always be aborted cleanly. You have:\n${status}\nCommit or stash them first. Nothing was changed.`
          : `This would change files in your working tree, but you have uncommitted changes:\n${status}\nCommit or stash them first. Nothing was changed.`,
      );
    }
    const head = chain[0].sha;
    if ((await this.head()) !== head) throw new GitError('HEAD moved while rewriting; nothing was changed.');
    await this.backup(head, label);
    const file = join(tmpdir(), `legit-todo-${randomBytes(6).toString('hex')}`);
    let r: Awaited<ReturnType<Git['run']>>;
    try {
      await writeFile(file, todo.map((l) => l + '\n').join(''));
      r = await this.git.run(
        [
          '-c', 'rebase.autoStash=false', '-c', 'rebase.updateRefs=false', '-c', 'rebase.missingCommitsCheck=ignore',
          // Keep every commit, as the in-memory replay would: none dropped as empty or as already applied.
          'rebase', '-i', '--no-autosquash', '--reapply-cherry-picks', '--empty=keep', ...(base ? [base] : ['--root']),
        ],
        {
          allowFail: true,
          timeout: 600_000,
          // The todo git writes is replaced by ours.
          env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: `cp '${file.replace(/'/g, "'\\''")}'` },
        },
      );
    } finally {
      await unlink(file).catch(() => {});
    }
    // Stopped on a conflict: the conflict view takes it from here.
    if (this.blocked()) return false;
    const after = await this.head();
    if (r.code !== 0 || !after || after === head) {
      const output = (r.err + r.out.toString('utf8')).trim();
      throw new GitError(
        after === head ? `Replaying the commits failed; nothing was changed.\n${output}` : `Replaying the commits failed.\n${output}`,
      );
    }
    await this.record({ label, before: head, after });
    return true;
  }

  /** Tree of `c`'s parent plus the changed lines of `diff` for which `apply` is true. */
  private async buildTree(c: RawCommit, diff: CommitDiff, apply: (path: string, i: number) => boolean): Promise<string> {
    const zero = '0'.repeat(c.tree.length);
    const records: string[] = [];
    const partial: CommitDiff['files'] = [];
    for (const f of diff.files) {
      const n = f.added + f.removed;
      let count = 0;
      for (let i = 0; i < n; i++) if (apply(f.path, i)) count++;
      // Files without line changes (binary, mode-only) are all-or-nothing on index 0.
      const all = n === 0 ? apply(f.path, 0) : count === n;
      if (all) {
        records.push(f.status === 'D' ? `0 ${zero}\t${f.path}` : `${f.newMode} ${f.newSha}\t${f.path}`);
      } else if (count > 0) {
        if (!f.partial) throw new GitError(`${toUtf8(f.path)} can only be picked as a whole file.`);
        partial.push(f);
      }
      // A renamed file moves with any of its changes (alone, when it has none).
      if (f.status === 'R' && (all || count > 0)) records.push(`0 ${zero}\t${f.oldPath}`);
    }
    const oldBlobs = await this.git.readObjects(partial.filter((f) => f.status !== 'A').map((f) => f.oldSha));
    for (const f of partial) {
      const old = f.status === 'A' ? '' : oldBlobs.get(f.oldSha)!.data.toString('latin1');
      const content = applyLines(old, f.hunks, (i) => apply(f.path, i));
      const sha = this.git.writeObject('blob', Buffer.from(content, 'latin1'));
      records.push(`${f.status === 'D' ? f.oldMode : f.newMode} ${sha}\t${f.path}`);
    }
    await this.git.flush();
    return this.treeWith(await this.git.treeOf(c.parents[0] ?? null), records);
  }

  /** `base` with index records ("mode sha\tpath"; mode 0 deletes) applied, through a throwaway index. */
  private async treeWith(base: string, records: string[]): Promise<string> {
    const index = join(tmpdir(), `legit-index-${randomBytes(6).toString('hex')}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await this.git.run(['read-tree', base], { env });
      if (records.length) {
        await this.git.run(['update-index', '-z', '--index-info'], {
          env,
          input: Buffer.from(records.map((r) => r + '\0').join(''), 'latin1'),
        });
      }
      return (await this.git.text(['write-tree'], { env }));
    } finally {
      await unlink(index).catch(() => {});
    }
  }

  squash(req: SquashRequest): Promise<OpResult> {
    return this.exclusive(async () => {
      if (!req.subject?.trim()) throw new GitError('The squashed commit needs a title.');
      const chain = await this.chain();
      const idx = [...new Set(req.shas)].map((s) => Repo.indexOf(chain, s)).sort((a, b) => b - a);
      if (idx.length < 2) throw new GitError('Select at least two commits to squash.');
      const [k, ...rest] = idx;
      const target: Item = {
        src: chain[k],
        squash: rest.map((i) => chain[i]),
        message: fromUtf8(buildMessage(req.subject, req.body, req.coauthors)),
      };
      const kept = chain.slice(0, k).filter((_, i) => !rest.includes(i));
      // As a rebase: the others fixed up into the oldest, the last of them by a copy with the new message.
      const todo = async () => {
        const last = chain[rest.at(-1)!];
        const copy = this.git.writeCommit({
          tree: last.tree,
          parents: last.parents,
          author: chain[k].author,
          committer: await this.git.committerIdent(),
          extra: chain[k].extra.filter((h) => !h.startsWith('encoding ')),
          message: target.message!,
        });
        await this.git.flush();
        return [
          `pick ${chain[k].sha}`,
          ...rest.slice(0, -1).map((i) => `fixup ${chain[i].sha}`),
          `fixup -C ${copy}`,
          ...kept.toReversed().map((c) => `pick ${c.sha}`),
        ];
      };
      const shas = await this.rewriteOrStop('squash', chain, k, [...kept.map((src) => ({ src })), target], true, todo);
      if (!shas) return this.result(await this.state(), [], []);
      const renamed: [RawCommit, string][] = kept.map((c, i) => [c, shas[i]]);
      for (const i of idx) renamed.push([chain[i], shas.at(-1)!]);
      return this.result(await this.state(), renamed, [shas.at(-1)!]);
    });
  }

  reorder(req: ReorderRequest): Promise<OpResult> {
    return this.exclusive(async () => {
      const chain = await this.chain();
      const bySha = new Map(chain.map((c) => [c.sha, c]));
      if (req.order.length !== chain.length || new Set(req.order).size !== chain.length || !req.order.every((s) => bySha.has(s))) {
        throw new GitError('History changed since the list was loaded; refresh and try again.');
      }
      let k = chain.length - 1;
      while (k >= 0 && req.order[k] === chain[k].sha) k--;
      if (k < 0) return this.result(await this.state(), [], []);
      const moved = req.order.slice(0, k + 1).map((s) => bySha.get(s)!);
      const todo = async () => moved.toReversed().map((c) => `pick ${c.sha}`);
      const shas = await this.rewriteOrStop('reorder', chain, k, moved.map((src) => ({ src })), true, todo);
      if (!shas) return this.result(await this.state(), [], []);
      return this.result(await this.state(), moved.map((c, i) => [c, shas[i]]), []);
    });
  }

  drop(req: DropRequest): Promise<OpResult> {
    return this.exclusive(async () => {
      const chain = await this.chain();
      const idx = req.shas.map((s) => Repo.indexOf(chain, s));
      const k = Math.max(...idx);
      const kept = chain.slice(0, k + 1).filter((_, i) => !idx.includes(i));
      if (!kept.length) {
        if (!chain[k].parents[0]) throw new GitError("Can't drop every commit of the branch.");
        const base = chain[k].parents[0];
        await this.moveHead(chain[0].sha, base, 'drop');
        await this.record({ label: 'drop', before: chain[0].sha, after: base });
        return this.result(await this.state(), [], []);
      }
      const todo = async () => kept.toReversed().map((c) => `pick ${c.sha}`);
      const shas = await this.rewriteOrStop('drop', chain, k, kept.map((src) => ({ src })), false, todo);
      if (!shas) return this.result(await this.state(), [], []);
      return this.result(await this.state(), kept.map((c, i) => [c, shas[i]]), []);
    });
  }

  /** `m` can be undone (`side` 'after') or redone ('before'): what it moved is still where it left it. */
  private async applies(m: Move | undefined, side: 'before' | 'after', head: string | null): Promise<boolean> {
    if (!m) return false;
    if (!m.ref) return m[side] === head;
    return (await this.git.resolve(m.ref)) === m[side];
  }

  /** Move another branch from `from` to `to` (after a backup of `from`), with a compare-and-swap. */
  async moveRef(ref: string, from: string, to: string, label: string) {
    await this.backup(from, label, ref.replace(/^refs\/heads\//, ''));
    const r = await this.git.run(['update-ref', '-m', `legit: ${label}`, ref, to, from], { allowFail: true });
    if (r.code !== 0) throw new GitError(`${ref.replace(/^refs\/heads\//, '')} moved in the meantime; nothing was changed. ${r.err.trim()}`);
  }

  undo(): Promise<OpResult> {
    return this.exclusive(async () => {
      const h = await this.stacks();
      const m = h.undo.at(-1);
      const head = await this.head();
      if (!(await this.applies(m, 'after', head)) || !m) throw new GitError('Nothing to undo.');
      if (m.ref) await this.moveRef(m.ref, m.after, m.before, `undo ${m.label}`);
      else if (m.soft) await this.moveHeadSoft(m.after, m.before, `undo ${m.label}`);
      else await this.moveHead(m.after, m.before, `undo ${m.label}`);
      h.redo.push(h.undo.pop()!);
      return { state: await this.state(), renamed: {}, focus: [] };
    });
  }

  redo(): Promise<OpResult> {
    return this.exclusive(async () => {
      const h = await this.stacks();
      const m = h.redo.at(-1);
      const head = await this.head();
      if (!(await this.applies(m, 'before', head)) || !m) throw new GitError('Nothing to redo.');
      if (m.ref) await this.moveRef(m.ref, m.before, m.after, `redo ${m.label}`);
      else if (m.soft) await this.moveHeadSoft(m.before, m.after, `redo ${m.label}`);
      else await this.moveHead(m.before, m.after, `redo ${m.label}`);
      h.undo.push(h.redo.pop()!);
      return { state: await this.state(), renamed: {}, focus: [] };
    });
  }

  async currentBranch(): Promise<string | null> {
    return (await this.git.headState()).branch;
  }

  private stacksFor(branch: string | null) {
    const key = branch ?? '';
    let h = this.history.get(key);
    if (!h) this.history.set(key, (h = { undo: [], redo: [] }));
    return h;
  }

  private async stacks() {
    return this.stacksFor(await this.currentBranch());
  }

  async record(move: Move) {
    const h = await this.stacks();
    h.undo.push(move);
    h.redo = [];
  }

  /** Uncommitted changes (what's staged included), as a snapshot the UI can page through and stage lines of. */
  async work(): Promise<CommitDiff> {
    // Never read a half-applied stage/unstage/commit.
    await this.idle();
    const head = await this.head();
    if (!head) throw new GitError('This branch has no commits yet.');
    const { diff, index } = await workDiff(this.git, '');
    return this.snapshot(`work:${index}`, diff);
  }

  /** Give a working-tree diff a key, keeping the previous key if nothing changed. */
  snapshot(kind: string, d: CommitDiff): CommitDiff {
    const content = kind + '\0' + d.files.map((f) => f.path + '\0' + f.token).join('\0');
    let key = this.snapshotIds.get(content);
    if (!key || !this.snapshots.has(key)) {
      key = `w${this.nextSnapshot++}`;
      this.snapshotIds.set(content, key);
      this.snapshots.set(key, d);
      while (this.snapshots.size > 20) this.snapshots.delete(this.snapshots.keys().next().value!);
      while (this.snapshotIds.size > 40) this.snapshotIds.delete(this.snapshotIds.keys().next().value!);
    }
    d.sha = key;
    return this.snapshots.get(key)!;
  }

  /**
   * Resolve a selection made on snapshot `key` against a fresh diff of the same kind, refusing
   * if any selected file changed since. Returns the whole files and partial selections.
   */
  async resolve(req: StageRequest, fresh: CommitDiff) {
    const snap = this.snapshots.get(req.key);
    if (!snap) throw new GitError('Those changes are out of date; refresh and select again.');
    const now = new Map(fresh.files.map((f) => [f.path, f]));
    const whole: FileDiff[] = [];
    const partial: { f: FileDiff; picked: Set<number> }[] = [];
    for (const [pathU, sel] of Object.entries(req.selection)) {
      const path = fromUtf8(pathU);
      const shown = snap.files.find((f) => f.path === path);
      const f = now.get(path);
      if (!shown || !f || shown.token !== f.token) {
        throw new GitError(`${pathU} changed since it was shown; nothing was changed. Look again and reselect.`);
      }
      const n = f.added + f.removed;
      if (sel === 'all' || n === 0 || sel.length >= n) whole.push(f);
      else if (sel.length) {
        if (!f.partial) throw new GitError(`${pathU} can only be staged as a whole file.`);
        partial.push({ f, picked: new Set(sel) });
      }
    }
    return { whole, partial };
  }

  /** Paths as NUL-separated pathspecs for --pathspec-from-file. */
  private static pathspecs(files: FileDiff[]) {
    return Buffer.from(files.map((f) => f.path + '\0').join(''), 'latin1');
  }

  /** Stage lines or files of the uncommitted changes. Only the index changes; working-tree files are never touched. */
  stage(req: StageRequest): Promise<OpResult> {
    return this.restage(req, true);
  }

  /** Unstage lines or files: the index goes back towards HEAD. The working tree isn't touched. */
  unstage(req: StageRequest): Promise<OpResult> {
    return this.restage(req, false);
  }

  /**
   * The index with the selected lines staged or not. Lines the file has changed since it was
   * shown can't be picked (refused); what's staged may have changed, and the change applies to
   * it as it is now. A line whose staged version is neither HEAD's nor the file's takes its
   * whole region along (see staging.ts).
   */
  private restage(req: StageRequest, on: boolean): Promise<OpResult> {
    return this.exclusive(async () => {
      const why = this.blocked();
      if (why) throw new GitError(why);
      const { whole, partial } = await this.resolve(req, (await workDiff(this.git, '')).diff);
      const add: FileDiff[] = on ? [...whole] : [];
      const reset: FileDiff[] = on ? [] : whole.filter((f) => !f.untracked);
      const records: string[] = [];
      const heads = await this.git.readObjects(partial.filter(({ f }) => !f.untracked && !/^0+$/.test(f.oldSha)).map(({ f }) => f.oldSha));
      for (const { f, picked } of partial) {
        const head = heads.get(f.oldSha)?.data.toString('latin1') ?? '';
        const s = stagingOf(f, head);
        const next = restage(s.pos, s.index, s.staging, picked, on);
        if (next === s.index) continue;
        // All of it or none of it: as `git add` or `git restore --staged` would, mode included.
        if (next === emit(s.pos, () => true)) add.push(f);
        else if (next === head && !f.untracked) reset.push(f);
        else records.push(`${s.mode} ${this.git.writeObject('blob', Buffer.from(next, 'latin1'))}\t${f.path}`);
      }
      await this.git.flush();
      // A renamed file's old path goes with it: out of the index when it's staged, back when it's not.
      const olds = (list: FileDiff[]) => list.flatMap((f) => (f.oldPath === undefined ? [] : [{ ...f, path: f.oldPath }]));
      if (add.length) {
        await this.git.run(['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
          input: Repo.pathspecs(add),
        });
        const gone = olds(add);
        if (gone.length) {
          await this.git.run(['--literal-pathspecs', 'rm', '-q', '--cached', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], {
            input: Repo.pathspecs(gone),
          });
        }
      }
      if (reset.length) {
        await this.git.run(
          ['--literal-pathspecs', 'restore', '--staged', '--source=HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'],
          { input: Repo.pathspecs([...reset, ...olds(reset)]) },
        );
      }
      if (records.length) await this.updateIndex(records);
      return { state: await this.state(), renamed: {}, focus: [] };
    });
  }

  private async updateIndex(records: string[]) {
    await this.git.run(['update-index', '-z', '--index-info'], {
      input: Buffer.from(records.map((r) => r + '\0').join(''), 'latin1'),
    });
  }

  /** `git commit` of what's staged (hooks and signing config apply). */
  /**
   * `git commit` of what's staged (hooks and signing config apply), or with `amend`, `git commit
   * --amend` (what's staged is folded into HEAD, which gets the new message). Both can be
   * undone: HEAD goes back, and the index and working tree stay as they are.
   */
  commit(req: CommitRequest): Promise<OpResult> {
    return this.exclusive(async () => {
      const why = this.blocked();
      if (why) throw new GitError(why);
      if (!req.subject?.trim()) throw new GitError('A commit needs a title.');
      const before = await this.head();
      if (req.amend) {
        if (!before) throw new GitError('There is no commit to amend yet.');
        await this.backup(before, 'amend');
      } else {
        const staged = await this.git.run(['diff', '--cached', '--quiet'], { allowFail: true });
        if (staged.code === 0) throw new GitError('Nothing is staged.');
      }
      const r = await this.git.run(['commit', ...(req.amend ? ['--amend'] : []), '--cleanup=whitespace', '-F', '-'], {
        input: buildMessage(req.subject, req.body, req.coauthors),
        allowFail: true,
        timeout: 600_000,
      });
      if (r.code !== 0) {
        throw new GitError(`${req.amend ? 'Amend' : 'Commit'} failed.\n${(r.err + r.out.toString('utf8')).trim()}`);
      }
      const head = await this.head();
      if (before && head && head !== before) {
        await this.record({ label: req.amend ? 'amend' : 'commit', before, after: head, soft: true });
      }
      return { state: await this.state(), renamed: {}, focus: head ? [head] : [] };
    });
  }

  /**
   * Undo the last commit, keeping its changes: HEAD moves to its parent, and the index and
   * working tree stay as they are, so the commit's changes show up as staged.
   */
  uncommit(): Promise<OpResult> {
    return this.exclusive(async () => {
      const why = this.blocked();
      if (why) throw new GitError(why);
      const head = await this.head();
      if (!head) throw new GitError('There is no commit to undo.');
      const c = await this.git.commit(head);
      if (c.parents.length === 0) throw new GitError("This is the branch's first commit, so it can't be undone this way.");
      if (c.parents.length > 1) throw new GitError("The last commit is a merge; it can't be undone this way.");
      await this.moveHeadSoft(head, c.parents[0], 'uncommit');
      await this.record({ label: 'uncommit', before: head, after: c.parents[0], soft: true });
      return { state: await this.state(), renamed: {}, focus: [] };
    });
  }

  /** Point HEAD at `to` without touching the index or working tree (after a backup of `from`). */
  private async moveHeadSoft(from: string, to: string, label: string) {
    if (from === to) return;
    await this.backup(from, label);
    const r = await this.git.run(['update-ref', '-m', `legit: ${label}`, 'HEAD', to, from], { allowFail: true });
    if (r.code !== 0) throw new GitError(`HEAD moved in the meantime; nothing was changed. ${r.err.trim()}`);
  }

  /** Upstream of `branch` and how far apart they are, or where publishing it would go. */
  private async pushInfo(branch: string, view?: RefView, remoteNames?: string[]): Promise<PushInfo | null> {
    view ??= await this.refView(branch);
    const names = remoteNames ?? (await this.git.remotes()).names;
    const { sha, upstream, remote, remoteRef } = view;
    const tip = !upstream ? null : upstream.startsWith('refs/remotes/') ? (view.remotes.get(upstream) ?? null) : await this.git.resolve(upstream);
    if (sha && upstream && remote && remoteRef && tip) {
      const [ahead, behind] = await this.git.memo(`ahead-behind ${sha} ${tip}`, async () =>
        (await this.git.text(['rev-list', '--left-right', '--count', `${sha}...${tip}`])).split(/\s+/).map(Number),
      );
      const rewritten = ahead > 0 && behind > 0 && (await this.hadTip(branch, upstream));
      return { remote, branch: remoteRef.replace(/^refs\/heads\//, ''), publish: false, ahead, behind, rewritten, tip };
    }
    // An upstream that isn't on the remote (yet, or any more) is where publishing goes.
    const set = !!remote && names.includes(remote) && remoteRef.startsWith('refs/heads/');
    const target = set ? remote : names.includes('origin') ? 'origin' : names[0];
    if (!target) return null;
    const count = sha
      ? await this.git.memo(`local-count ${sha} ${view.fingerprint}`, () =>
          this.git.text(['rev-list', '--count', sha, '--not', '--remotes'], { allowFail: true }),
        )
      : '';
    const name = set ? remoteRef.slice('refs/heads/'.length) : branch;
    return { remote: target, branch: name, publish: true, ahead: Number(count) || 0, behind: 0, rewritten: false, tip: null };
  }

  /**
   * Was `ref`'s commit ever part of `branch` (reachable from an entry of its reflog)? When a
   * diverged upstream was, the branch was rewritten after pushing; when it wasn't, the remote
   * has new commits. The same test git's --force-if-includes makes.
   */
  private async hadTip(branch: string, ref: string): Promise<boolean> {
    const log = await this.git.text(['reflog', 'show', '--format=%H', `refs/heads/${branch}`, '--'], { allowFail: true });
    const shas = [...new Set(log.split('\n').filter(Boolean))].slice(0, 1000);
    if (!shas.length) return false;
    const r = await this.git.run(['rev-list', '-1', '--stdin'], {
      input: `${ref}\n${shas.map((s) => `^${s}`).join('\n')}\n`,
      allowFail: true,
    });
    return r.code === 0 && r.out.toString('latin1').trim() === '';
  }

  /**
   * Push the current branch. When the remote has commits the branch doesn't, only a force push
   * goes through, and only with `force`:
   * - `true` (after rewriting pushed commits): --force-with-lease --force-if-includes, so git
   *   refuses if the remote has commits this branch never had, fetched or not.
   * - `'overwrite'`: replaces the remote branch as last fetched (`expect`, when given, must still
   *   be that tip), leased on it, so commits pushed since the fetch are never lost.
   * - `'fetch'`: fetches first, then overwrites whatever that brought, commits nobody here saw included.
   */
  push(req: { force?: boolean | 'overwrite' | 'fetch'; expect?: string }): Promise<OpResult> {
    return this.exclusive(async () => {
      const why = this.blocked();
      if (why) throw new GitError(why);
      const branch = await this.currentBranch();
      if (!branch) throw new GitError("HEAD is detached; switch to a branch to push.");
      const force = req.force === true || req.force === 'overwrite' || req.force === 'fetch' ? req.force : false;
      let info = await this.pushInfo(branch);
      if (!info) throw new GitError('This repository has no remote to push to.');
      if (force === 'fetch' && !info.publish) {
        await fetchFrom(this.git, info.remote);
        info = (await this.pushInfo(branch))!;
      }
      const where = `${info.remote}/${info.branch}`;
      const refspec = `refs/heads/${branch}:refs/heads/${info.branch}`;
      const theirs = `${info.behind} commit${info.behind === 1 ? '' : 's'}`;
      let args: string[];
      if (info.publish) args = ['push', '--set-upstream', info.remote, refspec];
      else if (info.behind === 0) {
        if (info.ahead === 0) throw new GitError('Already up to date.');
        args = ['push', info.remote, refspec];
      } else if (!force) {
        throw new GitError(
          `${where} has ${theirs} that ${info.behind === 1 ? "isn't" : "aren't"} on your branch, so a normal push would be refused. ` +
            'Pull to bring them in, or force push to replace them with your branch. Nothing was pushed.',
        );
      } else if (force === true) args = ['push', '--force-with-lease', '--force-if-includes', info.remote, refspec];
      else {
        if (req.expect && req.expect !== info.tip) {
          throw new GitError(`${where} changed since this was shown; nothing was pushed. Look at it again, then force push.`);
        }
        args = ['push', `--force-with-lease=refs/heads/${info.branch}:${info.tip}`, info.remote, refspec];
      }
      const r = await runWithProgress(this.git, 'push', info.remote, args, { allowFail: true, timeout: 120_000, env: await networkEnv(this.git) });
      if (r.code !== 0) {
        const err = r.err.trim();
        if (/updated since checkout/i.test(err)) {
          throw new GitError(
            `Nothing was pushed: ${where} has commits that were never on your branch (pushed by someone else, or by you from ` +
              "somewhere else). They're fetched, so you can look at them in the branch list. A safe force push only replaces " +
              "commits you've had; force push anyway to overwrite them too.",
            'not-integrated',
          );
        }
        if (/stale info|fetch first|non-fast-forward/i.test(err)) {
          throw new GitError(
            `Nothing was pushed: ${where} has new commits since you last fetched, which you haven't seen yet. ` +
              (force ? 'Fetch to look at them, or fetch and force push anyway to overwrite them too.' : `Fetch, then pull them in.\n${err}`),
            force ? 'not-fetched' : undefined,
          );
        }
        throw new GitError(`Push failed.\n${err}`);
      }
      return { state: await this.state(), renamed: {}, focus: [] };
    });
  }

  /** Local branches, most recently committed first. */
  async branches(): Promise<BranchInfo[]> {
    const out = await this.git.text([
      'for-each-ref', '--sort=-committerdate',
      '--format=%(refname:short)%00%(objectname)%00%(subject)%00%(committerdate:unix)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(worktreepath)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(HEAD)',
      'refs/heads',
    ]);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, sha, subject, time, upstream, track, worktree, remote, remoteRef, head] = line.split('\0');
        const here = head === '*';
        const tracking = remote && remote !== '.' && remoteRef.startsWith('refs/heads/') ? { remote, branch: remoteRef.slice('refs/heads/'.length) } : null;
        return {
          name, sha, subject, time: Number(time), upstream: upstream || null, tracking, track: track || null, current: here,
          worktree: !here && worktree ? worktree : null,
        };
      });
  }

  /**
   * `git switch`: refuses (rather than overwriting anything) if local changes are in the way.
   * With `stash`, they're stashed first and stay with the branch being left (see branches.ts).
   */
  switchBranch(req: { branch: string; stash?: boolean }): Promise<OpResult> {
    return switchBranch(this, req);
  }
}
