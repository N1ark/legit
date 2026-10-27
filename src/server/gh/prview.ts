// A pull request's overview, GitHub's Conversation tab: one GraphQL query reads all of it
// (toOverview turns that into a PrOverview), and each change is a REST call or a mutation that
// answers with the overview again, so the view shows what GitHub now has.

import { GithubError, MOCK, graphql, rest } from './client.ts';
import { needGhRepos } from './context.ts';
import { db } from './mock/registry.ts';
import { forgetPrs, prState } from './pulls.ts';
import type { GhUser } from '../../shared/github.ts';
import type {
  CheckState, MergeMethod, MergeState, PrCommit, PrItem, PrLabel, PrOptions, PrOverview, PrReviewer, ReviewEvent, ReviewState,
} from '../../shared/gh-prview.ts';
import type { GetRoute, PostRoute } from './routes.ts';
import type { Repo } from '../repo.ts';

const ACTOR = 'login avatarUrl';
const EVENTS = `
  ... on IssueComment { id databaseId author { ${ACTOR} } body createdAt lastEditedAt viewerCanUpdate viewerCanDelete }
  ... on PullRequestReview { id author { ${ACTOR} } state body createdAt submittedAt comments { totalCount } }
  ... on PullRequestCommit { id commit { oid abbreviatedOid messageHeadline committedDate author { name user { ${ACTOR} } } } }
  ... on HeadRefForcePushedEvent { id actor { ${ACTOR} } createdAt beforeCommit { abbreviatedOid } afterCommit { abbreviatedOid } }
  ... on MergedEvent { id actor { ${ACTOR} } createdAt commit { abbreviatedOid } mergeRefName }
  ... on ClosedEvent { id actor { ${ACTOR} } createdAt }
  ... on ReopenedEvent { id actor { ${ACTOR} } createdAt }
  ... on ReadyForReviewEvent { id actor { ${ACTOR} } createdAt }
  ... on ConvertToDraftEvent { id actor { ${ACTOR} } createdAt }
  ... on ReviewRequestedEvent { id actor { ${ACTOR} } createdAt requestedReviewer { ... on User { login } ... on Team { combinedSlug } } }
  ... on ReviewRequestRemovedEvent { id actor { ${ACTOR} } createdAt requestedReviewer { ... on User { login } ... on Team { combinedSlug } } }
  ... on LabeledEvent { id actor { ${ACTOR} } createdAt label { name color } }
  ... on UnlabeledEvent { id actor { ${ACTOR} } createdAt label { name color } }
  ... on BaseRefChangedEvent { id actor { ${ACTOR} } createdAt previousRefName currentRefName }
  ... on RenamedTitleEvent { id actor { ${ACTOR} } createdAt previousTitle currentTitle }
  ... on HeadRefDeletedEvent { id actor { ${ACTOR} } createdAt headRefName }`;

const ITEM_TYPES = `[ISSUE_COMMENT, PULL_REQUEST_REVIEW, PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT, MERGED_EVENT, CLOSED_EVENT,
  REOPENED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT, LABELED_EVENT,
  UNLABELED_EVENT, BASE_REF_CHANGED_EVENT, RENAMED_TITLE_EVENT, HEAD_REF_DELETED_EVENT]`;

export const OVERVIEW_QUERY = `query PrViewOverview($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed deleteBranchOnMerge viewerDefaultMergeMethod
    squashMergeCommitTitle squashMergeCommitMessage
    pullRequest(number: $number) {
      id number title body url state isDraft isInMergeQueue mergeQueueEntry { position } createdAt mergedAt mergedBy { ${ACTOR} } author { ${ACTOR} }
      baseRefName headRefName headRefOid mergeable mergeStateStatus reviewDecision additions deletions changedFiles
      viewerCanUpdate viewerDidAuthor viewerCanEnableAutoMerge viewerCanDisableAutoMerge
      labels(first: 50) { nodes { name color } }
      assignees(first: 20) { nodes { ${ACTOR} } }
      reviewRequests(first: 50) { nodes { requestedReviewer { ... on User { ${ACTOR} } ... on Team { combinedSlug avatarUrl } } } }
      latestOpinionatedReviews(first: 50) { nodes { author { ${ACTOR} } state } }
      latestReviews(first: 50) { nodes { author { ${ACTOR} } state } }
      suggestedReviewers { reviewer { ${ACTOR} } }
      reviews(states: PENDING, first: 5) { nodes { id author { login } comments { totalCount } } }
      autoMergeRequest { mergeMethod enabledBy { login } }
      commits(last: 100) {
        totalCount
        nodes { commit { oid abbreviatedOid messageHeadline author { name user { login } } statusCheckRollup { state } } }
      }
      timelineItems(last: 100, itemTypes: ${ITEM_TYPES}) { nodes { __typename ${EVENTS} } }
    }
  }
}`;

