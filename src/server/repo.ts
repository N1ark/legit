// History rewriting. Every operation replays the affected tail of the first-parent
// chain in memory (commit objects are written directly, cherry-picks go through
// `git merge-tree`), then moves HEAD once. Nothing touches the working tree unless
// the final tree differs from the old one.

import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  Backup, BranchInfo, CommitDiff, CommitInfo, DropRequest, EditRequest, OpResult, RepoState, ReorderRequest, SplitRequest, SquashRequest,
} from '../shared/types.ts';
import { applyLines, commitDiff } from './diff.ts';
import { Git, GitError, type Merger, type RawCommit, formatIdent, fromUtf8, parseIdent, toUtf8 } from './git.ts';
import { buildMessage, parseMessage } from './message.ts';

/** How many commits to show, and how many past the first merge (not editable). */
const LIMIT = 1000;
const PAST_MERGE = 20;
const BACKUPS = 'refs/legit/backups';
const MAX_BACKUPS = 500;

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
}

export class Repo {
  readonly git: Git;
  /** Undo/redo history per branch (or detached HEAD). */
  private history = new Map<string, { undo: Move[]; redo: Move[] }>();
  private diffs = new Map<string, CommitDiff>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastBackup = 0;

  constructor(git: Git) {
    this.git = git;
  }

  static async open(path: string) {
    return new Repo(await Git.open(path));
  }

  /** Resolves once no operation is running. */
  idle(): Promise<void> {
    return this.queue.then(() => {});
  }

  /** Serialise mutating operations. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }

  private async head(): Promise<string | null> {
    const r = await this.git.run(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { allowFail: true });
    return r.code === 0 ? r.out.toString('latin1').trim() : null;
  }

  private blocked(): string | null {
    const d = this.git.gitDir;
    if (existsSync(join(d, 'rebase-merge')) || existsSync(join(d, 'rebase-apply'))) return 'A rebase is in progress.';
    if (existsSync(join(d, 'MERGE_HEAD'))) return 'A merge is in progress.';
    if (existsSync(join(d, 'CHERRY_PICK_HEAD'))) return 'A cherry-pick is in progress.';
    if (existsSync(join(d, 'REVERT_HEAD'))) return 'A revert is in progress.';
    if (existsSync(join(d, 'BISECT_LOG'))) return 'A bisect is in progress.';
    return null;
  }

  async state(): Promise<RepoState> {
    const [head, branch] = await Promise.all([
      this.head(),
      this.git.text(['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true }),
    ]);
    const state: RepoState = {
      root: this.git.root,
      name: basename(this.git.root),
      branch: branch || null,
      head,
      commits: [],
      blocked: head ? this.blocked() : 'This branch has no commits yet.',
      canUndo: this.stacksFor(branch || null).undo.at(-1)?.after === head,
      canRedo: this.stacksFor(branch || null).redo.at(-1)?.before === head,
    };
    if (!head) return state;

    const [list, unpushed] = await Promise.all([
      this.git.text(['rev-list', '--first-parent', `--max-count=${LIMIT}`, head]),
      this.git.text(['rev-list', '--first-parent', `--max-count=${LIMIT}`, head, '--not', '--remotes']),
    ]);
    const local = new Set(unpushed.split('\n'));
    const commits = await this.git.loadCommits(list.split('\n'));
    let editable = true;
    let past = 0;
    for (const c of commits) {
      const merge = c.parents.length > 1;
      if (merge) editable = false;
      if (!editable && past++ > PAST_MERGE) break;
      const msg = parseMessage(toUtf8(c.message));
      const a = parseIdent(toUtf8(c.author));
      state.commits.push({
        sha: c.sha,
        ...msg,
        author: { name: a.name, email: a.email, time: a.time },
        pushed: !local.has(c.sha),
        editable,
        merge,
      } satisfies CommitInfo);
    }
    return state;
  }

  /** The editable part of the first-parent chain, newest first. */
  private async chain(): Promise<RawCommit[]> {
    const why = this.blocked();
    if (why) throw new GitError(why);
    const head = await this.head();
    if (!head) throw new GitError('This branch has no commits yet.');
    const list = await this.git.text(['rev-list', '--first-parent', `--max-count=${LIMIT}`, head]);
    const all = await this.git.loadCommits(list.split('\n'));
    const end = all.findIndex((c) => c.parents.length > 1);
    return end < 0 ? all : all.slice(0, end);
  }

