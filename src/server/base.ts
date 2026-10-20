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

/**
 * The default branch to rebase the current one onto; null when on it, detached, or there's none.
 * `known`: the remote the branch syncs with and every remote-tracking ref, when already read.
 */
export async function baseBranch(
  git: Git,
  branch: string | null,
  head: string | null,
  known?: { remote: string | null; refs: Map<string, string> },
): Promise<BaseBranch | null> {
  if (!branch || !head) return null;
  const remote = known ? known.remote : await remoteFor(git, branch);
  const remoteHead = remote ? await remoteDefault(git, remote) : '';
  const names = [...new Set([remoteHead, 'main', 'master'].filter(Boolean))];
  const refs = (known && (await knownRefs(git, names, remote, known.refs))) || (await listRefs(git, names, remote));
  const name = defaultBranch(names, remote, refs);
  if (!name || name === branch) return null;
  const local = refs.get(`refs/heads/${name}`) ?? null;
  const tracking = remote ? (refs.get(`refs/remotes/${remote}/${name}`) ?? null) : null;
  // Each answer only depends on the commits asked about, so it's kept.
  const ancestor = (a: string, b: string) =>
    git.memo(`is-ancestor ${a} ${b}`, async () => (await git.run(['merge-base', '--is-ancestor', a, b], { allowFail: true })).code === 0);
  const both = local && tracking && local !== tracking;
  const [localBehind, remoteBehind] = both ? await Promise.all([ancestor(local, tracking), ancestor(tracking, local)]) : [false, false];
  const pick = freshest(local, tracking, localBehind, remoteBehind);
  const target = pick === 'local' ? name : `${remote}/${name}`;
  const sha = pick === 'local' ? local! : tracking!;
  const behind = await git.memo(`behind ${sha} ${head}`, async () => Number(await git.text(['rev-list', '--count', sha, '--not', head])));
  return { name: target, behind };
}

/** The branch `<remote>/HEAD` points at, e.g. main for origin/main. */
async function remoteDefault(git: Git, remote: string): Promise<string> {
  const ref = `refs/remotes/${remote}/HEAD`;
  const prefix = `refs/remotes/${remote}/`;
  const target = await git.readSymref(ref);
  if (target !== undefined) return target?.startsWith(prefix) ? target.slice(prefix.length) : '';
  const short = await git.text(['symbolic-ref', '-q', '--short', ref], { allowFail: true });
  return short ? short.slice(remote.length + 1) : '';
}

/** The candidates' refs from what's known, reading local branches from their files; null if one can't be read that way. */
async function knownRefs(git: Git, names: string[], remote: string | null, remotes: Map<string, string>): Promise<Map<string, string> | null> {
  const refs = new Map<string, string>();
  for (const n of names) {
    const local = await git.readRef(`refs/heads/${n}`);
    if (local === undefined) return null;
    if (local) refs.set(`refs/heads/${n}`, local);
    const tracking = remote && remotes.get(`refs/remotes/${remote}/${n}`);
    if (tracking) refs.set(`refs/remotes/${remote}/${n}`, tracking);
  }
  return refs;
}

async function listRefs(git: Git, names: string[], remote: string | null): Promise<Map<string, string>> {
  const patterns = names.flatMap((n) => [`refs/heads/${n}`, ...(remote ? [`refs/remotes/${remote}/${n}`] : [])]);
  const out = await git.text(['for-each-ref', '--format=%(refname) %(objectname)', ...patterns]);
  return new Map(out.split('\n').filter(Boolean).map((l) => l.split(' ') as [string, string]));
}