const user = (u: any): GhUser | null => (u?.login ? { login: u.login, avatar: u.avatarUrl ?? '' } : null);
const check = (s: string | undefined | null): CheckState => (s ? (s.toLowerCase() as CheckState) : null);
const METHODS: Record<string, MergeMethod> = { MERGE: 'merge', SQUASH: 'squash', REBASE: 'rebase' };

export function reviewState(s: string): ReviewState {
  return s === 'APPROVED' ? 'approved' : s === 'CHANGES_REQUESTED' ? 'changes' : s === 'DISMISSED' ? 'dismissed' : s === 'PENDING' ? 'pending' : 'commented';
}

/** Each reviewer once: their latest review that approved or asked for changes, else their latest, else requested. */
export function reviewers(pr: any): PrReviewer[] {
  const out = new Map<string, PrReviewer>();
  const author = pr.author?.login;
  for (const r of [...(pr.latestOpinionatedReviews?.nodes ?? []), ...(pr.latestReviews?.nodes ?? [])]) {
    const login = r.author?.login;
    if (!login || login === author || out.has(login) || r.state === 'PENDING') continue;
    out.set(login, { login, avatar: r.author.avatarUrl ?? null, team: false, state: reviewState(r.state) });
  }
  for (const { requestedReviewer: r } of pr.reviewRequests?.nodes ?? []) {
    const login = r?.login ?? r?.combinedSlug;
    if (login) out.set(login, { login, avatar: r.avatarUrl ?? null, team: !r.login, state: 'requested' });
  }
  return [...out.values()];
}

/** The timeline, oldest first, with commits pushed in a row as one entry; pending reviews left out. */
export function timeline(nodes: any[]): PrItem[] {
  const out: PrItem[] = [];
  for (const n of nodes) {
    const base = { id: n.id, actor: user(n.actor ?? n.author), at: n.createdAt };
    switch (n.__typename) {
      case 'IssueComment':
        out.push({
          ...base, kind: 'comment', dbId: n.databaseId, body: n.body ?? '', edited: !!n.lastEditedAt,
          canEdit: !!n.viewerCanUpdate, canDelete: !!n.viewerCanDelete,
        });
        break;
      case 'PullRequestReview':
        if (n.state === 'PENDING') break;
        out.push({
          ...base, at: n.submittedAt ?? n.createdAt, kind: 'review', state: reviewState(n.state), body: n.body ?? '', comments: n.comments?.totalCount ?? 0,
        });
        break;
      case 'PullRequestCommit': {
        const c = n.commit;
        const entry = { sha: c.oid, short: c.abbreviatedOid, headline: c.messageHeadline };
        const actor = user(c.author?.user) ?? (c.author?.name ? { login: c.author.name, avatar: '' } : null);
        const last = out.at(-1);
        if (last?.kind === 'commits' && last.actor?.login === actor?.login) last.commits.push(entry);
        else out.push({ id: n.id, actor, at: c.committedDate, kind: 'commits', commits: [entry] });
        break;
      }
      case 'HeadRefForcePushedEvent':
        out.push({ ...base, kind: 'event', type: 'force-pushed', before: n.beforeCommit?.abbreviatedOid, subject: n.afterCommit?.abbreviatedOid });
        break;
      case 'MergedEvent':
        out.push({ ...base, kind: 'event', type: 'merged', subject: n.commit?.abbreviatedOid, before: n.mergeRefName });
        break;
      case 'ClosedEvent':
        out.push({ ...base, kind: 'event', type: 'closed' });
        break;
      case 'ReopenedEvent':
        out.push({ ...base, kind: 'event', type: 'reopened' });
        break;
      case 'ReadyForReviewEvent':
        out.push({ ...base, kind: 'event', type: 'ready' });
        break;
      case 'ConvertToDraftEvent':
        out.push({ ...base, kind: 'event', type: 'draft' });
        break;
      case 'ReviewRequestedEvent':
      case 'ReviewRequestRemovedEvent': {
        const type = n.__typename === 'ReviewRequestedEvent' ? 'review-requested' : 'review-request-removed';
        out.push({ ...base, kind: 'event', type, subject: n.requestedReviewer?.login ?? n.requestedReviewer?.combinedSlug ?? 'someone' });
        break;
      }
      case 'LabeledEvent':
      case 'UnlabeledEvent':
        out.push({ ...base, kind: 'event', type: n.__typename === 'LabeledEvent' ? 'labeled' : 'unlabeled', subject: n.label?.name, label: n.label });
        break;
      case 'BaseRefChangedEvent':
        out.push({ ...base, kind: 'event', type: 'base-changed', before: n.previousRefName, subject: n.currentRefName });
        break;
      case 'RenamedTitleEvent':
        out.push({ ...base, kind: 'event', type: 'renamed', before: n.previousTitle, subject: n.currentTitle });
        break;
      case 'HeadRefDeletedEvent':
        out.push({ ...base, kind: 'event', type: 'head-deleted', subject: n.headRefName });
        break;
    }
  }
  return out;
}

