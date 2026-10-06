// Branches: switch (optionally leaving uncommitted changes in a stash), create, rename, delete
// and bring back, and check out remote branches. A deleted branch's tip is first saved under
// refs/legit/deleted/<branch>/<time> (outside refs/legit/backups, which restores move HEAD to),
// and every ref change is a compare-and-swap.

import type { CreateBranchRequest, DeletedBranch, OpResult, RemoteBranchInfo } from '../shared/types.ts';
import { GitError } from './git.ts';
import type { Repo } from './repo.ts';
import { pruneRefs } from './retention.ts';
import { stashPush, unstash } from './stash.ts';

export const DELETED = 'refs/legit/deleted';

let lastTime = 0;
const uniqueTime = () => (lastTime = Math.max(Date.now(), lastTime + 1));

const done = async (repo: Repo): Promise<OpResult> => ({ state: await repo.state(), renamed: {}, focus: [] });

function guarded(repo: Repo, fn: () => Promise<void>): Promise<OpResult> {
  return repo.exclusive(async () => {
    const why = repo.blocked();
    if (why) throw new GitError(why);
    await fn();
    return done(repo);
  });
}

/** `name` if git accepts it as a new branch name (and doesn't expand it, like `@{-1}`). */
async function validName(repo: Repo, name: string): Promise<string> {
  name = name?.trim() ?? '';
  if (!name) throw new GitError('A branch needs a name.');
  const r = await repo.git.run(['check-ref-format', '--branch', name], { allowFail: true });
  if (r.code !== 0 || r.out.toString('utf8').trim() !== name) throw new GitError(`"${name}" is not a valid branch name.`);
  return name;
}

async function sha(repo: Repo, ref: string): Promise<string | null> {
  return (await repo.git.text(['rev-parse', '-q', '--verify', ref], { allowFail: true })) || null;
}

const localExists = async (repo: Repo, name: string) => !!(await sha(repo, `refs/heads/${name}`));

/**
 * `git switch <args>`, which refuses rather than overwrite local changes. With `stash`, the
 * uncommitted changes are stashed first (left on the branch they were made on), and put back
 * if the switch fails.
 */
async function switchTo(repo: Repo, args: string[], target: string, stash = false) {
  const where = async () => `${await repo.currentBranch()} ${await sha(repo, 'HEAD')}`;
  const before = await where();
  const stashed = stash ? await stashPush(repo.git, await repo.currentBranch()) : null;
  const r = await repo.git.run(['switch', '--no-guess', ...args], { allowFail: true });
  if (r.code === 0) return;
  // A failing post-checkout hook fails the command after the switch happened.
  if ((await where()) !== before) throw new GitError(`Switched to ${target}, but git reported an error:\n${r.err.trim()}`);
  let back = '';
  if (stashed) {
    try {
      await unstash(repo.git, stashed);
      back = ' Your changes were put back.';
    } catch (e) {
      back = ` Your changes are in the stash list (${stashed.slice(0, 7)}); ${e instanceof Error ? e.message : e}`;
    }
  }
  throw new GitError(`Couldn't switch to ${target}; nothing was changed.${back}\n${r.err.trim()}`);
}

/** Switch to a local branch. */
export function switchBranch(repo: Repo, req: { branch: string; stash?: boolean }): Promise<OpResult> {
  return guarded(repo, async () => {
    if (!req.branch || !(await localExists(repo, req.branch))) throw new GitError(`No local branch named ${req.branch}.`);
    await switchTo(repo, [req.branch], req.branch, req.stash);
  });
}

/** Create a branch at HEAD or any commit, and by default switch to it (`git switch -c`). */
export function createBranch(repo: Repo, req: CreateBranchRequest): Promise<OpResult> {
  return guarded(repo, async () => {
    const name = await validName(repo, req.name);
    if (await localExists(repo, name)) throw new GitError(`A branch named ${name} already exists.`);
    const from = await sha(repo, `${req.from || 'HEAD'}^{commit}`);
    if (!from) throw new GitError(req.from ? `Unknown commit ${req.from.slice(0, 7)}.` : 'This branch has no commits yet.');
    if (req.checkout ?? true) await switchTo(repo, ['-c', name, from], name, req.stash);
    else {
      const r = await repo.git.run(['update-ref', '-m', 'legit: create branch', `refs/heads/${name}`, from, ''], { allowFail: true });
      if (r.code !== 0) throw new GitError(`Couldn't create ${name}; nothing was changed.\n${r.err.trim()}`);
    }
  });
}

