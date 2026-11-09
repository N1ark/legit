// Uncommitted changes never stop an operation. When HEAD moves to a commit with other files, they
// come along, merged onto it in memory first (staged changes stay staged), so nothing is touched
// unless it all goes through. If they'd conflict, they're stashed, HEAD moves, and the stash is
// restored with its conflicts left for the conflict view (Abort puts it back in the stash list).
// Operations that may stop halfway (a real rebase, merge or cherry-pick, editing a commit's files)
// put them aside first, in the stash list, and bring them back once the operation is over.

import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Git, GitError } from './git.ts';
import type { Repo } from './repo.ts';
import { dropEntry, restoreStash } from './stash.ts';
import { inProgress } from './sync.ts';

/** The stash legit put the uncommitted changes in while an operation runs, kept in the git dir. */
const AUTOSTASH = 'legit-autostash';

const refresh = (git: Git) => git.run(['update-index', '-q', '--refresh'], { allowFail: true });

/** `git stash create`: a stash of the tracked changes, staged and not, without touching anything. Null when there are none. */
async function snapshot(git: Git): Promise<string | null> {
  await refresh(git);
  return (await git.text(['stash', 'create'], { allowFail: true })) || null;
}

/** A stash's working-tree and index trees, and the commit it was made on. */
async function stashTrees(git: Git, sha: string) {
  const s = await git.commit(sha);
  return { base: s.parents[0], worktree: s.tree, index: await git.treeOf(s.parents[1]) };
}

/** The stash's changes (worktree and index) picked onto `onto`'s tree; null when either conflicts. */
async function mergeOnto(git: Git, stash: { base: string; worktree: string; index: string }, onto: string) {
  const [base, target] = await Promise.all([git.treeOf(stash.base), git.treeOf(onto)]);
  const merger = git.merger();
  try {
    const worktree = await merger.pick(base, target, stash.worktree);
    if (!('tree' in worktree)) return null;
    const index = await merger.pick(base, target, stash.index);
    return 'tree' in index ? { worktree: worktree.tree, index: index.tree } : null;
  } finally {
    merger.close();
  }
}

/**
 * Turn the working tree from `from` (its tracked files) into `to`, then the index into `index`; `between`
 * runs after the files changed and undoes them if it throws. Git refuses, changing nothing, rather than
 * overwrite an untracked file. `staged`: the index to put back if it fails.
 */
async function switchFiles(git: Git, from: string, to: string, index: string, staged: string, between: () => Promise<void>) {
  // Without -u, --reset only rewrites the index, keeping the stat data of entries that don't change.
  await git.run(['read-tree', '--reset', from]);
  await refresh(git);
  const r = await git.run(['read-tree', '-m', '-u', from, to], { allowFail: true });
  if (r.code !== 0) {
    await git.run(['read-tree', '--reset', staged], { allowFail: true });
    await refresh(git);
    throw new GitError(`Untracked files are in the way, so nothing was changed. Move them away first.\n${r.err.trim()}`);
  }
  try {
    await between();
  } catch (e) {
    await git.run(['read-tree', '-m', '-u', to, from], { allowFail: true });
    await git.run(['read-tree', '--reset', staged], { allowFail: true });
    await refresh(git);
    throw e;
  }
  await git.run(['read-tree', '--reset', index]);
  await refresh(git);
}

/**
 * Move HEAD from `from` to `to`: `setRef` moves it (a compare-and-swap that throws if HEAD moved), and
 * the index and working tree follow, keeping uncommitted changes. Returns a note for the user when
 * they conflicted with `to` and were restored with conflicts to resolve.
 */
export async function moveWork(repo: Repo, from: string, to: string, label: string, setRef: () => Promise<void>): Promise<string | null> {
  const git = repo.git;
  if ((await git.treeOf(from)) === (await git.treeOf(to))) {
    await setRef();
    return null;
  }
  await refresh(git);
  // What `git switch` does: fine when nothing uncommitted is in a file that changes.
  const plain = await git.run(['read-tree', '-m', '-u', from, to], { allowFail: true });
  if (plain.code === 0) {
    try {
      await setRef();
    } catch (e) {
      await git.run(['read-tree', '-m', '-u', to, from], { allowFail: true });
      throw e;
    }
    return null;
  }
  const sha = await snapshot(git);
  if (!sha) throw new GitError(`Untracked files are in the way, so nothing was changed. Move them away first.\n${plain.err.trim()}`);
  const stash = await stashTrees(git, sha);
  if (stash.base !== from) throw new GitError('HEAD moved in the meantime; nothing was changed.');
  const merged = await mergeOnto(git, stash, to);
  if (merged) {
    await switchFiles(git, stash.worktree, merged.worktree, merged.index, stash.index, setRef);
    return null;
  }
  // They conflict with `to`: stashed, HEAD moves, and they're restored with the conflicts to resolve.
  const kept = await pushTracked(repo, label);
  const back = async () => {
    await restoreStash(git, kept, true, false).catch(() => {});
  };
  const r = await git.run(['read-tree', '-m', '-u', from, to], { allowFail: true });
  if (r.code !== 0) {
    await back();
    throw new GitError(`Untracked files are in the way, so nothing was changed. Move them away first.\n${r.err.trim()}`);
  }
  try {
    await setRef();
  } catch (e) {
    await git.run(['read-tree', '-m', '-u', to, from], { allowFail: true });
    await back();
    throw e;
  }
  return conflictsBack(repo, kept);
}