/** The squash commit's title and message as GitHub would prefill them, per the repository's settings. */
export function squashDefaults(repo: any, pr: { title: string; body: string; number: number }, commits: PrCommit[]) {
  const one = commits.length === 1 ? commits[0].headline : null;
  const title = `${repo.squashMergeCommitTitle === 'COMMIT_OR_PR_TITLE' && one ? one : pr.title} (#${pr.number})`;
  const message =
    repo.squashMergeCommitMessage === 'PR_BODY' ? pr.body
    : repo.squashMergeCommitMessage === 'BLANK' ? ''
    : commits.length > 1 ? commits.map((c) => `* ${c.headline}`).join('\n\n')
    : '';
  return { title, message };
}

/** The PrViewOverview query's answer as a PrOverview. */
export function toOverview(d: any): PrOverview {
  const repo = d.repository;
  const pr = repo?.pullRequest;
  if (!pr) throw new GithubError('GitHub has no such pull request.', 404);
  const viewer: string = d.viewer.login;
  const commits: PrCommit[] = (pr.commits?.nodes ?? []).map(({ commit: c }: any) => ({
    sha: c.oid,
    short: c.abbreviatedOid,
    headline: c.messageHeadline,
    author: c.author?.user?.login ?? c.author?.name ?? null,
    checks: check(c.statusCheckRollup?.state),
  }));
  const allowed = { merge: repo.mergeCommitAllowed, squash: repo.squashMergeAllowed, rebase: repo.rebaseMergeAllowed };
  const methods = (['merge', 'squash', 'rebase'] as const).filter((m) => allowed[m]);
  const preferred = METHODS[repo.viewerDefaultMergeMethod] ?? 'merge';
  const pending = (pr.reviews?.nodes ?? []).find((r: any) => r.author?.login === viewer);
  const decision = pr.reviewDecision;
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    url: pr.url,
    state: prState(pr),
    queuePosition: pr.mergeQueueEntry?.position ?? null,
    author: user(pr.author),
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt ?? null,
    mergedBy: user(pr.mergedBy),
    base: pr.baseRefName,
    head: pr.headRefName,
    headSha: pr.headRefOid,
    mergeable: pr.mergeable === 'MERGEABLE' ? 'mergeable' : pr.mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown',
    mergeState: (pr.mergeStateStatus ?? 'UNKNOWN').toLowerCase() as MergeState,
    reviewDecision: decision === 'APPROVED' ? 'approved' : decision === 'CHANGES_REQUESTED' ? 'changes' : decision === 'REVIEW_REQUIRED' ? 'required' : null,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    viewer,
    canUpdate: !!pr.viewerCanUpdate,
    mine: !!pr.viewerDidAuthor,
    labels: (pr.labels?.nodes ?? []).map((l: any): PrLabel => ({ name: l.name, color: l.color })),
    assignees: (pr.assignees?.nodes ?? []).map(user).filter(Boolean),
    reviewers: reviewers(pr),
    suggested: (pr.suggestedReviewers ?? []).map((s: any) => user(s.reviewer)).filter(Boolean),
    commits,
    commitCount: pr.commits?.totalCount ?? commits.length,
    checks: commits.at(-1)?.checks ?? null,
    autoMerge: pr.autoMergeRequest ? { method: METHODS[pr.autoMergeRequest.mergeMethod] ?? 'merge', by: pr.autoMergeRequest.enabledBy?.login ?? null } : null,
    canAutoMerge: !!repo.autoMergeAllowed && !!(pr.viewerCanEnableAutoMerge || pr.viewerCanDisableAutoMerge),
    methods: methods.length ? methods : ['merge'],
    defaultMethod: methods.includes(preferred) ? preferred : (methods[0] ?? 'merge'),
    deleteBranchOnMerge: !!repo.deleteBranchOnMerge,
    pending: pending ? { id: pending.id, comments: pending.comments?.totalCount ?? 0 } : null,
    timeline: timeline(pr.timelineItems?.nodes ?? []),
    squash: squashDefaults(repo, { title: pr.title, body: pr.body ?? '', number: pr.number }, commits),
  };
}