/** Rename a branch (`git branch -m`); its undo history and backups follow it. */
export function renameBranch(repo: Repo, req: { from: string; to: string }): Promise<OpResult> {
  return guarded(repo, async () => {
    const to = await validName(repo, req.to);
    if (!req.from || !(await localExists(repo, req.from))) throw new GitError(`No local branch named ${req.from}.`);
    if (to === req.from) return;
    if (await localExists(repo, to)) throw new GitError(`A branch named ${to} already exists. Nothing was changed.`);
    const r = await repo.git.run(['branch', '-m', req.from, to], { allowFail: true });
    if (r.code !== 0) throw new GitError(`Couldn't rename ${req.from}; nothing was changed.\n${r.err.trim()}`);

    const h = repo.history.get(req.from);
    if (h) {
      repo.history.set(to, h);
      repo.history.delete(req.from);
    }
    // Move the backups in one transaction; if that fails they stay where they were.
    const from = repo.backupPrefix(req.from);
    const out = await repo.git.text(['for-each-ref', '--format=%(refname) %(objectname)', from]);
    const moves = out
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' '))
      .filter(([ref]) => /^\d+-[\w-]+$/.test(ref.slice(from.length)))
      .map(([ref, s]) => `create ${repo.backupPrefix(to)}${ref.slice(from.length)} ${s}\ndelete ${ref} ${s}\n`);
    if (moves.length) await repo.git.run(['update-ref', '--stdin'], { input: moves.join(''), allowFail: true });
  });
}

/** The worktree that has `branch` checked out, if any. */
async function checkedOutIn(repo: Repo, branch: string): Promise<string | null> {
  const out = await repo.git.text(['worktree', 'list', '--porcelain'], { allowFail: true });
  for (const block of out.split('\n\n')) {
    if (block.split('\n').includes(`branch refs/heads/${branch}`)) return /^worktree (.*)$/m.exec(block)?.[1] ?? '?';
  }
  return null;
}

/** Delete a local branch, after saving its tip under refs/legit/deleted/<branch>/<time>. */
export function deleteBranch(repo: Repo, req: { branch: string }): Promise<OpResult> {
  return guarded(repo, async () => {
    const name = req.branch;
    const ref = `refs/heads/${name}`;
    const tip = name && (await sha(repo, ref));
    if (!tip) throw new GitError(`No local branch named ${name}.`);
    if ((await repo.currentBranch()) === name) throw new GitError(`You're on ${name}; switch to another branch to delete it.`);
    const other = await checkedOutIn(repo, name);
    if (other) throw new GitError(`${name} is checked out in ${other}, so it can't be deleted. Nothing was changed.`);

    const saved = `${DELETED}/${name}/${uniqueTime()}`;
    await repo.git.run(['update-ref', '-m', `legit: backup before deleting ${name}`, saved, tip, '']);
    const r = await repo.git.run(['update-ref', '-m', 'legit: delete branch', '-d', ref, tip], { allowFail: true });
    if (r.code !== 0) {
      await repo.git.run(['update-ref', '-d', saved, tip], { allowFail: true });
      throw new GitError(`${name} changed while deleting it; nothing was changed. ${r.err.trim()}`);
    }
    // Like `git branch -D`: a later branch of the same name shouldn't inherit its upstream.
    await repo.git.run(['config', '--remove-section', `branch.${name}`], { allowFail: true });
    repo.history.delete(name);
    await pruneRefs(repo.git);
  });
}

/** Remote names, longest first (a remote's name can contain a slash). */
async function remotes(repo: Repo): Promise<string[]> {
  return (await repo.git.text(['remote'])).split('\n').filter(Boolean).sort((a, b) => b.length - a.length);
}

/** `refs/remotes/<remote>/<branch>` split into its remote and branch, if it names a remote. */
async function parseRemoteRef(repo: Repo, ref: string) {
  const remote = (await remotes(repo)).find((r) => ref?.startsWith(`refs/remotes/${r}/`));
  return remote ? { remote, branch: ref.slice(`refs/remotes/${remote}/`.length) } : null;
}

/**
 * Delete a branch on a remote, given its remote-tracking branch. Only what this repo has seen
 * goes: the push is leased on the remote-tracking branch, whose tip is first saved under
 * refs/legit/deleted.
 */
