// Stashes: leave uncommitted changes on a branch and bring them back later. A stash is only
// applied when it can't conflict, and before an entry leaves the stash list (pop or drop) its
// commit is saved under refs/legit/stashes, so a dropped stash can always be applied again.

import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { DroppedStash, OpResult, StashEntry, Stashes } from '../shared/types.ts';
import { type Git, GitError, toUtf8 } from './git.ts';
import type { Repo } from './repo.ts';
import { pruneRefs } from './retention.ts';

export const DROPPED = 'refs/legit/stashes';
/** Our stash message is `legit: on <branch>`; git puts `On <branch>: ` in front. */
const OURS = /: legit: on ([^:]+)$/;

let lastTime = 0;
const uniqueTime = () => (lastTime = Math.max(Date.now(), lastTime + 1));

/** The stash list, newest first. */
async function list(git: Git): Promise<{ sha: string; message: string; time: number }[]> {
  const out = await git.text(['stash', 'list', '--format=%H%x00%gs%x00%ct'], { allowFail: true });
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, message, time] = line.split('\0');
      return { sha, message, time: Number(time) * 1000 };
    });
}

/** Paths a stash touches (byte strings): tracked changes from its base, and its untracked files. */
async function stashPaths(git: Git, sha: string): Promise<{ tracked: string[]; untracked: string[] }> {
  const c = await git.commit(sha);
  if (c.parents.length < 2) throw new GitError(`${sha.slice(0, 7)} is not a stash.`);
  const names = async (args: string[]) =>
    (await git.run(args)).out.toString('latin1').split('\0').filter(Boolean);
  const [worktree, index, untracked] = await Promise.all([
    names(['diff-tree', '-r', '-z', '--name-only', '--no-renames', c.parents[0], sha]),
    names(['diff-tree', '-r', '-z', '--name-only', '--no-renames', c.parents[0], c.parents[1]]),
    c.parents[2] ? names(['ls-tree', '-r', '-z', '--name-only', c.parents[2]]) : [],
  ]);
  return { tracked: [...new Set([...worktree, ...index])], untracked };
}

async function entry(git: Git, s: { sha: string; message: string; time: number }): Promise<StashEntry> {
  const { tracked, untracked } = await stashPaths(git, s.sha);
  const branch = OURS.exec(s.message)?.[1] ?? null;
  return { ...s, branch, legit: branch !== null, files: [...tracked, ...untracked].map(toUtf8) };
}

/** The newest stash legit made when leaving `branch`, if any. */
export async function stashFor(git: Git, branch: string | null): Promise<StashEntry | null> {
  if (!branch) return null;
  const s = (await list(git)).find((x) => OURS.exec(x.message)?.[1] === branch);
  return s ? entry(git, s) : null;
}

/** Every stash, plus the dropped ones that are kept under refs/legit/stashes. */
export async function stashes(git: Git): Promise<Stashes> {
  const entries = await Promise.all((await list(git)).map((s) => entry(git, s)));
  const out = await git.text(['for-each-ref', '--sort=-refname', '--format=%(refname)%00%(objectname)%00%(subject)', DROPPED]);
  const dropped = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, sha, message] = line.split('\0');
      const m = /^(\d+)-(\w+)$/.exec(ref.slice(DROPPED.length + 1));
      return m && { ref, sha, message, time: Number(m[1]), label: m[2] };
    })
    .filter((d): d is DroppedStash => !!d);
  return { entries, dropped };
}

/**
 * `git stash push --include-untracked`, labelled with the branch the changes were made on.
 * Returns the new stash's SHA, or null when there was nothing to stash.
 */
export async function stashPush(git: Git, branch: string | null): Promise<string | null> {
  const top = () => git.text(['rev-parse', '-q', '--verify', 'refs/stash'], { allowFail: true });
  const before = await top();
  const label = branch ? `legit: on ${branch}` : 'legit: detached HEAD';
  const r = await git.run(['stash', 'push', '--include-untracked', '-m', label], { allowFail: true });
  if (r.code !== 0) throw new GitError(`Couldn't stash your changes; nothing was changed.\n${r.err.trim()}`);
  const after = await top();
  return after && after !== before ? after : null;
}

/**
 * Refuse unless applying stash `sha` can't conflict: no uncommitted changes to the files it
 * touches, none of its files already on disk where it would create them, and its changes
 * merge cleanly onto HEAD (checked in memory with `git merge-tree`).
 */