async function where(repo: Repo, number: unknown) {
  const n = Number(number);
  if (!Number.isInteger(n) || n <= 0) throw new GithubError('Which pull request?', 400);
  const r = await needGhRepos(repo);
  if (MOCK) db.gitDir = repo.git.root;
  return { ...r, number: n, path: `/repos/${r.owner}/${r.name}` };
}

export async function prOverview(repo: Repo, number: unknown): Promise<PrOverview> {
  const r = await where(repo, number);
  return toOverview(await graphql(OVERVIEW_QUERY, { owner: r.owner, name: r.name, number: r.number }));
}

async function options(repo: Repo, number: unknown): Promise<PrOptions> {
  const r = await where(repo, number);
  const d = await graphql(
    `query PrViewOptions($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        assignableUsers(first: 100) { nodes { ${ACTOR} } }
        labels(first: 100, orderBy: { field: NAME, direction: ASC }) { nodes { name color } }
        refs(refPrefix: "refs/heads/", first: 100, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) { nodes { name } }
      }
    }`,
    { owner: r.owner, name: r.name },
  );
  return {
    users: (d.repository?.assignableUsers.nodes ?? []).map(user).filter(Boolean),
    labels: d.repository?.labels.nodes ?? [],
    branches: (d.repository?.refs.nodes ?? []).map((b: any) => b.name),
  };
}

const text = (v: unknown, what: string) => {
  if (typeof v !== 'string' || !v.trim()) throw new GithubError(`Write ${what} first.`, 400);
  return v;
};
const list = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && !!s) : []);

/** Make a change to pull request `body.number`, then answer with its overview. */
function change(fn: (r: Awaited<ReturnType<typeof where>>, body: any) => Promise<unknown>): PostRoute {
  return async (repo, body) => {
    const r = await where(repo, body?.number);
    await fn(r, body);
    forgetPrs();
    return prOverview(repo, r.number);
  };
}

/** The viewer's review in progress, looked up now: diff comments may have started one since the view loaded. */
async function pendingReview(r: Awaited<ReturnType<typeof where>>): Promise<string | null> {
  const d = await graphql(
    `query PrViewPending($owner: String!, $name: String!, $number: Int!) {
      viewer { login }
      repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviews(states: PENDING, first: 5) { nodes { id author { login } } } } }
    }`,
    { owner: r.owner, name: r.name, number: r.number },
  );
  return d.repository?.pullRequest?.reviews.nodes.find((n: any) => n.author?.login === d.viewer.login)?.id ?? null;
}

const EVENTS_OK: ReviewEvent[] = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'];
const MERGE_ENUM: Record<MergeMethod, string> = { merge: 'MERGE', squash: 'SQUASH', rebase: 'REBASE' };

const method = (m: unknown): MergeMethod => {
  if (m !== 'merge' && m !== 'squash' && m !== 'rebase') throw new GithubError('Pick how to merge.', 400);
  return m;
};

export const prviewGet: Record<string, GetRoute> = {
  prview: (repo, q) => prOverview(repo, q.get('number')),
  prviewOptions: (repo, q) => options(repo, q.get('number')),
};

