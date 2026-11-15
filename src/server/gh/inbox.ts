// The repository's pull requests, as GitHub's list sorts them: review requested from you (directly
// or through a team), yours, assigned to you, and every open one. One query of four searches per
// refresh; any one by number (closed or merged too) on its own.

import { GithubError, cached, graphql } from './client.ts';
import { needGhRepos } from './context.ts';
import { PR_FIELDS, toPullRequest } from './pulls.ts';
import type { CheckState } from '../../shared/gh-prview.ts';
import type { InboxList, InboxPr, PrInbox } from '../../shared/gh-inbox.ts';
import type { GetRoute } from './routes.ts';
import type { Repo } from '../repo.ts';

const FIELDS = `${PR_FIELDS} updatedAt reviewDecision isCrossRepository headRepository { nameWithOwner } comments { totalCount }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { combinedSlug } } } }
  assignees(first: 20) { nodes { login } }`;

const LISTS: Record<InboxList, string> = {
  review: 'review-requested:@me',
  mine: 'author:@me',
  assigned: 'assignee:@me',
  open: '',
};

const search = (list: InboxList) => `${list}: search(query: $${list}, type: ISSUE, first: 50) { issueCount nodes { ... on PullRequest { ${FIELDS} } } }`;

export const INBOX_QUERY = `query PrInbox($review: String!, $mine: String!, $assigned: String!, $open: String!) {
  viewer { login }
  ${(Object.keys(LISTS) as InboxList[]).map(search).join('\n  ')}
}`;

const DECISION: Record<string, InboxPr['reviewDecision']> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', REVIEW_REQUIRED: 'required' };

/** A search's pull request node as an inbox row; `viewer` decides whether it was asked of them or of a team. */
export function toInboxPr(n: any, viewer: string, lists: Partial<Record<InboxList, boolean>> = {}): InboxPr {
  const asked = (n.reviewRequests?.nodes ?? []).map((r: any) => r.requestedReviewer).filter(Boolean);
  const you = asked.some((r: any) => r.login?.toLowerCase() === viewer.toLowerCase());
  const team = asked.find((r: any) => r.combinedSlug)?.combinedSlug ?? null;
  const assigned = (n.assignees?.nodes ?? []).some((a: any) => a.login?.toLowerCase() === viewer.toLowerCase());
  const state = n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  return {
    ...toPullRequest(n),
    updatedAt: n.updatedAt,
    reviewDecision: DECISION[n.reviewDecision] ?? null,
    checks: state ? (state.toLowerCase() as CheckState) : null,
    fork: n.isCrossRepository ? (n.headRepository?.nameWithOwner ?? `${n.headRepositoryOwner?.login ?? 'ghost'}/${n.repository.nameWithOwner.split('/')[1]}`) : null,
    requested: you ? 'you' : lists.review ? (team ?? 'you') : null,
    mine: !!lists.mine || n.author?.login?.toLowerCase() === viewer.toLowerCase(),
    assigned: !!lists.assigned || assigned,
    comments: n.comments?.totalCount ?? 0,
  };
}

/** The PrInbox query's answer: each pull request once, with the lists it's in, most recently updated first. */
export function toInbox(d: any): PrInbox {
  const viewer: string = d.viewer.login;
  const nodes = new Map<number, { node: any; lists: Partial<Record<InboxList, boolean>> }>();
  const counts = {} as Record<InboxList, number>;
  for (const list of Object.keys(LISTS) as InboxList[]) {
    counts[list] = d[list]?.issueCount ?? 0;
    for (const n of d[list]?.nodes ?? []) {
      if (!n?.number) continue;
      const had = nodes.get(n.number) ?? { node: n, lists: {} };
      had.lists[list] = true;
      nodes.set(n.number, had);
    }
  }
  const items = [...nodes.values()].map(({ node, lists }) => toInboxPr(node, viewer, lists));
  items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { viewer, items, counts };
}

const TTL = 20_000;
const inboxes = new Map<string, { at: number; value: Promise<PrInbox> }>();

export async function prInbox(repo: Repo, fresh = false): Promise<PrInbox> {
  const r = await needGhRepos(repo);
  if (fresh) inboxes.delete(r.base);
  return cached(inboxes, r.base, TTL, async () => {
    const q = (list: InboxList) => `repo:${r.base} is:pr is:open ${LISTS[list]} sort:updated-desc`.replace(/\s+/g, ' ');
    return toInbox(await graphql(INBOX_QUERY, { review: q('review'), mine: q('mine'), assigned: q('assigned'), open: q('open') }));
  });
}

/** One pull request of the repository by number, whatever its state; null when there's none. */
export async function prLookup(repo: Repo, number: unknown): Promise<InboxPr | null> {
  const n = Number(number);
  if (!Number.isInteger(n) || n <= 0) throw new GithubError('Which pull request?', 400);
  const r = await needGhRepos(repo);
  const d = await graphql(
    `query PrLookup($owner: String!, $name: String!, $number: Int!) {
      viewer { login }
      repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${FIELDS} } }
    }`,
    { owner: r.owner, name: r.name, number: n },
  ).catch((e) => {
    // An issue's number, or one that doesn't exist.
    if (e instanceof GithubError && /could not resolve/i.test(e.message)) return null;
    throw e;
  });
  const node = d?.repository?.pullRequest;
  return node ? toInboxPr(node, d.viewer.login) : null;
}

export const inboxGet: Record<string, GetRoute> = {
  prInbox: (repo, q) => prInbox(repo, q.get('fresh') === '1'),
  prLookup: (repo, q) => prLookup(repo, q.get('number')),
};