/** `git stash push` of the tracked changes only (untracked files stay where they are). Returns the stash. */
export async function pushTracked(repo: Repo, label: string): Promise<string> {
  const git = repo.git;
  const branch = await repo.currentBranch();
  const before = await git.resolve('refs/stash');
  const r = await git.run(['stash', 'push', '-m', `legit: your changes before ${label}${branch ? ` on ${branch}` : ''}`], { allowFail: true });
  const after = await git.resolve('refs/stash');
  if (r.code !== 0 || !after || after === before) throw new GitError(`Couldn't put your uncommitted changes aside; nothing was changed.\n${r.err.trim()}`);
  return after;
}

/** Restore stash `sha` (from the list) with its conflicts left to resolve, saying so. */
async function conflictsBack(repo: Repo, sha: string, ok = 'Your uncommitted changes came along.'): Promise<string> {
  try {
    await restoreStash(repo.git, sha, true, true);
  } catch (e) {
    return `Your uncommitted changes couldn't be put back, so they're in the stash list (${sha.slice(0, 7)}). ${e instanceof Error ? e.message : e}`;
  }
  if (!inProgress(repo.git)) return ok;
  return "Your uncommitted changes conflict with the result: they're back with the conflicts to resolve. Done keeps them; Abort puts them in the stash list.";
}

/**
 * Before an operation that may stop halfway: put the uncommitted changes to tracked files aside, in
 * the stash list (untracked files stay), to come back with `restoreAutostash` once it's over.
 */
export async function autostash(repo: Repo, label: string): Promise<boolean> {
  const git = repo.git;
  if (!(await snapshot(git))) return false;
  const sha = await pushTracked(repo, label);
  await writeFile(join(git.gitDir, AUTOSTASH), sha);
  return true;
}

/** What to say when an operation stopped with the uncommitted changes put aside. */
export const ASIDE = "Your uncommitted changes are put aside (in the stash list) until it's over, then they come back.";

/**
 * Once nothing is in progress: bring back the changes `autostash` put aside, on top of HEAD as it is now.
 * Returns what to tell the user, or null when there was nothing to bring back.
 */
export async function restoreAutostash(repo: Repo): Promise<string | null> {
  const git = repo.git;
  if (inProgress(git)) return null;
  const sha = await readFile(join(git.gitDir, AUTOSTASH), 'utf8').then((s) => s.trim(), () => '');
  if (!sha) return null;
  await unlink(join(git.gitDir, AUTOSTASH)).catch(() => {});
  const listed = await git.text(['stash', 'list', '--format=%H'], { allowFail: true });
  if (!listed.split('\n').includes(sha)) return null;
  return reapply(repo, sha);
}

/**
 * Bring back stash `sha` (from the list) on top of HEAD as it is now: merged in memory, staged changes
 * staged again, and dropped from the list; or, when it conflicts, restored with the conflicts to resolve.
 */
export async function reapply(repo: Repo, sha: string, ok = 'Your uncommitted changes are back.'): Promise<string> {
  const git = repo.git;
  const head = await repo.head();
  const stash = await stashTrees(git, sha);
  const merged = head && !(await snapshot(git)) ? await mergeOnto(git, stash, head) : null;
  if (head && merged) {
    try {
      const tree = await git.treeOf(head);
      await switchFiles(git, tree, merged.worktree, merged.index, tree, async () => {});
      await dropEntry(git, sha, 'pop');
      return ok;
    } catch {
      // Left to the stash's own restore, below.
    }
  }
  return conflictsBack(repo, sha, ok);
}

/**
 * Stash `sha`'s changes merged into the uncommitted changes as they are, in memory first: true once
 * done, false (nothing changed) when they conflict, or the stash has untracked files to bring back.
 */
export async function mergeIntoWork(git: Git, sha: string): Promise<boolean> {
  const s = await git.commit(sha);
  const head = (await git.headState()).head;
  // `--include-untracked` adds a third parent even with no untracked files.
  if (!head || (s.parents[2] && (await git.treeOf(s.parents[2])) !== git.emptyTree)) return false;
  const current = await snapshot(git);
  const tree = await git.treeOf(head);
  const work = current ? await stashTrees(git, current) : { base: head, worktree: tree, index: tree };
  const stash = await stashTrees(git, sha);
  const base = await git.treeOf(stash.base);
  const merger = git.merger();
  let worktree: string, index: string;
  try {
    const w = await merger.pick(base, work.worktree, stash.worktree);
    const i = 'tree' in w ? await merger.pick(base, work.index, stash.index) : null;
    if (!('tree' in w) || !i || !('tree' in i)) return false;
    [worktree, index] = [w.tree, i.tree];
  } finally {
    merger.close();
  }
  await switchFiles(git, work.worktree, worktree, index, work.index, async () => {});
  return true;
}

/** `restoreAutostash`'s note appended to `message`. */
export async function withAutostash(repo: Repo, message: string): Promise<string> {
  const back = await restoreAutostash(repo);
  return back ? `${message} ${back}` : message;
}
