// Cherry-picking: commits copied onto another branch (in memory, without checking it out), or
// onto the current one. Onto the current branch it's in memory too when nothing conflicts, and
// otherwise a real `git cherry-pick`, which stops on each conflict for the conflict view.

import type { CommitInfo, SyncResult } from '../shared/types.ts';
import { type Git, GitError, type RawCommit } from './git.ts';
import { type Repo, info } from './repo.ts';
import { carry, done, inProgress, unmergedPaths } from './sync.ts';

/** Commits of another branch listed to pick from, at most. */
const LISTED = 300;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** A local or remote-tracking branch by name, as a full ref. */
async function branchRef(git: Git, name: unknown, local = false): Promise<string> {
  if (typeof name !== 'string' || !name || name.startsWith('-')) throw new GitError('Pick a branch.');
  for (const ref of local ? [`refs/heads/${name}`] : [`refs/heads/${name}`, `refs/remotes/${name}`]) {
    const r = await git.run(['show-ref', '--verify', '--quiet', ref], { allowFail: true });
    if (r.code === 0) return ref;
  }
  throw new GitError(`No ${local ? 'local ' : ''}branch named ${name}.`);
}

/** The commits on `branch` that HEAD doesn't have, newest first, to cherry-pick from. */
export async function branchCommits(repo: Repo, branch: string): Promise<{ commits: CommitInfo[]; total: number }> {
  const git = repo.git;
  const ref = await branchRef(git, branch);
  const head = await repo.head();
  const range = [ref, ...(head ? ['--not', head] : [])];
  const [list, unpushed, total] = await Promise.all([
    git.text(['rev-list', '--topo-order', `--max-count=${LISTED}`, ...range]),
    git.text(['rev-list', '--topo-order', `--max-count=${LISTED}`, ...range, '--remotes']),
    git.text(['rev-list', '--count', ...range]),
  ]);
  const local = new Set(unpushed.split('\n'));
  const commits = list ? await git.loadCommits(list.split('\n')) : [];
  return { commits: commits.map((c) => info(c, local, false)), total: Number(total) };
}

/** The picked commits, oldest first, refusing ones `onto` (named `where`) already has, merges, and unknown ones. */
async function picks(git: Git, shas: unknown, onto: string, where: string): Promise<RawCommit[]> {
  if (!Array.isArray(shas) || !shas.length || !shas.every((s) => typeof s === 'string' && /^[0-9a-f]{4,64}$/.test(s))) {
    throw new GitError('Pick some commits first.');
  }
  const full = await Promise.all(
    shas.map((s: string) => git.text(['rev-parse', '-q', '--verify', `${s}^{commit}`], { allowFail: true })),
  );
  if (full.some((s) => !s)) throw new GitError("Some of those commits don't exist (any more); refresh. Nothing was changed.");
  const want = new Set(full);
  const order = (await git.text(['rev-list', '--topo-order', '--reverse', ...want, '--not', onto])).split('\n').filter((s) => want.has(s));
  if (order.length < want.size) {
    const n = want.size - order.length;
    throw new GitError(`${n === want.size ? (n === 1 ? 'That commit is' : 'Those commits are') : `${plural(n, 'commit')} of those ${n === 1 ? 'is' : 'are'}`} already on ${where}. Nothing was changed.`);
  }
  const commits = await git.loadCommits(order);
  const merge = commits.find((c) => c.parents.length > 1);
  if (merge) throw new GitError(`${merge.sha.slice(0, 7)} is a merge, which can't be cherry-picked here. Nothing was changed.`);
  return commits;
}

/** `commits` replayed onto `onto` in memory; commits whose changes are already there are dropped. Throws on a conflict. */
async function replay(repo: Repo, commits: RawCommit[], onto: string) {
  const git = repo.git;
  const committer = await git.committerIdent();
  const merger = git.merger();
  let parent = onto;
  let parentTree = await git.treeOf(onto);
  const out: string[] = [];
  let dropped = 0;
  try {
    for (const c of commits) {
      const tree = await repo.pickOrThrow(merger, await git.treeOf(c.parents[0] ?? null), parentTree, c);
      if (tree === parentTree) {
        dropped++;
        continue;
      }
      parent = git.writeCommit({ tree, parents: [parent], author: c.author, committer, extra: c.extra, message: c.message });
      parentTree = tree;
      out.push(parent);
    }
    await git.flush();
  } finally {
    merger.close();
  }
  if (out.length) await repo.verify(onto, parent, out);
  const skipped = dropped ? ` (${plural(dropped, 'commit')} already there ${dropped === 1 ? 'was' : 'were'} left out)` : '';
  return { tip: parent, out, skipped };
}

