// Reading a pull request without checking it out. Its head (GitHub's refs/pull/<n>/head) and base
// branch are fetched into hidden refs, refs/legit/pull/<n>/…, that no branch list, log or backup
// lists; nothing else moves (no branch, HEAD, index, working tree, remote-tracking ref or FETCH_HEAD).
// Its diffs are then `r…` keys (Repo.rangeDiff): Files changed is merge-base(base, head)..head.

import { GitError } from '../git.ts';
import { githubRepo } from '../github.ts';
import { info } from '../repo.ts';
import { networkEnv } from '../sync.ts';
import { GithubError, MOCK, cached, graphql } from './client.ts';
import { needGhRepos } from './context.ts';
import { db } from './mock/registry.ts';
import { prCommit } from './prview.ts';
import type { GetRoute, PostRoute } from './routes.ts';
import type { PrCommit } from '../../shared/gh-prview.ts';
import type { PrCompare, PrFetched } from '../../shared/gh-prdiff.ts';
import type { CommitInfo } from '../../shared/types.ts';
import type { Repo } from '../repo.ts';

export const PULL = 'refs/legit/pull';

const SHA = /^[0-9a-f]{40,64}$/;

const num = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new GithubError('Which pull request?', 400);
  return n;
};

const sha = (v: unknown, what: string) => {
  if (typeof v !== 'string' || !SHA.test(v)) throw new GithubError(`Bad ${what}.`, 400);
  return v;
};

/** The remote pull requests come from: the one whose URL is the base repository, else its URL on GitHub. */
async function baseRemote(repo: Repo): Promise<{ remote: string; name: string | null }> {
  const r = await needGhRepos(repo);
  if (MOCK) db.gitDir = repo.git.root;
  const { names, urls } = await repo.git.remotes();
  const name = names.find((n) => githubRepo(urls.get(n) ?? '')?.toLowerCase() === r.base.toLowerCase()) ?? null;
  return { remote: name ?? `https://github.com/${r.base}.git`, name };
}

const GONE = 'GitHub no longer has it';