export function deleteRemoteBranch(repo: Repo, req: { ref: string }): Promise<OpResult> {
  return guarded(repo, async () => {
    const parsed = await parseRemoteRef(repo, req.ref);
    if (!parsed) throw new GitError(`${req.ref} is not a remote branch.`);
    const { remote, branch } = parsed;
    const tip = await sha(repo, req.ref);
    if (!tip) throw new GitError(`There's no ${remote}/${branch} here; fetch first. Nothing was deleted.`);
    const saved = `${DELETED}/${branch}/${uniqueTime()}-${remote.replace(/[^\w-]+/g, '-')}`;
    await repo.git.run(['update-ref', '-m', `legit: backup before deleting ${remote}/${branch}`, saved, tip, '']);
    const r = await repo.git.run(
      ['push', `--force-with-lease=refs/heads/${branch}:${tip}`, remote, `:refs/heads/${branch}`],
      { allowFail: true, timeout: 120_000 },
    );
    if (r.code !== 0) {
      await repo.git.run(['update-ref', '-d', saved, tip], { allowFail: true });
      throw new GitError(
        /stale info/i.test(r.err)
          ? `${remote}/${branch} has commits you haven't fetched, so it wasn't deleted. Fetch and look at them first.\n${r.err.trim()}`
          : `Couldn't delete ${remote}/${branch}; nothing was deleted.\n${r.err.trim()}`,
      );
    }
    await pruneRefs(repo.git);
  });
}

/** Remote-tracking branches (not `<remote>/HEAD`) that no local branch tracks or shares a name with, or all of them. */
export async function remoteBranches(repo: Repo, all = false): Promise<RemoteBranchInfo[]> {
  const [out, locals, names] = await Promise.all([
    repo.git.text([
      'for-each-ref', '--sort=-committerdate',
      '--format=%(refname)%00%(objectname)%00%(subject)%00%(committerdate:unix)%00%(symref)',
      'refs/remotes',
    ]),
    repo.git.text(['for-each-ref', '--format=%(refname:short)%00%(upstream)', 'refs/heads']),
    remotes(repo),
  ]);
  const local = new Set<string>();
  for (const line of locals.split('\n').filter(Boolean)) {
    const [name, upstream] = line.split('\0');
    local.add(name);
    if (upstream) local.add(upstream);
  }
  const list: RemoteBranchInfo[] = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, sha, subject, time, symref] = line.split('\0');
    const remote = names.find((r) => ref.startsWith(`refs/remotes/${r}/`));
    if (symref || !remote) continue;
    const name = ref.slice(`refs/remotes/${remote}/`.length);
    if (name === 'HEAD' || (!all && (local.has(ref) || local.has(name)))) continue;
    list.push({ ref, remote, name, sha, subject, time: Number(time) });
  }
  return list;
}

/** Create a local branch tracking a remote one and switch to it (`git switch --track`). */
export function checkoutRemote(repo: Repo, req: { ref: string; stash?: boolean }): Promise<OpResult> {
  return guarded(repo, async () => {
    const parsed = await parseRemoteRef(repo, req.ref);
    if (!parsed || !(await sha(repo, req.ref))) throw new GitError(`No remote branch ${req.ref}; fetch and try again.`);
    const name = await validName(repo, parsed.branch);
    if (await localExists(repo, name)) throw new GitError(`A local branch named ${name} already exists; switch to it instead.`);
    await switchTo(repo, ['-c', name, '--track', req.ref], name, req.stash);
  });
}

/** Branches deleted by legit, newest first. */
export async function deletedBranches(repo: Repo): Promise<DeletedBranch[]> {
  const out = await repo.git.text([
    'for-each-ref', '--format=%(refname)%00%(objectname)%00%(subject)', DELETED,
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line): DeletedBranch | null => {
      const [ref, sha, subject] = line.split('\0');
      const slash = ref.lastIndexOf('/');
      const m = /^(\d+)(?:-([\w-]+))?$/.exec(ref.slice(slash + 1));
      const name = ref.slice(DELETED.length + 1, slash);
      return m && name ? { ref, name, sha, subject, time: Number(m[1]), remote: m[2] ?? null } : null;
    })
    .filter((d): d is DeletedBranch => !!d)
    .sort((a, b) => b.time - a.time);
}

/**
 * Recreate a deleted branch (as `name`, or its old name) at its saved tip. Creating the branch
 * and removing the saved ref is one transaction, and refuses if the branch exists.
 */
export function restoreBranch(repo: Repo, req: { ref: string; name?: string }): Promise<OpResult> {
  return guarded(repo, async () => {
    const d = (await deletedBranches(repo)).find((x) => x.ref === req.ref);
    if (!d) throw new GitError('That deleted branch is no longer there; refresh.');
    const name = await validName(repo, req.name || d.name);
    if (await localExists(repo, name)) throw new GitError(`A branch named ${name} already exists. Nothing was changed.`);
    const r = await repo.git.run(['update-ref', '-m', 'legit: restore deleted branch', '--stdin'], {
      input: `create refs/heads/${name} ${d.sha}\ndelete ${d.ref} ${d.sha}\n`,
      allowFail: true,
    });
    if (r.code !== 0) throw new GitError(`Couldn't restore ${name}; nothing was changed.\n${r.err.trim()}`);
  });
}