async function checkApply(git: Git, sha: string) {
  const c = await git.commit(sha);
  const { tracked, untracked } = await stashPaths(git, sha);
  const unmerged = await git.text(['ls-files', '-u']);
  if (unmerged) throw new GitError('There are unresolved conflicts in the index. Nothing was changed.');

  await git.run(['update-index', '-q', '--refresh'], { allowFail: true });
  const status = (await git.run(['status', '--porcelain', '-z', '--untracked-files=no', '--no-renames'])).out
    .toString('latin1')
    .split('\0')
    .filter(Boolean)
    .map((e) => e.slice(3));
  const mine = new Set([...tracked, ...untracked]);
  const overlap = status.filter((p) => mine.has(p));
  if (overlap.length) {
    throw new GitError(
      `You have uncommitted changes to files the stash also changes: ${overlap.map(toUtf8).join(', ')}. Commit or stash them first. Nothing was changed.`,
    );
  }

  // Files the stash would create must not exist yet (untracked, ignored, or tracked here).
  const head = (await git.run(['rev-parse', '-q', '--verify', 'HEAD'], { allowFail: true })).out.toString('latin1').trim();
  const indexed = new Set<string>();
  const paths = [...mine];
  for (let i = 0; i < paths.length; i += 500) {
    const chunk = paths.slice(i, i + 500).map((p) => Buffer.from(p, 'latin1').toString('utf8'));
    const out = await git.run(['--literal-pathspecs', 'ls-files', '-z', '--cached', '--', ...chunk]);
    for (const p of out.out.toString('latin1').split('\0')) if (p) indexed.add(p);
  }
  const inTheWay = [
    ...untracked.filter((p) => indexed.has(p) || onDisk(git.root, p)),
    ...tracked.filter((p) => !indexed.has(p) && onDisk(git.root, p)),
  ];
  if (inTheWay.length) {
    throw new GitError(
      `The stash would create files that already exist: ${[...new Set(inTheWay)].map(toUtf8).join(', ')}. Move them away first. Nothing was changed.`,
    );
  }

  if (head && head !== c.parents[0]) {
    const r = await git.run(
      ['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${c.parents[0]}`, head, sha],
      { allowFail: true },
    );
    if (r.code !== 0) {
      const [, ...conflicts] = r.out.toString('latin1').split('\n').filter(Boolean);
      if (r.code === 1) {
        throw new GitError(
          `The stash conflicts with this branch in: ${conflicts.map(toUtf8).join(', ')}. Nothing was changed; the stash is kept.`,
        );
      }
      throw new GitError(`Couldn't check the stash against this branch; nothing was changed.\n${r.err.trim()}`);
    }
  }
}

function onDisk(root: string, path: string) {
  try {
    lstatSync(join(root, Buffer.from(path, 'latin1').toString('utf8')));
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply stash `sha` after `checkApply`. The index is restored too when the stash was made on
 * the current commit (it then can't fail); otherwise everything comes back as changes.
 */
export async function applyStash(git: Git, sha: string) {
  await checkApply(git, sha);
  const c = await git.commit(sha);
  const head = await git.text(['rev-parse', '-q', '--verify', 'HEAD'], { allowFail: true });
  const index = head === c.parents[0] ? ['--index'] : [];
  const r = await git.run(['stash', 'apply', ...index, sha], { allowFail: true });
  const unmerged = await git.text(['ls-files', '-u']);
  if (r.code !== 0 || unmerged) {
    throw new GitError(
      `Git couldn't apply the stash cleanly; it's kept, so nothing is lost. Look at your working tree.\n${(r.err + r.out.toString('utf8')).trim()}`,
    );
  }
}

/** Save `sha` under refs/legit/stashes/<time>-<label>, kept for two weeks (see retention.ts). */
async function keep(git: Git, sha: string, label: string) {
  await git.run(['update-ref', '-m', `legit: keep stash before ${label}`, `${DROPPED}/${uniqueTime()}-${label}`, sha, '']);
  await pruneRefs(git);
}

/**
 * Remove stash `sha` from the stash list, after saving it under refs/legit/stashes. The stash
 * list is addressed by position, so anything else that left it meanwhile is saved too.
 */
async function dropEntry(git: Git, sha: string, label: string) {
  const before = await list(git);
  const n = before.findIndex((s) => s.sha === sha);
  if (n < 0) throw new GitError('That stash is no longer in the stash list; refresh.');
  await keep(git, sha, label);
  const r = await git.run(['stash', 'drop', '-q', `stash@{${n}}`], { allowFail: true });
  const after = new Set((await list(git)).map((s) => s.sha));
  for (const s of before) if (s.sha !== sha && !after.has(s.sha)) await keep(git, s.sha, label);
  if (r.code !== 0 || after.has(sha)) throw new GitError(`Couldn't remove the stash from the list; it's still there.\n${r.err.trim()}`);
}

const done = async (repo: Repo): Promise<OpResult> => ({ state: await repo.state(), renamed: {}, focus: [] });

/** A SHA from the stash list, or a dropped stash kept by legit. */
async function known(git: Git, sha: string, dropped = false) {
  if ((await list(git)).some((s) => s.sha === sha)) return;
  if (dropped) {
    const kept = await git.text(['for-each-ref', '--format=%(objectname)', DROPPED]);
    if (kept.split('\n').includes(sha)) return;
  }
  throw new GitError('That stash is no longer there; refresh.');
}

function guarded(repo: Repo, fn: () => Promise<void>): Promise<OpResult> {
  return repo.exclusive(async () => {
    const why = repo.blocked();
    if (why) throw new GitError(why);
    await fn();
    return done(repo);
  });
}

/** Stash all uncommitted changes (untracked files included). */
export function stash(repo: Repo): Promise<OpResult> {
  return guarded(repo, async () => {
    if (!(await stashPush(repo.git, await repo.currentBranch()))) throw new GitError('There are no changes to stash.');
  });
}

/** Apply a stash and keep it (also works for a dropped one). */
export function stashApply(repo: Repo, req: { sha: string }): Promise<OpResult> {
  return guarded(repo, async () => {
    await known(repo.git, req.sha, true);
    await applyStash(repo.git, req.sha);
  });
}

/** Apply a stash, then remove it from the list (only after a clean apply). */
export function stashPop(repo: Repo, req: { sha: string }): Promise<OpResult> {
  return guarded(repo, async () => {
    await known(repo.git, req.sha);
    await applyStash(repo.git, req.sha);
    await dropEntry(repo.git, req.sha, 'pop');
  });
}

/** Remove a stash from the list; it stays under refs/legit/stashes. */
export function stashDrop(repo: Repo, req: { sha: string }): Promise<OpResult> {
  return guarded(repo, async () => {
    await known(repo.git, req.sha);
    await dropEntry(repo.git, req.sha, 'drop');
  });
}

/** Put back changes stashed by a switch that then failed (HEAD hasn't moved, so this is clean). */
export async function unstash(git: Git, sha: string) {
  await applyStash(git, sha);
  await dropEntry(git, sha, 'pop');
}
