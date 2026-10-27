// The pull request a branch has on GitHub.

import { cached, graphql } from './client.ts';
import { ghRepos } from './context.ts';
import type { PullRequest, PrState } from '../../shared/github.ts';
import type { Repo } from '../repo.ts';

/** GraphQL fields that make a `PullRequest` (see `toPullRequest`). */
export const PR_FIELDS = `number title url state isDraft isInMergeQueue baseRefName headRefName headRefOid
  author { login avatarUrl } repository { nameWithOwner } headRepositoryOwner { login }`;

/** A pull request's state from GraphQL's `state`, `isDraft` and `isInMergeQueue`. */
export function prState(n: { state: string; isDraft?: boolean; isInMergeQueue?: boolean }): PrState {
  return n.state === 'MERGED' ? 'merged' : n.state === 'CLOSED' ? 'closed' : n.isInMergeQueue ? 'queued' : n.isDraft ? 'draft' : 'open';
}

export function toPullRequest(n: any): PullRequest {
  return {
    number: n.number,
    title: n.title,
    url: n.url,
    state: prState(n),
    base: n.baseRefName,
    head: n.headRefName,
    headSha: n.headRefOid,
    author: n.author ? { login: n.author.login, avatar: n.author.avatarUrl } : null,
    repo: n.repository.nameWithOwner,
  };
}

/** Of a branch's pull requests (newest first), the open one, else the newest. */
export function pickPr(nodes: any[], headOwner: string): PullRequest | null {
  const mine = nodes.filter((n) => !n.headRepositoryOwner || n.headRepositoryOwner.login.toLowerCase() === headOwner.toLowerCase());
  const pick = mine.find((n) => n.state === 'OPEN') ?? mine[0];
  return pick ? toPullRequest(pick) : null;
}

const TTL = 15_000;
const prs = new Map<string, { at: number; value: Promise<PullRequest | null> }>();
/** The lookups that have their answer. */
const known = new Map<string, { at: number; pr: PullRequest | null }>();

/** The pull request `branch` is the head of, cached for a few seconds; `fresh` skips the cache. */
export async function prForBranch(repo: Repo, branch: string, fresh = false): Promise<PullRequest | null> {
  const r = await ghRepos(repo, branch);
  if (!r) return null;
  const key = `${r.base}\0${r.headOwner}\0${branch}`;
  if (fresh) [prs, known].forEach((m) => m.delete(key));
  return cached(prs, key, TTL, async () => {
    const d = await graphql(
      `query PrForBranch($owner: String!, $name: String!, $head: String!) {
        repository(owner: $owner, name: $name) {
          pullRequests(headRefName: $head, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
        }
      }`,
      { owner: r.owner, name: r.name, head: branch },
    );
    const pr = pickPr(d.repository?.pullRequests.nodes ?? [], r.headOwner);
    known.set(key, { at: Date.now(), pr });
    return pr;
  });
}

/** What `prForBranch` would answer at once, from its cache (`stale`: or last did); undefined when it would ask GitHub. */
export async function knownPr(repo: Repo, branch: string, stale = false): Promise<PullRequest | null | undefined> {
  const r = await ghRepos(repo, branch);
  if (!r) return null;
  const hit = known.get(`${r.base}\0${r.headOwner}\0${branch}`);
  return hit && (stale || Date.now() - hit.at < TTL) ? hit.pr : undefined;
}

/** GitHub's pull request nodes by head branch name (every fork's, most recently updated first), for the branch list. */
export const headCache = new Map<string, { at: number; value: Promise<any[]> }>();

/** Forget cached lookups, after something changed a pull request. */
export function forgetPrs() {
  prs.clear();
  known.clear();
  headCache.clear();
}
