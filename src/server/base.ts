// The repo's default branch, for "Rebase on main": the one `<remote>/HEAD` points at, else main,
// else master, as a local branch or on the remote.

import type { BaseBranch } from '../shared/types.ts';
import type { Git } from './git.ts';
import { remoteFor } from './sync.ts';

/** The first of `names` with a branch here or on `remote`, given every ref that exists (refname → sha). */
export function defaultBranch(names: string[], remote: string | null, refs: Map<string, string>): string | null {
  return names.find((n) => refs.has(`refs/heads/${n}`) || (remote && refs.has(`refs/remotes/${remote}/${n}`))) ?? null;
}

/**
 * Which of the default branch and its remote-tracking branch to rebase onto: the one that has
 * everything the other has (the freshest), else, when they've diverged, the remote's, which is
 * what the branch will be merged into. `localBehind`: the local one is an ancestor of the remote's.
 */
export function freshest(local: string | null, remote: string | null, localBehind: boolean, remoteBehind: boolean): 'local' | 'remote' | null {
  if (!local || !remote) return local ? 'local' : remote ? 'remote' : null;
  return remoteBehind && !localBehind ? 'local' : 'remote';
}

/** The default branch to rebase the current one onto; null when on it, detached, or there's none. */
export async function baseBranch(git: Git, branch: string | null, head: string | null): Promise<BaseBranch | null> {
  if (!branch || !head) return null;
  const remote = await remoteFor(git, branch);
  const remoteHead = remote ? await git.text(['symbolic-ref', '-q', '--short', `refs/remotes/${remote}/HEAD`], { allowFail: true }) : '';
  const names = [...new Set([remote && remoteHead ? remoteHead.slice(remote.length + 1) : '', 'main', 'master'].filter(Boolean))];
  const patterns = names.flatMap((n) => [`refs/heads/${n}`, ...(remote ? [`refs/remotes/${remote}/${n}`] : [])]);
  const out = await git.text(['for-each-ref', '--format=%(refname) %(objectname)', ...patterns]);
  const refs = new Map(out.split('\n').filter(Boolean).map((l) => l.split(' ') as [string, string]));
  const name = defaultBranch(names, remote, refs);
  if (!name || name === branch) return null;
  const local = refs.get(`refs/heads/${name}`) ?? null;
  const tracking = remote ? (refs.get(`refs/remotes/${remote}/${name}`) ?? null) : null;
  const ancestor = async (a: string, b: string) => (await git.run(['merge-base', '--is-ancestor', a, b], { allowFail: true })).code === 0;
  const both = local && tracking && local !== tracking;
  const pick = freshest(local, tracking, !!both && (await ancestor(local, tracking)), !!both && (await ancestor(tracking, local)));
  const target = pick === 'local' ? name : `${remote}/${name}`;
  const sha = pick === 'local' ? local! : tracking!;
  const behind = Number(await git.text(['rev-list', '--count', sha, '--not', head]));
  return { name: target, behind };
}