/** Is local branch `name` checked out in another worktree (whose files would then be out of step)? */
async function checkedOutElsewhere(git: Git, name: string): Promise<boolean> {
  const list = await git.text(['worktree', 'list', '--porcelain'], { allowFail: true });
  return list.split('\n\n').some((w) => w.includes(`\nbranch refs/heads/${name}`) && !w.startsWith(`worktree ${git.root}\n`));
}

/**
 * Copy commits onto another local branch without checking it out: they're cherry-picked in memory
 * and the branch moves once (a compare-and-swap, after a backup). Refused, changing nothing, if
 * any conflicts. Undoing it (from the current branch) moves that branch back.
 */
export function copyTo(repo: Repo, req: { shas: string[]; branch: string }): Promise<SyncResult> {
  return repo.exclusive(async () => {
    const git = repo.git;
    const why = repo.blocked();
    if (why) throw new GitError(why);
    const ref = await branchRef(git, req.branch, true);
    const name = req.branch;
    if ((await repo.currentBranch()) === name) throw new GitError(`You're on ${name}: cherry-pick the commits onto it instead.`);
    if (await checkedOutElsewhere(git, name)) {
      throw new GitError(`${name} is checked out in another worktree; cherry-pick there instead. Nothing was changed.`);
    }
    const old = await git.text(['rev-parse', '--verify', `${ref}^{commit}`]);
    const commits = await picks(git, req.shas, old, name);
    let r: Awaited<ReturnType<typeof replay>>;
    try {
      r = await replay(repo, commits, old);
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
      throw new GitError(
        `Copying to ${name} would conflict. ${e.message} Switch to ${name} and cherry-pick ${commits.length === 1 ? 'it' : 'them'} there to resolve the conflicts by hand.`,
      );
    }
    if (!r.out.length) return done(repo, `${name} already has those changes; nothing was copied.`);
    await repo.moveRef(ref, old, r.tip, 'cherry-pick');
    await repo.record({ label: `copy to ${name}`, before: old, after: r.tip, ref });
    return done(repo, `Copied ${plural(r.out.length, 'commit')} to ${name}${r.skipped}.`);
  });
}

/**
 * Cherry-pick commits onto the current branch, oldest first. In memory when nothing conflicts
 * (uncommitted changes come along, as in a rebase); otherwise a real `git cherry-pick`, which
 * stops on each conflict for the conflict view, and needs a working tree without uncommitted
 * changes so that aborting gets back exactly. Either way it's undone in one step.
 */
export function cherryPick(repo: Repo, req: { shas: string[] }): Promise<SyncResult> {
  return repo.exclusive(async () => {
    const git = repo.git;
    const why = repo.blocked();
    if (why) throw new GitError(why);
    const head = await repo.head();
    if (!head) throw new GitError('This branch has no commits yet.');
    const here = (await repo.currentBranch()) ?? 'HEAD';
    const commits = await picks(git, req.shas, head, here);
    let conflict: string;
    try {
      const r = await replay(repo, commits, head);
      if (!r.out.length) return done(repo, `${here} already has those changes; nothing was cherry-picked.`);
      await carry(repo, head, r.tip, 'cherry-pick');
      return done(repo, `Cherry-picked ${plural(r.out.length, 'commit')} onto ${here}${r.skipped}.`, [r.tip]);
    } catch (e) {
      if (!(e instanceof GitError) || !/^Conflict replaying/.test(e.message)) throw e;
      conflict = e.message.replace(/ Nothing was changed\.$/, '');
    }

    await git.run(['update-index', '-q', '--refresh'], { allowFail: true });
    const status = await git.text(['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=none']);
    if (status) {
      throw new GitError(
        `${conflict} Resolving that means stopping at the conflict, which needs a working tree without uncommitted changes (untracked files are fine), so it can always be aborted cleanly. You have:\n${status}\nCommit or stash them first. Nothing was changed.`,
      );
    }
    await repo.backup(head, 'cherry-pick');
    const r = await git.run(['cherry-pick', '--empty=drop', ...commits.map((c) => c.sha)], {
      allowFail: true,
      timeout: 600_000,
      env: { GIT_EDITOR: 'true' },
    });
    const output = (r.err + r.out.toString('utf8')).trim();
    if (inProgress(git) === 'cherry-pick') {
      const n = (await unmergedPaths(git)).size;
      return done(
        repo,
        `Cherry-picking stopped${n ? ` with conflicts in ${plural(n, 'file')}` : ''}. Resolve them, then continue (it stops again at each commit that conflicts), or abort to put everything back.`,
      );
    }
    const after = await repo.head();
    if (r.code !== 0 || !after || after === head) {
      throw new GitError(after === head ? `Cherry-pick failed; nothing was changed.\n${output}` : `Cherry-pick failed.\n${output}`);
    }
    await repo.record({ label: 'cherry-pick', before: head, after });
    return done(repo, `Cherry-picked ${plural(commits.length, 'commit')} onto ${here}.`, [after]);
  });
}
