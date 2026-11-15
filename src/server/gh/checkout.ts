// Checking out a pull request. Its head is fetched from the base repository's remote (`pull/N/head`,
// so a fork's works too) into refs/legit/pull/N/head, then put on a local branch: the head branch's
// name when it's on a remote you have (tracking it there), else `<owner>/<branch>` (a fork's, tracking
// nothing), else `pr/N`. The branch is made or fast-forwarded, then switched to or given a worktree of
// its own. One that has diverged from the pull request is only reset when asked (its tip kept in Backups).

import type { CheckoutPlan } from '../../shared/gh-inbox.ts';
import type { OpResult } from '../../shared/types.ts';
import { switchTo } from '../branches.ts';
import { type Git, GitError } from '../git.ts';
import { githubRepo } from '../github.ts';
import { runWithProgress } from '../progress.ts';
import type { Repo } from '../repo.ts';
import { carry, networkEnv } from '../sync.ts';
import { addWorktree, worktrees } from '../worktrees.ts';
import { MOCK, graphql } from './client.ts';
import { dropPrRefs, prHeld, sweepPrRefs } from './prdiff.ts';
import { needGhRepos } from './context.ts';
import { isLive } from '../../shared/github.ts';
import { prState } from './pulls.ts';
import type { PostRoute } from './routes.ts';

export const PULL = 'refs/legit/pull';

/** What of a pull request's head decides where it goes. */
export interface PrHead {
  number: number;
  /** The head branch's name, in its repository. */
  head: string;
  /** Its repository's owner. */
  owner: string;
}

const number = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new GitError('Which pull request?');
  return n;
};

/** The remote that is `repo` on GitHub (`upstream`, then `origin`, first), if there's one. */
export async function remoteFor(git: Git, repo: string): Promise<string | null> {
  const { names, urls } = await git.remotes();
  const is = (n: string) => githubRepo(urls.get(n) ?? '')?.toLowerCase() === repo.toLowerCase();
  return ['upstream', 'origin', ...names].find((n) => names.includes(n) && is(n)) ?? null;
}

