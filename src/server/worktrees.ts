// Worktrees: list, add and remove the repository's linked worktrees. Removing one deletes its
// folder, so it's refused while it has uncommitted changes, and a detached HEAD no branch has is
// first saved under refs/legit/deleted/<folder>/<time> (listed under Recently deleted branches).

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { OpResult, WorktreeInfo, WorktreeRequest } from '../shared/types.ts';
import { DELETED } from './branches.ts';
import { GitError, run } from './git.ts';
import type { Repo } from './repo.ts';
import { pruneRefs } from './retention.ts';

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** "~/code/legit" for a path under the home directory. */
function short(path: string) {
  const home = homedir();
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** Every worktree of the repository, the main one first (`git worktree list`). */
export async function worktrees(repo: Repo): Promise<WorktreeInfo[]> {
  const out = (await repo.git.run(['worktree', 'list', '--porcelain', '-z'])).out.toString('utf8');
  const here = real(repo.git.root);
  const list: WorktreeInfo[] = [];
  for (const block of out.split('\0\0').filter(Boolean)) {
    const lines = block.split('\0');
    const field = (key: string) => {
      const line = lines.find((l) => l === key || l.startsWith(`${key} `));
      return line === undefined ? null : line.slice(key.length + 1);
    };
    const path = field('worktree');
    if (path === null || field('bare') !== null) continue;
    const branch = field('branch');
    const missing = field('prunable') !== null || !existsSync(path);
    list.push({
      path,
      name: basename(path),
      short: short(path),
      branch: branch?.replace(/^refs\/heads\//, '') ?? null,
      head: field('HEAD'),
      main: !list.length,
      current: !missing && real(path) === here,
      locked: field('locked'),
      missing,
    });
  }
  return list;
}

/** Where a new worktree goes when no folder is given: next to the main one, as `<main>-<branch>`. */
async function defaultPath(repo: Repo, branch: string) {
  const main = (await worktrees(repo))[0]?.path ?? repo.git.root;
  const stem = join(dirname(main), `${basename(main)}-${branch.replace(/[^\w.-]+/g, '-')}`);
  let path = stem;
  for (let n = 2; existsSync(path); n++) path = `${stem}-${n}`;
  return path;
}

/** `path` as typed: `~` is the home directory, and a relative path is from this worktree's root. */
function typedPath(repo: Repo, path: string) {
  if (path === '~' || path.startsWith('~/')) path = join(homedir(), path.slice(1));
  return isAbsolute(path) ? resolve(path) : resolve(repo.git.root, path);
}

const done = async (repo: Repo): Promise<OpResult> => ({ state: await repo.state(), renamed: {}, focus: [] });

/**
 * Add a worktree for a branch: an existing local one (refused by git if it's checked out
 * elsewhere), or a new one from `from` (HEAD by default), tracking it with `track`.
 */
export function addWorktree(repo: Repo, req: WorktreeRequest): Promise<OpResult & { path: string }> {
  return repo.exclusive(async () => {
    const name = req.branch?.trim() ?? '';
    if (!name) throw new GitError('A worktree needs a branch.');
    const ok = await repo.git.run(['check-ref-format', '--branch', name], { allowFail: true });
    if (ok.code !== 0 || ok.out.toString('utf8').trim() !== name) throw new GitError(`"${name}" is not a valid branch name.`);
    const path = req.path?.trim() ? typedPath(repo, req.path.trim()) : await defaultPath(repo, name);
    const exists = (await repo.git.run(['rev-parse', '-q', '--verify', `refs/heads/${name}`], { allowFail: true })).code === 0;

    let args: string[];
    if (exists) {
      if (req.from) throw new GitError(`A branch named ${name} already exists. Nothing was changed.`);
      const other = (await worktrees(repo)).find((w) => w.branch === name);
      if (other) throw new GitError(`${name} is already checked out in ${other.short}. Nothing was changed.`);
      args = [path, name];
    } else {
      const from = req.from || 'HEAD';
      const r = await repo.git.run(['rev-parse', '-q', '--verify', `${from}^{commit}`], { allowFail: true });
      if (r.code !== 0) throw new GitError(req.from ? `Unknown commit ${req.from}.` : 'This branch has no commits yet.');
      args = [req.track ? '--track' : '--no-track', '-b', name, path, req.track ? from : r.out.toString('utf8').trim()];
    }
    if (existsSync(path) && readdirSync(path).length) throw new GitError(`${short(path)} already exists and isn't empty. Nothing was changed.`);
    const r = await repo.git.run(['worktree', 'add', '--quiet', ...args], { allowFail: true });
    if (r.code !== 0) {
      if (existsSync(join(path, '.git'))) throw new GitError(`Added the worktree at ${short(path)}, but git reported an error:\n${r.err.trim()}`);
      throw new GitError(`Couldn't add a worktree at ${short(path)}; nothing was changed.\n${r.err.trim()}`);
    }
    return { ...(await done(repo)), path };
  });
}

/** Why a worktree can't be removed as it is, if it can't. */
async function removable(w: WorktreeInfo): Promise<string | null> {
  if (w.main) return "That's the main worktree, which holds the repository; it can't be removed.";
  if (w.current) return "You're in it; switch to another worktree to remove it.";
  if (w.locked !== null) return `It's locked${w.locked ? ` (${w.locked})` : ''}; unlock it with \`git worktree unlock\` first.`;
  if (w.missing) return null;
  const dir = (await run(w.path, ['rev-parse', '--path-format=absolute', '--git-dir'])).out.toString('utf8').trim();
  const progress = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'];
  if (progress.some((f) => existsSync(join(dir, f)))) return 'A merge, rebase, cherry-pick, revert or bisect is in progress in it.';
  const status = await run(w.path, ['status', '--porcelain', '-z', '--untracked-files=normal', '--ignore-submodules=none']);
  if (status.out.length) return 'It has uncommitted changes or untracked files: commit, stash or discard them there first.';
  // Its submodules' repositories go with it, and any commits only they have.
  const subs = await run(w.path, ['submodule', 'foreach', '--quiet', '--recursive', 'test -z "$(git rev-list -n1 HEAD --not --remotes --tags)" || echo "$displaypath"'], { allowFail: true });
  const unpushed = subs.out.toString('utf8').split('\n').filter(Boolean);
  if (unpushed.length) return `Its submodule${unpushed.length === 1 ? '' : 's'} ${unpushed.join(', ')} ${unpushed.length === 1 ? 'has' : 'have'} commits on no remote branch or tag: push them first.`;
  return null;
}

/**
 * Remove a worktree: its folder (ignored files included) and git's record of it. Its branch
 * stays; a detached HEAD that no branch, tag or remote branch has is saved first (even when its
 * folder is already gone, and the worktree is only forgotten).
 */
export function removeWorktree(repo: Repo, req: { path: string }): Promise<OpResult> {
  return repo.exclusive(async () => {
    const w = (await worktrees(repo)).find((x) => x.path === req.path);
    if (!w) throw new GitError(`There's no worktree at ${req.path}; refresh.`);
    const why = await removable(w);
    if (why) throw new GitError(`Couldn't remove ${w.name}. ${why} Nothing was changed.`);

    let saved: string | null = null;
    // A missing one's too: its folder is gone, but its commits are still in the repository.
    if (!w.branch && w.head) {
      const lost = await repo.git.text(['rev-list', '-n1', w.head, '--not', '--branches', '--tags', '--remotes'], { allowFail: true });
      if (lost) {
        saved = `${DELETED}/${w.name.replace(/[^\w-]+/g, '-') || 'worktree'}/${Date.now()}`;
        await repo.git.run(['update-ref', '-m', `legit: backup before removing worktree ${w.name}`, saved, w.head, '']);
      }
    }
    // --force: git won't remove one with submodules otherwise; `removable` has checked it's clean.
    const r = await repo.git.run(['worktree', 'remove', '--force', w.path], { allowFail: true });
    if (r.code !== 0) {
      if (saved) await repo.git.run(['update-ref', '-d', saved, w.head!], { allowFail: true });
      throw new GitError(`Couldn't remove ${w.name}; nothing was changed.\n${r.err.trim()}`);
    }
    await pruneRefs(repo.git);
    return done(repo);
  });
}

/** The worktree at `path`, if it's one of this repository's (to switch to it). */
export async function findWorktree(repo: Repo, path: string): Promise<WorktreeInfo> {
  const w = (await worktrees(repo)).find((x) => x.path === path);
  if (!w) throw new GitError(`There's no worktree at ${path}; refresh.`);
  if (w.missing) throw new GitError(`${w.short} is gone. Remove the worktree to forget it.`);
  return w;
}