  private static indexOf(chain: RawCommit[], sha: string): number {
    const i = chain.findIndex((c) => c.sha === sha);
    if (i < 0) throw new GitError(`Commit ${sha.slice(0, 7)} is not editable (history may have changed; refresh).`);
    return i;
  }

  async diff(sha: string): Promise<CommitDiff> {
    let d = this.diffs.get(sha);
    if (!d) {
      d = await commitDiff(this.git, sha);
      if (this.diffs.size > 200) this.diffs.delete(this.diffs.keys().next().value!);
      this.diffs.set(sha, d);
    }
    return d;
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
  private async verify(base: string | null, tip: string, oldestFirst: string[]) {
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

  private async pickOrThrow(merger: Merger, base: string, onto: string, c: RawCommit): Promise<string> {
    const r = await merger.pick(base, onto, c.tree);
    if ('tree' in r) return r.tree;
    const subject = parseMessage(toUtf8(c.message)).subject;
    throw new GitError(
      `Conflict replaying ${c.sha.slice(0, 7)} "${subject}" in: ${r.conflicts.map(toUtf8).join(', ')}. Nothing was changed.`,
    );
  }

  /**
   * Point HEAD at `to`. The old tip is first saved under refs/legit/backups. The index and
   * working tree are only touched if the snapshot changes, and then only when there are no
   * uncommitted changes to tracked files (git itself refuses to overwrite untracked ones).
   */
  private async moveHead(from: string, to: string, label: string) {
    if (from === to) return;
    const treeChanged = (await this.git.treeOf(from)) !== (await this.git.treeOf(to));
    if (treeChanged) {
      await this.git.run(['update-index', '-q', '--refresh'], { allowFail: true });
      const status = await this.git.text(['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=none']);
      if (status) {
        throw new GitError(
          `This would change files in your working tree, but you have uncommitted changes:\n${status}\nCommit or stash them first. Nothing was changed.`,
        );
      }
    }
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

  private backupPrefix(branch: string | null) {
    return `${BACKUPS}/${branch ?? '_detached'}/`;
  }

  /** Save `sha` under refs/legit/backups/<branch>/<time>-<label>; keeps the newest MAX_BACKUPS per branch. */
  private async backup(sha: string, label: string) {
    const branch = (await this.git.text(['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true })) || null;
    const prefix = this.backupPrefix(branch);
    label = label.replace(/[^\w]+/g, '-');
    const time = Math.max(Date.now(), this.lastBackup + 1);
    this.lastBackup = time;
    await this.git.run(['update-ref', '-m', `legit: backup before ${label}`, `${prefix}${time}-${label}`, sha, '']);
    const refs = (await this.git.text(['for-each-ref', '--format=%(refname)', prefix])).split('\n').filter(Boolean);
    const own = refs.filter((r) => /^\d+-[\w-]+$/.test(r.slice(prefix.length))).sort();
    const stale = own.slice(0, Math.max(0, own.length - MAX_BACKUPS));
    if (stale.length) {
      await this.git.run(['update-ref', '--stdin'], { input: stale.map((r) => `delete ${r}\n`).join('') });
    }
  }

  async backups(): Promise<Backup[]> {
    const branch = (await this.git.text(['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true })) || null;
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
      const sel = new Map(Object.entries(req.selection).map(([p, v]) => [fromUtf8(p), v]));
      if (![...sel.values()].some((v) => v === 'all' || v.length)) throw new GitError('Select some changes to split out first.');

      // The first of the two commits applies the changes for which `first` is true.
      const selected = (path: string, i: number) => {
        const v = sel.get(path);
        return v === 'all' || (v?.includes(i) ?? false);
      };
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
        if (!f.partial) throw new GitError(`${toUtf8(f.path)} can only be split as a whole file.`);
        partial.push(f);
      }
    }
    const oldBlobs = await this.git.readObjects(partial.filter((f) => f.status !== 'A').map((f) => f.oldSha));
    for (const f of partial) {
      const old = f.status === 'A' ? '' : oldBlobs.get(f.oldSha)!.data.toString('latin1');
      const content = applyLines(old, f.hunks, (i) => apply(f.path, i));
      const sha = this.git.writeObject('blob', Buffer.from(content, 'latin1'));
      records.push(`${f.status === 'D' ? f.oldMode : f.newMode} ${sha}\t${f.path}`);
    }

    await this.git.flush();
    const index = join(tmpdir(), `legit-index-${randomBytes(6).toString('hex')}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await this.git.run(['read-tree', await this.git.treeOf(c.parents[0] ?? null)], { env });
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
      const shas = await this.rewrite('squash', chain, k, [...kept.map((src) => ({ src })), target], true);
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
      const shas = await this.rewrite('reorder', chain, k, moved.map((src) => ({ src })), true);
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
      const shas = await this.rewrite('drop', chain, k, kept.map((src) => ({ src })), false);
      return this.result(await this.state(), kept.map((c, i) => [c, shas[i]]), []);
    });
  }

  undo(): Promise<OpResult> {
    return this.exclusive(async () => {
      const h = await this.stacks();
      const m = h.undo.at(-1);
      const head = await this.head();
      if (!m || m.after !== head) throw new GitError('Nothing to undo.');
      await this.moveHead(m.after, m.before, `undo ${m.label}`);
      h.redo.push(h.undo.pop()!);
      return { state: await this.state(), renamed: {}, focus: [] };
    });
  }

  redo(): Promise<OpResult> {
    return this.exclusive(async () => {
      const h = await this.stacks();
      const m = h.redo.at(-1);
      const head = await this.head();
      if (!m || m.before !== head) throw new GitError('Nothing to redo.');
      await this.moveHead(m.before, m.after, `redo ${m.label}`);
      h.undo.push(h.redo.pop()!);
      return { state: await this.state(), renamed: {}, focus: [] };
    });
  }

  private async currentBranch(): Promise<string | null> {
    return (await this.git.text(['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true })) || null;
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

  private async record(move: Move) {
    const h = await this.stacks();
    h.undo.push(move);
    h.redo = [];
  }

  /** Local branches, most recently committed first. */
  async branches(): Promise<BranchInfo[]> {
    const [out, current] = await Promise.all([
      this.git.text([
        'for-each-ref', '--sort=-committerdate',
        '--format=%(refname:short)%00%(objectname)%00%(subject)%00%(committerdate:unix)%00%(upstream:short)%00%(upstream:track,nobracket)',
        'refs/heads',
      ]),
      this.currentBranch(),
    ]);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, sha, subject, time, upstream, track] = line.split('\0');
        return { name, sha, subject, time: Number(time), upstream: upstream || null, track: track || null, current: name === current };
      });
  }

  /** `git switch`: refuses (rather than overwriting anything) if local changes are in the way. */
  switchBranch(req: { branch: string }): Promise<OpResult> {
    return this.exclusive(async () => {
      const why = this.blocked();
      if (why) throw new GitError(why);
      const ref = `refs/heads/${req.branch}`;
      const exists = await this.git.run(['show-ref', '--verify', '--quiet', ref], { allowFail: true });
      if (exists.code !== 0) throw new GitError(`No local branch named ${req.branch}.`);
      const r = await this.git.run(['switch', '--no-guess', req.branch], { allowFail: true });
      if (r.code !== 0) throw new GitError(`Couldn't switch to ${req.branch}; nothing was changed.\n${r.err.trim()}`);
      return { state: await this.state(), renamed: {}, focus: [] };
    });
  }
}