/** Fetch `pull/N/head` from `remote` (and `branch` too, into its remote-tracking branch); returns the head. */
export async function fetchPrHead(git: Git, remote: string, n: number, branch?: string | null): Promise<string> {
  const pull = `+refs/pull/${n}/head:${PULL}/${n}/head`;
  const env = await networkEnv(git);
  const go = (specs: string[]) => runWithProgress(git, 'fetch', remote, ['fetch', '--no-tags', remote, ...specs], { allowFail: true, timeout: 120_000, env });
  let r = await go(branch ? [pull, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`] : [pull]);
  // The head branch may be gone (merged and deleted) while the pull request's ref stays.
  if (r.code !== 0 && branch) r = await go([pull]);
  if (r.code !== 0) {
    throw new GitError(r.code < 0 ? `Fetching #${n} from ${remote} timed out; nothing was changed.` : `Couldn't fetch #${n} from ${remote}; nothing was changed.\n${r.err.trim()}`);
  }
  const sha = await git.resolve(`${PULL}/${n}/head`);
  if (!sha) throw new GitError(`Fetched #${n}, but its head isn't here.`);
  return sha;
}

/** Commits only on `a`, and only on `b`. */
async function counts(git: Git, a: string, b: string): Promise<[number, number]> {
  const [x, y] = (await git.text(['rev-list', '--left-right', '--count', `${a}...${b}`])).split(/\s+/).map(Number);
  return [x, y];
}

/** What `branch` tracks, as its config says. */
async function tracked(git: Git, branch: string): Promise<{ remote: string; merge: string } | null> {
  const [remote, merge] = await Promise.all(['remote', 'merge'].map((k) => git.text(['config', '--get', `branch.${branch}.${k}`], { allowFail: true })));
  return remote && merge ? { remote, merge } : null;
}

const validName = async (git: Git, name: string) => {
  const r = await git.run(['check-ref-format', '--branch', name], { allowFail: true });
  return r.code === 0 && r.out.toString('utf8').trim() === name;
};

/** `name`, else `name-2`, `name-3`…: the first no branch has. */
async function freeName(git: Git, name: string): Promise<string> {
  let out = name;
  for (let i = 2; await git.resolve(`refs/heads/${out}`); i++) out = `${name}-${i}`;
  return out;
}

/**
 * Where pull request `pr`, fetched at `sha`, goes: the head branch's name when it's on `remote` (one
 * you have for its repository) and that name is free or tracks it there; else `<owner>/<branch>`
 * when that's free or yours from before (tracking nothing, and in its history); else `pr/N`.
 */
export async function planCheckout(repo: Repo, pr: PrHead, sha: string, remote: string | null): Promise<CheckoutPlan> {
  const git = repo.git;
  const upstream = remote ? { remote, branch: pr.head } : null;
  const fallback = `pr/${pr.number}`;
  const candidate = remote ? pr.head : `${pr.owner}/${pr.head}`;
  let branch = fallback;
  let tip: string | null = null;
  for (const name of [candidate, fallback]) {
    if (name !== fallback && !(await validName(git, name))) continue;
    const t = await git.resolve(`refs/heads/${name}`);
    const up = t && (await tracked(git, name));
    const fits =
      !t || name === fallback
      || (up ? !!upstream && up.remote === upstream.remote && up.merge === `refs/heads/${upstream.branch}` : (await counts(git, t, sha)).includes(0));
    if (fits) {
      [branch, tip] = [name, t || null];
      break;
    }
  }
  const [ahead, behind] = tip ? await counts(git, tip, sha) : [0, 0];
  const relation = !tip ? 'new' : !ahead && !behind ? 'same' : !ahead ? 'behind' : !behind ? 'ahead' : 'diverged';
  const [current, list] = await Promise.all([repo.currentBranch(), worktrees(repo)]);
  const worktree = list.find((w) => w.branch === branch && !w.current && !w.missing)?.path ?? null;
  const alternative = await freeName(git, branch === fallback ? `${fallback}-2` : fallback);
  const head = `${pr.owner}:${pr.head}`;
  return { number: pr.number, sha, branch, tip, relation, ahead, behind, head, upstream, current: current === branch, worktree, alternative, addRemote: null };
}

export interface CheckoutRequest {
  number: number;
  sha: string;
  branch: string;
  /** The branch's tip the plan saw; null to create it. */
  tip: string | null;
  upstream?: { remote: string; branch: string } | null;
  /** The fork's remote to add first, for `upstream` to be on (see `forkRemote`). */
  addRemote?: { name: string; url: string } | null;
  /** `owner:branch` of the head, noted on a branch that tracks nothing (see context.ts). */
  head?: string;
  /** Reset a branch that has diverged to the pull request. */
  reset?: boolean;
  /** Leave uncommitted changes on the branch being left (see `switchTo`). */
  stash?: boolean;
  /** Add a worktree for it rather than switching to it. */
  newWorktree?: boolean;
}

/**
 * Do what `planCheckout` planned, if the branch is still where it was: make or move it to the pull
 * request's head, set what it tracks (when it tracked nothing), then switch to it, or add a worktree
 * for it next to the repository's. Returns the state, the branch, and the worktree's path.
 */
export async function checkoutPr(repo: Repo, req: CheckoutRequest): Promise<OpResult & { branch: string; path?: string }> {
  const git = repo.git;
  const n = number(req?.number);
  // The plan's commit, which its ref (gone once nothing shows the pull request) needn't still name.
  const at = await git.resolve(`${PULL}/${n}/head`);
  const sha = typeof req.sha === 'string' && /^[0-9a-f]{40,64}$/.test(req.sha) ? req.sha : null;
  if (!sha || (at && at !== sha)) throw new GitError(`#${n} was fetched again meanwhile; try again.`);
  if ((await git.run(['cat-file', '-e', `${sha}^{commit}`], { allowFail: true })).code !== 0) throw new GitError(`#${n}'s head isn't here any more; try again.`);
  const branch = String(req.branch ?? '');
  if (!(await validName(git, branch))) throw new GitError(`"${branch}" is not a valid branch name.`);
  if (req.addRemote && req.upstream?.remote === req.addRemote.name) await addFork(git, req.addRemote, req.upstream.branch);
  const up = req.upstream && (await git.remotes()).names.includes(req.upstream.remote) && (await validName(git, req.upstream.branch)) ? req.upstream : null;
  const label = `check out #${n}`;
  const state = await repo.exclusive(async () => {
    const why = repo.blocked();
    if (why) throw new GitError(why);
    const tip = await git.resolve(`refs/heads/${branch}`);
    if (tip !== (req.tip || null)) throw new GitError(`${branch} changed meanwhile; nothing was changed. Try again.`);
    const current = (await repo.currentBranch()) === branch;
    const other = (await worktrees(repo)).find((w) => w.branch === branch && !w.current && !w.missing);
    if (other) throw new GitError(`${branch} is checked out in ${other.short}. Nothing was changed.`);
    if (req.newWorktree && current) throw new GitError(`${branch} is checked out here already. Nothing was changed.`);
    const [ahead, behind] = tip ? await counts(git, tip, sha) : [0, 0];
    if (ahead && behind && !req.reset) {
      throw new GitError(`${branch} and #${n} have diverged (${ahead} commit${ahead === 1 ? '' : 's'} only on ${branch}, ${behind} only on #${n}). Nothing was changed.`, 'pr-diverged');
    }
    const hadUpstream = tip ? !!(await tracked(git, branch)) : false;
    if (!tip && !req.newWorktree) await switchTo(repo, ['-c', branch, sha], branch, req.stash);
    else if (!tip) {
      const r = await git.run(['update-ref', '-m', `legit: ${label}`, `refs/heads/${branch}`, sha, ''], { allowFail: true });
      if (r.code !== 0) throw new GitError(`Couldn't create ${branch}; nothing was changed.\n${r.err.trim()}`);
    } else if (behind && current) await carry(repo, tip, sha, label);
    else if (behind) {
      // Its own commits stay in its backups, as a reset of the branch you're on keeps them.
      if (ahead) await repo.backup(tip, label, branch);
      const r = await git.run(['update-ref', '-m', `legit: ${label}`, `refs/heads/${branch}`, sha, tip], { allowFail: true });
      if (r.code !== 0) throw new GitError(`${branch} moved meanwhile; nothing was changed. ${r.err.trim()}`);
    }
    if (up && !hadUpstream) {
      await git.run(['config', `branch.${branch}.remote`, up.remote]);
      await git.run(['config', `branch.${branch}.merge`, `refs/heads/${up.branch}`]);
    }
    if (!hadUpstream && (!up || req.addRemote) && typeof req.head === 'string' && /^[\w.-]+:[^\s]+$/.test(req.head)) {
      // GitHub looks a branch's pull request up by its name: this one's is another.
      await git.run(['config', `branch.${branch}.legit-head`, req.head]);
    }
    if (tip && !current && !req.newWorktree) await switchTo(repo, [branch], branch, req.stash);
    return { state: await repo.state(), renamed: {}, focus: [], note: repo.takeNote() };
  });
  if (!req.newWorktree) return { ...state, branch };
  const w = await addWorktree(repo, { branch });
  return { ...w, note: state.note, branch };
}

/** Add the fork's remote (unless it's there already, as that URL) and fetch its branch, for the branch to track. */
async function addFork(git: Git, fork: { name: string; url: string }, branch: string) {
  if (!/^[\w.-]+$/.test(fork.name) || fork.name.startsWith('-') || (!MOCK && !githubRepo(fork.url))) throw new GitError(`Bad remote ${fork.name} (${fork.url}).`);
  if (!(await validName(git, branch))) throw new GitError(`"${branch}" is not a valid branch name.`);
  const { names, urls } = await git.remotes();
  if (names.includes(fork.name) && urls.get(fork.name) !== fork.url) throw new GitError(`A remote named ${fork.name} is there already, for ${urls.get(fork.name)}; try again.`);
  if (!names.includes(fork.name)) {
    const r = await git.run(['remote', 'add', fork.name, fork.url], { allowFail: true });
    if (r.code !== 0) throw new GitError(`Couldn't add the remote ${fork.name}; nothing was changed.\n${r.err.trim()}`);
  }
  const r = await runWithProgress(git, 'fetch', fork.name, ['fetch', '--no-tags', fork.name, `+refs/heads/${branch}:refs/remotes/${fork.name}/${branch}`], {
    allowFail: true,
    timeout: 120_000,
    env: await networkEnv(git),
  });
  if (r.code !== 0) throw new GitError(`Added the remote ${fork.name}, but couldn't fetch ${branch} from it; nothing else was changed.\n${r.err.trim()}`);
}

/** The pull request's head branch, its repository, and whether it's still open. */
async function prHead(repo: Repo, n: number) {
  const r = await needGhRepos(repo);
  const d = await graphql(
    `query PrCheckout($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          number state isDraft headRefName maintainerCanModify headRepository { nameWithOwner url sshUrl } headRepositoryOwner { login }
        }
      }
      viewer { login }
    }`,
    { owner: r.owner, name: r.name, number: n },
  );
  const p = d.repository?.pullRequest;
  if (!p) throw new GitError(`${r.base} has no pull request #${n}.`);
  return {
    base: r.base, number: n, head: p.headRefName as string, live: isLive(prState(p)),
    repo: (p.headRepository?.nameWithOwner ?? null) as string | null, owner: (p.headRepositoryOwner?.login ?? 'ghost') as string,
    url: (p.headRepository?.url ?? null) as string | null, sshUrl: (p.headRepository?.sshUrl ?? null) as string | null,
    // Its branch takes pushes from you: maintainers may push to it, or it's your fork.
    pushable: !!p.maintainerCanModify || (p.headRepositoryOwner?.login ?? '').toLowerCase() === (d.viewer?.login ?? '').toLowerCase(),
  };
}

/**
 * The remote to add for a fork whose branch takes your pushes, so its branch can track it there: named
 * after its owner, with the same kind of URL (SSH or HTTPS) as the base repository's remote.
 */
async function forkRemote(git: Git, pr: { repo: string | null; owner: string; url: string | null; sshUrl: string | null; pushable: boolean }, base: string) {
  if (!pr.repo || !pr.pushable || !pr.url) return null;
  const { names, urls } = await git.remotes();
  const ssh = /^(git@|ssh:)/.test(urls.get(base) ?? '');
  const url = ssh && pr.sshUrl ? pr.sshUrl : MOCK ? pr.url : `${pr.url.replace(/\/$/, '')}.git`;
  let name = pr.owner.replace(/[^\w.-]/g, '-');
  for (let k = 2; names.includes(name); k++) name = `${pr.owner}-${k}`;
  return { name, url };
}

/** Fetch pull request `number`'s head and work out where it would go (see `planCheckout`). */
export async function checkoutPlan(repo: Repo, body: any): Promise<CheckoutPlan> {
  const pr = await prHead(repo, number(body?.number));
  const base = await remoteFor(repo.git, pr.base);
  if (!base) throw new GitError(`No remote here is ${pr.base}, where #${pr.number} is: add one to check it out.`);
  const same = pr.repo?.toLowerCase() === pr.base.toLowerCase();
  const remote = same ? base : pr.repo ? await remoteFor(repo.git, pr.repo) : null;
  const addRemote = !same && !remote ? await forkRemote(repo.git, pr, base) : null;
  await sweepPrRefs(repo);
  const sha = await fetchPrHead(repo.git, base, pr.number, same && pr.live ? pr.head : null);
  try {
    return { ...(await planCheckout(repo, pr, sha, remote ?? addRemote?.name ?? null)), addRemote };
  } finally {
    // Its commits stay until git's garbage collection, long after the checkout that follows.
    if (!prHeld(repo, pr.number)) await dropPrRefs(repo, pr.number);
  }
}

export const checkoutPost: Record<string, PostRoute> = {
  prCheckoutPlan: checkoutPlan,
};