export const prviewPost: Record<string, PostRoute> = {
  prviewComment: change((r, b) => rest('POST', `${r.path}/issues/${r.number}/comments`, { body: text(b.body, 'a comment') })),
  prviewEditComment: change((r, b) => rest('PATCH', `${r.path}/issues/comments/${Number(b.dbId)}`, { body: text(b.body, 'a comment') })),
  prviewDeleteComment: change((r, b) => rest('DELETE', `${r.path}/issues/comments/${Number(b.dbId)}`)),
  prviewEdit: change((r, b) => {
    const patch: Record<string, string> = {};
    if (typeof b.title === 'string') patch.title = text(b.title, 'a title');
    if (typeof b.body === 'string') patch.body = b.body;
    if (typeof b.base === 'string') patch.base = text(b.base, 'a base branch');
    return rest('PATCH', `${r.path}/pulls/${r.number}`, patch);
  }),
  prviewState: change((r, b) => rest('PATCH', `${r.path}/pulls/${r.number}`, { state: b.open ? 'open' : 'closed' })),
  prviewDraft: change((_, b) =>
    b.draft
      ? graphql('mutation PrViewToDraft($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { clientMutationId } }', { id: b.id })
      : graphql('mutation PrViewReady($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }', { id: b.id }),
  ),
  prviewReviewers: change(async (r, b) => {
    const split = (logins: string[]) => ({
      reviewers: logins.filter((l) => !l.includes('/')),
      team_reviewers: logins.filter((l) => l.includes('/')).map((l) => l.split('/')[1]),
    });
    const add = list(b.add);
    const remove = list(b.remove);
    if (add.length) await rest('POST', `${r.path}/pulls/${r.number}/requested_reviewers`, split(add));
    if (remove.length) await rest('DELETE', `${r.path}/pulls/${r.number}/requested_reviewers`, split(remove));
  }),
  prviewLabels: change(async (r, b) => {
    const add = list(b.add);
    if (add.length) await rest('POST', `${r.path}/issues/${r.number}/labels`, { labels: add });
    for (const l of list(b.remove)) await rest('DELETE', `${r.path}/issues/${r.number}/labels/${encodeURIComponent(l)}`);
  }),
  prviewMerge: change((r, b) => {
    const how = method(b.method);
    // `sha` is the head the user saw: GitHub refuses the merge if a newer push moved it.
    const body: Record<string, string> = { merge_method: how, sha: text(b.sha, 'the head commit') };
    if (how !== 'rebase' && typeof b.title === 'string' && b.title.trim()) body.commit_title = b.title;
    if (how !== 'rebase' && typeof b.message === 'string') body.commit_message = b.message;
    return rest('PUT', `${r.path}/pulls/${r.number}/merge`, body);
  }),
  prviewAutoMerge: change((_, b) =>
    b.enable
      ? graphql(
          `mutation PrViewAutoMerge($id: ID!, $method: PullRequestMergeMethod!, $title: String, $message: String, $sha: GitObjectID) {
            enablePullRequestAutoMerge(input: {
              pullRequestId: $id, mergeMethod: $method, commitHeadline: $title, commitBody: $message, expectedHeadOid: $sha
            }) { clientMutationId }
          }`,
          {
            id: b.id,
            method: MERGE_ENUM[method(b.method)],
            title: b.method === 'rebase' ? null : b.title || null,
            message: b.method === 'rebase' ? null : (b.message ?? null),
            sha: b.sha ?? null,
          },
        )
      : graphql('mutation PrViewNoAutoMerge($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }', { id: b.id }),
  ),
  prviewReview: change(async (r, b) => {
    const event = b.event as ReviewEvent;
    if (!EVENTS_OK.includes(event)) throw new GithubError('Pick what the review says.', 400);
    const body = typeof b.body === 'string' ? b.body : '';
    const pending = await pendingReview(r);
    if (pending) {
      return graphql(
        `mutation PrViewSubmitReview($id: ID!, $event: PullRequestReviewEvent!, $body: String) {
          submitPullRequestReview(input: { pullRequestReviewId: $id, event: $event, body: $body }) { clientMutationId }
        }`,
        { id: pending, event, body },
      );
    }
    if (event !== 'APPROVE' && !body.trim()) throw new GithubError('Write what the review says first.', 400);
    return graphql(
      `mutation PrViewAddReview($id: ID!, $event: PullRequestReviewEvent!, $body: String) {
        addPullRequestReview(input: { pullRequestId: $id, event: $event, body: $body }) { clientMutationId }
      }`,
      { id: b.id, event, body },
    );
  }),
};
