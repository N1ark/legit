// Worktrees: list, add and remove the repository's linked worktrees. Removing one deletes its
// folder, whatever state it's in: its uncommitted changes and untracked files are stashed first
// (offered back when you switch to its branch), and a detached HEAD no branch has is saved under
// refs/legit/deleted/<folder>/<time> (listed under Recently deleted branches). Removing the one
// you're in moves the window to the main worktree.

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { OpResult, WorktreeInfo, WorktreeRequest } from '../shared/types.ts';
import { DELETED } from './branches.ts';
import { GitError, fromUtf8, run } from './git.ts';
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

/** What removing a worktree would lose for good: its submodules' uncommitted changes and commits on no remote. */
async function wouldLose(w: WorktreeInfo): Promise<string | null> {
  if (w.missing) return null;
  const subs = await run(
    w.path,
    ['submodule', 'foreach', '--quiet', '--recursive', 'test -z "$(git status --porcelain)$(git rev-list -n1 HEAD --not --remotes --tags)" || echo "$displaypath"'],
    { allowFail: true },
  );
  const lost = subs.out.toString('utf8').split('\n').filter(Boolean);
  if (!lost.length) return null;
  const one = lost.length === 1;
  return `Its submodule${one ? '' : 's'} ${lost.join(', ')} ${one ? 'has' : 'have'} uncommitted changes or commits on no remote branch or tag, which go with it.`;
}

/**
 * Save a worktree's uncommitted changes and untracked files before its folder goes: stashed (as when
 * leaving its branch, so switching to it offers them back), or, when git won't stash them (in the
 * middle of a merge, say), committed on top of its HEAD under refs/legit/deleted. Returns what was done.
 */
async function saveChanges(repo: Repo, w: WorktreeInfo): Promise<string | null> {
  if (w.missing) return null;
  const status = await run(w.path, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=all']);
  if (!status.out.length) return null;
  const label = w.branch ? `legit: on ${w.branch}` : `legit: worktree ${w.name}`;
  const stashed = await run(w.path, ['stash', 'push', '--include-untracked', '-m', label], { allowFail: true });
  if (stashed.code === 0) return w.branch ? `Its changes are stashed on ${w.branch}.` : 'Its changes are in the stash list.';
  const index = join(tmpdir(), `legit-index-${randomBytes(6).toString('hex')}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const head = (await run(w.path, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { allowFail: true })).out.toString('utf8').trim();
    await run(w.path, ['read-tree', ...(head ? [head] : ['--empty'])], { env });
    await run(w.path, ['add', '-A', '-f', '--', '.'], { env, allowFail: true });
    const tree = (await run(w.path, ['write-tree'], { env })).out.toString('utf8').trim();
    const ident = await repo.git.committerIdent();
    const sha = repo.git.writeCommit({
      tree, parents: head ? [head] : [], author: ident, committer: ident, extra: [],
      message: fromUtf8(`Uncommitted changes in ${w.name} before removing it\n`),
    });
    await repo.git.flush();
    const ref = `${DELETED}/${w.name.replace(/[^\w-]+/g, '-') || 'worktree'}-changes/${Date.now()}`;
    await repo.git.run(['update-ref', '-m', `legit: changes in worktree ${w.name}`, ref, sha, '']);
    return `Its changes are saved under Recently deleted branches, as ${ref.slice(DELETED.length + 1).replace(/\/\d+$/, '')}.`;
  } finally {
    await unlink(index).catch(() => {});
  }
}

/**
 * Remove a worktree: its folder (ignored files included) and git's record of it, even locked or
 * in the middle of a merge. Its branch stays, and what's uncommitted is saved first (see
 * `saveChanges`); a detached HEAD that no branch, tag or remote branch has is saved too (even when
 * its folder is already gone, and the worktree is only forgotten). What its submodules alone have
 * is lost, so that's asked first: refused, saying so, unless `force`. Removing the one you're in
 * returns the main worktree to go to instead of the state (and, with `open`, its URL).
 */
export function removeWorktree(
  repo: Repo, req: { path: string; force?: boolean }, open?: (path: string) => Promise<string>,
): Promise<OpResult | { moved: string; url?: string; note?: string }> {
  return repo.exclusive(async () => {
    const all = await worktrees(repo);
    const w = all.find((x) => x.path === req.path);
    if (!w) throw new GitError(`There's no worktree at ${req.path}; refresh.`);
    if (w.main) throw new GitError(`Couldn't remove ${w.name}. That's the main worktree, which holds the repository. Nothing was changed.`);
    const lose = req.force ? null : await wouldLose(w);
    if (lose) throw new GitError(`${lose} Remove it anyway?`, 'worktree-loses');

    const notes: string[] = [];
    let saved: string | null = null;
    // A missing one's too: its folder is gone, but its commits are still in the repository.
    if (!w.branch && w.head) {
      const lost = await repo.git.text(['rev-list', '-n1', w.head, '--not', '--branches', '--tags', '--remotes'], { allowFail: true });
      if (lost) {
        saved = `${DELETED}/${w.name.replace(/[^\w-]+/g, '-') || 'worktree'}/${Date.now()}`;
        await repo.git.run(['update-ref', '-m', `legit: backup before removing worktree ${w.name}`, saved, w.head, '']);
        notes.push('Its commits are under Recently deleted branches.');
      }
    }
    const changes = await saveChanges(repo, w);
    if (changes) notes.push(changes);
    const main = all[0];
    const url = w.current && open ? await open(main.path) : undefined;
    // Twice forced: one with changes, submodules or a lock goes too. Run from the main worktree, as this one may be it.
    const r = await run(main.path, ['worktree', 'remove', '--force', '--force', w.path], { allowFail: true });
    if (r.code !== 0) {
      if (saved) await repo.git.run(['update-ref', '-d', saved, w.head!], { allowFail: true });
      throw new GitError(`Couldn't remove ${w.name}.${changes ? ` ${changes}` : ''}\n${r.err.trim()}`);
    }
    const note = notes.join(' ') || undefined;
    // This worktree's folder is gone: nothing more runs in it.
    if (w.current) return { moved: main.path, url, note };
    await pruneRefs(repo.git);
    return { ...(await done(repo)), note };
  });
}

/** The worktree at `path`, if it's one of this repository's (to switch to it). */
export async function findWorktree(repo: Repo, path: string): Promise<WorktreeInfo> {
  const w = (await worktrees(repo)).find((x) => x.path === path);
  if (!w) throw new GitError(`There's no worktree at ${path}; refresh.`);
  if (w.missing) throw new GitError(`${w.short} is gone. Remove the worktree to forget it.`);
  return w;
}
