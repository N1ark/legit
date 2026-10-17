// The pull request a branch has on GitHub.

import { cached, graphql } from './client.ts';
import { ghRepos } from './context.ts';
import type { PullRequest, PrState } from '../../shared/github.ts';
import type { Repo } from '../repo.ts';

/** GraphQL fields that make a `PullRequest` (see `toPullRequest`). */
export const PR_FIELDS = `number title url state isDraft baseRefName headRefName headRefOid
  author { login avatarUrl } repository { nameWithOwner } headRepositoryOwner { login }`;

export function toPullRequest(n: any): PullRequest {
  const state: PrState = n.state === 'MERGED' ? 'merged' : n.state === 'CLOSED' ? 'closed' : n.isDraft ? 'draft' : 'open';
  return {
    number: n.number,
    title: n.title,
    url: n.url,
    state,
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

const prs = new Map<string, { at: number; value: Promise<PullRequest | null> }>();

/** The pull request `branch` is the head of, cached for a few seconds; `fresh` skips the cache. */
export async function prForBranch(repo: Repo, branch: string, fresh = false): Promise<PullRequest | null> {
  const r = await ghRepos(repo, branch);
  if (!r) return null;
  const key = `${r.base}\0${r.headOwner}\0${branch}`;
  if (fresh) prs.delete(key);
  return cached(prs, key, 15_000, async () => {
    const d = await graphql(
      `query PrForBranch($owner: String!, $name: String!, $head: String!) {
        repository(owner: $owner, name: $name) {
          pullRequests(headRefName: $head, first: 10, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
        }
      }`,
      { owner: r.owner, name: r.name, head: branch },
    );
    return pickPr(d.repository?.pullRequests.nodes ?? [], r.headOwner);
  });
}

/** Forget cached lookups, after something changed a pull request. */
export function forgetPrs() {
  prs.clear();
}