/** `git fetch` of `refspecs` into refs/legit/pull only; null when it worked, else why not (a phrase). */
async function fetchRefs(repo: Repo, remote: string, refspecs: string[]): Promise<string | null> {
  if (MOCK) await db.syncPulls?.(repo.git.root);
  const r = await repo.git.run(
    ['fetch', '--no-tags', '--no-prune', '--no-write-fetch-head', '--no-auto-maintenance', '--refmap=', remote, ...refspecs],
    { allowFail: true, timeout: 120_000, env: await networkEnv(repo.git) },
  );
  if (r.code === 0) return null;
  const err = r.err.trim();
  if (r.code < 0) return `fetching from ${remote} timed out`;
  if (/not our ref|couldn't find remote ref|no such remote ref|unadvertised object/i.test(err)) return GONE;
  const auth = /terminal prompts disabled|could not read Username|Authentication failed|Permission denied|Host key verification failed/i.test(err);
  if (auth) return `git needs credentials for ${remote} it can't ask for here`;
  const line = err.split('\n').find((l) => /^(fatal|error):/.test(l)) ?? err.split('\n').at(-1) ?? '';
  return line.replace(/^(fatal|error):\s*/, '') || `git fetch failed (exit ${r.code})`;
}

const has = async (repo: Repo, s: string) => (await repo.git.run(['cat-file', '-e', `${s}^{commit}`], { allowFail: true })).code === 0;

async function mergeBase(repo: Repo, a: string, b: string): Promise<string | null> {
  return repo.git.memo(`merge-base ${a} ${b}`, async () => (await repo.git.text(['merge-base', a, b], { allowFail: true })) || null);
}

const fetches = new Map<string, { at: number; value: Promise<PrFetched> }>();

/**
 * Fetch pull request `number` (whose head GitHub says is `head`, and base branch `base`), once per
 * head, and again every few minutes for the base. Offline, what's here already is used if it can be.
 */
export function fetchPr(repo: Repo, number: number, head: string, base: string): Promise<PrFetched> {
  const key = `${repo.git.root}\0${number}\0${head}\0${base}`;
  return cached(fetches, key, 5 * 60_000, async () => {
    const { remote, name } = await baseRemote(repo);
    const refs = { head: `${PULL}/${number}/head`, base: `${PULL}/${number}/base` };
    const specs = [`+refs/pull/${number}/head:${refs.head}`, `+refs/heads/${base}:${refs.base}`];
    let why = await fetchRefs(repo, remote, specs);
    // A base branch deleted since (after merging) fails the head's fetch too.
    if (why === GONE) why = (await fetchRefs(repo, remote, specs.slice(0, 1))) ?? `GitHub no longer has ${base}`;
    // GitHub's ref can trail what its API says for a moment: then the commit itself is asked for.
    if (!(await has(repo, head)) && !why) await fetchRefs(repo, remote, [`+${head}:${refs.head}`]);
    if (!(await has(repo, head))) throw new GithubError(why ? `Couldn't fetch #${number}: ${why}.` : `GitHub doesn't have #${number}'s head commit yet; try again in a moment.`);
    // The head as GitHub says it is, kept by its ref.
    if ((await repo.git.resolve(refs.head)) !== head) await repo.git.run(['update-ref', refs.head, head]);
    const baseSha =
      (await repo.git.resolve(refs.base)) ?? (name ? await repo.git.resolve(`refs/remotes/${name}/${base}`) : null);
    if (!baseSha) throw new GithubError(`Couldn't fetch #${number}'s base branch ${base}: ${why ?? 'GitHub has no such branch'}.`);
    // Offline, the next look tries again.
    if (why) setTimeout(() => fetches.delete(key));
    return { number, head, base: baseSha, mergeBase: await mergeBase(repo, baseSha, head), offline: why };
  });
}

/** Commit `rev` of pull request `number` (`<sha>^`: its first parent), fetched from GitHub by SHA if it isn't here. */
async function ensure(repo: Repo, number: number, rev: string): Promise<string> {
  const parent = rev.endsWith('^');
  const s = sha(parent ? rev.slice(0, -1) : rev, 'commit');
  if (!(await has(repo, s))) {
    const why = await fetchRefs(repo, (await baseRemote(repo)).remote, [`+${s}:${PULL}/${number}/${s}`]);
    if (!(await has(repo, s))) throw new GitError(`Couldn't get ${s.slice(0, 7)} from GitHub: ${why ?? GONE}.`);
  }
  if (!parent) return s;
  const p = (await repo.git.commit(s)).parents[0];
  if (!p) throw new GitError(`${s.slice(0, 7)} has no parent.`);
  return p;
}

const isAncestor = async (repo: Repo, a: string, b: string) => (await repo.git.run(['merge-base', '--is-ancestor', a, b], { allowFail: true })).code === 0;

/**
 * The diff from `from` to `to` of pull request `number`. When `from` isn't in `to`'s history (it was
 * rebased or force-pushed), the two trees are compared only in the files either changes against
 * where it met the base, so what the base brought to the others is left out.
 */
export async function comparePr(repo: Repo, number: number, fromRev: string, toRev: string): Promise<PrCompare> {
  const [from, to] = await Promise.all([ensure(repo, number, fromRev), ensure(repo, number, toRev)]);
  if (await isAncestor(repo, from, to)) {
    const list = await repo.git.text(['rev-list', '--max-count=300', to, `^${from}`]);
    return { key: `r${to}-${from}`, from, to, rebased: false, commits: list.split('\n').filter(Boolean) };
  }
  const base = await repo.git.resolve(`${PULL}/${number}/base`);
  const [fromBase, toBase] = base ? await Promise.all([mergeBase(repo, from, base), mergeBase(repo, to, base)]) : [null, null];
  const key = fromBase && toBase ? `r${to}-${from}-${toBase}-${fromBase}` : `r${to}-${from}`;
  return { key, from, to, rebased: true, commits: [] };
}

/** A commit of the pull request as the commit list shows one, whether or not it's in the branch's history. */
async function commitInfo(repo: Repo, number: number, rev: string): Promise<CommitInfo> {
  const c = await repo.git.commit(await ensure(repo, number, rev));
  // Not marked pushed: that's about rewriting it, which it can't be from here.
  return info(c, new Set([c.sha]), false);
}

const ALL_COMMITS = `query PrCommits($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { commit { oid abbreviatedOid messageHeadline author { name user { login } } statusCheckRollup { state } } }
      }
    }
  }
}`;

const commitLists = new Map<string, { at: number; value: Promise<PrCommit[]> }>();

/** Every commit of pull request `number` (GitHub lists up to 250), oldest first; `head` keys the cache. */
export async function allCommits(repo: Repo, number: number, head: string): Promise<PrCommit[]> {
  const r = await needGhRepos(repo);
  if (MOCK) db.gitDir = repo.git.root;
  return cached(commitLists, `${r.base}#${number}@${head}`, 60_000, async () => {
    const out: PrCommit[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const d: any = await graphql(ALL_COMMITS, { owner: r.owner, name: r.name, number, after });
      const commits = d.repository?.pullRequest?.commits;
      if (!commits) throw new GithubError(`GitHub has no pull request #${number}.`, 404);
      out.push(...commits.nodes.map((n: any) => prCommit(n.commit)));
      if (!commits.pageInfo.hasNextPage) break;
      after = commits.pageInfo.endCursor;
    }
    return out;
  });
}

export const prdiffGet: Record<string, GetRoute> = {
  prCommits: (repo, q) => allCommits(repo, num(q.get('number')), sha(q.get('head'), 'head')),
  prCommit: (repo, q) => commitInfo(repo, num(q.get('number')), q.get('sha') ?? ''),
};

export const prdiffPost: Record<string, PostRoute> = {
  prFetch: (repo, b) => {
    if (typeof b?.base !== 'string' || !b.base || b.base.startsWith('-')) throw new GithubError('Which base branch?', 400);
    return fetchPr(repo, num(b?.number), sha(b?.head, 'head'), b.base);
  },
  prCompare: (repo, b) => {
    if (typeof b?.from !== 'string') throw new GithubError('Compare from where?', 400);
    return comparePr(repo, num(b?.number), b.from, sha(b?.to, 'commit'));
  },
};
