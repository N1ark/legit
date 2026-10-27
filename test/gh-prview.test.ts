import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewers, squashDefaults, timeline, toOverview } from '../src/server/gh/prview.ts';
import { db, mockGraphql, mockRest } from '../src/server/gh/mock/registry.ts';
import '../src/server/gh/mock/index.ts';
import { prState } from '../src/server/gh/pulls.ts';
import { eventText, mergeStatus, reviewNeeds, reviewRefusal } from '../src/ui/lib/gh-prview.ts';
import type { PrOverview } from '../src/shared/gh-prview.ts';

const actor = (login: string) => ({ login, avatarUrl: `https://avatars.githubusercontent.com/u/1?v=4&${login}` });
const commit = (oid: string, headline: string, state: string | null = 'SUCCESS') => ({
  oid, abbreviatedOid: oid.slice(0, 7), messageHeadline: headline, committedDate: '2026-10-01T10:00:00Z',
  author: { name: 'Mona', user: actor('monalisa') }, statusCheckRollup: state ? { state } : null,
});

const payload = (pr: Record<string, unknown> = {}, repo: Record<string, unknown> = {}) => ({
  viewer: { login: 'octocat' },
  repository: {
    mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: true, autoMergeAllowed: true, deleteBranchOnMerge: true,
    viewerDefaultMergeMethod: 'MERGE', squashMergeCommitTitle: 'COMMIT_OR_PR_TITLE', squashMergeCommitMessage: 'COMMIT_MESSAGES',
    ...repo,
    pullRequest: {
      id: 'PR_1', number: 7, title: 'Add things', body: null, url: 'https://github.com/a/b/pull/7', state: 'OPEN', isDraft: false,
      createdAt: '2026-10-01T09:00:00Z', mergedAt: null, mergedBy: null, author: actor('monalisa'),
      baseRefName: 'main', headRefName: 'things', headRefOid: 'b'.repeat(40), mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
      reviewDecision: 'REVIEW_REQUIRED', additions: 3, deletions: 1, changedFiles: 2, viewerCanUpdate: true, viewerDidAuthor: false,
      viewerCanEnableAutoMerge: true, viewerCanDisableAutoMerge: false,
      labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] },
      assignees: { nodes: [actor('octocat')] },
      reviewRequests: { nodes: [{ requestedReviewer: actor('hubot') }, { requestedReviewer: { combinedSlug: 'a/core', avatarUrl: 'x' } }] },
      latestOpinionatedReviews: { nodes: [{ author: actor('defunkt'), state: 'APPROVED' }] },
      latestReviews: { nodes: [{ author: actor('defunkt'), state: 'COMMENTED' }, { author: actor('mojombo'), state: 'COMMENTED' }] },
      suggestedReviewers: [{ reviewer: actor('mojombo') }],
      reviews: { nodes: [{ id: 'PRR_9', author: { login: 'octocat' }, comments: { totalCount: 3 } }] },
      autoMergeRequest: null,
      commits: { totalCount: 2, nodes: [{ commit: commit('a'.repeat(40), 'First') }, { commit: commit('b'.repeat(40), 'Second', 'PENDING') }] },
      timelineItems: { nodes: [] },
      ...pr,
    },
  },
});

test('the overview query maps to a PrOverview', () => {
  const o = toOverview(payload());
  assert.equal(o.state, 'open');
  assert.equal(o.body, '');
  assert.equal(o.mergeState, 'blocked');
  assert.equal(o.reviewDecision, 'required');
  assert.equal(o.checks, 'pending');
  assert.deepEqual(o.commits.map((c) => [c.short, c.checks]), [['aaaaaaa', 'success'], ['bbbbbbb', 'pending']]);
  assert.deepEqual(o.methods, ['squash', 'rebase']);
  assert.equal(o.defaultMethod, 'squash', "the viewer's default isn't allowed, so the first allowed one");
  assert.deepEqual(o.pending, { id: 'PRR_9', comments: 3 });
  assert.equal(o.canAutoMerge, true);
  assert.deepEqual(o.labels, [{ name: 'bug', color: 'd73a4a' }]);
  assert.equal(toOverview(payload({ isDraft: true })).state, 'draft');
  assert.equal(toOverview(payload({ state: 'MERGED', isDraft: true })).state, 'merged');
  assert.throws(() => toOverview({ viewer: { login: 'x' }, repository: { pullRequest: null } }), /no such pull request/);
});

test("someone else's pending review isn't the viewer's", () => {
  const o = toOverview(payload({ reviews: { nodes: [{ id: 'PRR_1', author: { login: 'hubot' }, comments: { totalCount: 1 } }] } }));
  assert.equal(o.pending, null);
});

test('reviewers: the opinionated review wins, then the latest, then a request; the author never', () => {
  const pr = payload().repository.pullRequest;
  pr.latestReviews.nodes.push({ author: actor('monalisa'), state: 'COMMENTED' });
  assert.deepEqual(
    reviewers(pr).map((r) => [r.login, r.state, r.team]),
    [['defunkt', 'approved', false], ['mojombo', 'commented', false], ['hubot', 'requested', false], ['a/core', 'requested', true]],
  );
  // Asked again after reviewing: awaiting their review.
  pr.reviewRequests.nodes.push({ requestedReviewer: actor('defunkt') });
  assert.equal(reviewers(pr).find((r) => r.login === 'defunkt')?.state, 'requested');
});

test('the timeline groups commits pushed in a row by one person, and drops pending reviews', () => {
  const pc = (oid: string, who: string) => ({ __typename: 'PullRequestCommit', id: `c${oid}`, commit: { ...commit(oid, `C${oid}`), author: { name: who, user: actor(who) } } });
  const items = timeline([
    pc('1', 'monalisa'),
    pc('2', 'monalisa'),
    pc('3', 'hubot'),
    { __typename: 'PullRequestReview', id: 'r1', author: actor('hubot'), state: 'PENDING', body: '', createdAt: 't', submittedAt: null, comments: { totalCount: 0 } },
    { __typename: 'PullRequestReview', id: 'r2', author: actor('hubot'), state: 'CHANGES_REQUESTED', body: 'no', createdAt: 't0', submittedAt: 't1', comments: { totalCount: 2 } },
    pc('4', 'monalisa'),
    { __typename: 'IssueComment', id: 'i1', databaseId: 5, author: actor('octocat'), body: 'hi', createdAt: 't2', lastEditedAt: 't3', viewerCanUpdate: true, viewerCanDelete: false },
    { __typename: 'HeadRefForcePushedEvent', id: 'e1', actor: actor('monalisa'), createdAt: 't4', beforeCommit: { abbreviatedOid: 'aaa' }, afterCommit: { abbreviatedOid: 'bbb' } },
    { __typename: 'LabeledEvent', id: 'e2', actor: actor('monalisa'), createdAt: 't5', label: { name: 'bug', color: 'f00' } },
    { __typename: 'ReviewRequestedEvent', id: 'e3', actor: actor('monalisa'), createdAt: 't6', requestedReviewer: { combinedSlug: 'a/core' } },
    { __typename: 'SomethingNew', id: 'e4' },
  ]);
  assert.deepEqual(items.map((i) => i.kind), ['commits', 'commits', 'review', 'commits', 'comment', 'event', 'event', 'event']);
  assert.equal(items[0].kind === 'commits' && items[0].commits.length, 2);
  assert.equal(items[2].kind === 'review' && items[2].at, 't1');
  assert.deepEqual(items[4].kind === 'comment' && [items[4].dbId, items[4].edited, items[4].canEdit, items[4].canDelete], [5, true, true, false]);
  assert.equal(items[5].kind === 'event' && eventText(items[5]), 'force-pushed the branch from aaa to bbb');
  assert.equal(items[6].kind === 'event' && items[6].label?.name, 'bug');
  assert.equal(items[7].kind === 'event' && eventText(items[7]), 'requested a review from a/core');
});

test('squash defaults follow the repository settings', () => {
  const pr = { title: 'Add things', body: 'Body', number: 7 };
  const one = [{ sha: 'a', short: 'a', headline: 'Only', author: null, checks: null }];
  const two = [...one, { sha: 'b', short: 'b', headline: 'Second', author: null, checks: null }];
  assert.deepEqual(squashDefaults({ squashMergeCommitTitle: 'COMMIT_OR_PR_TITLE', squashMergeCommitMessage: 'COMMIT_MESSAGES' }, pr, one), { title: 'Only (#7)', message: '' });
  assert.deepEqual(squashDefaults({ squashMergeCommitTitle: 'COMMIT_OR_PR_TITLE', squashMergeCommitMessage: 'COMMIT_MESSAGES' }, pr, two), {
    title: 'Add things (#7)', message: '* Only\n\n* Second',
  });
  assert.deepEqual(squashDefaults({ squashMergeCommitTitle: 'PR_TITLE', squashMergeCommitMessage: 'PR_BODY' }, pr, one), { title: 'Add things (#7)', message: 'Body' });
  assert.equal(squashDefaults({ squashMergeCommitMessage: 'BLANK' }, pr, two).message, '');
});

test('merge status says why it cannot be merged', () => {
  const o = (pr: Record<string, unknown> = {}) => toOverview(payload(pr));
  assert.deepEqual([mergeStatus(o()).title, mergeStatus(o()).canMerge, mergeStatus(o()).waits], ['Review required', false, true]);
  assert.match(mergeStatus(o()).detail, /Checks running/);
  assert.equal(mergeStatus(o({ reviewDecision: 'CHANGES_REQUESTED' })).tone, 'danger');
  assert.equal(mergeStatus(o({ reviewDecision: 'APPROVED' })).title, 'Waiting for checks');
  assert.equal(mergeStatus(o({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })).title, 'Conflicts');
  assert.equal(mergeStatus(o({ mergeStateStatus: 'BEHIND' })).title, 'Behind main');
  assert.equal(mergeStatus(o({ isDraft: true, mergeStateStatus: 'DRAFT' })).canMerge, false);
  assert.equal(mergeStatus(o({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })).canMerge, false);
  const clean = mergeStatus(o({ mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' }));
  assert.deepEqual([clean.title, clean.canMerge, clean.tone], ['Ready to merge', true, 'success']);
  assert.equal(mergeStatus(o({ mergeStateStatus: 'UNSTABLE' })).canMerge, true);
  const queued = o({ isInMergeQueue: true, mergeQueueEntry: { position: 2 }, mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' });
  assert.deepEqual([queued.state, queued.queuePosition], ['queued', 2]);
  assert.deepEqual([mergeStatus(queued).title, mergeStatus(queued).canMerge], ['Queued to merge', false]);
  assert.match(mergeStatus(queued).detail, /Number 2 in main's merge queue/);
});

test("a pull request's state: merged and closed first, then queued, then draft", () => {
  assert.equal(prState({ state: 'OPEN' }), 'open');
  assert.equal(prState({ state: 'OPEN', isDraft: true }), 'draft');
  assert.equal(prState({ state: 'OPEN', isInMergeQueue: true }), 'queued');
  assert.equal(prState({ state: 'MERGED', isInMergeQueue: true }), 'merged');
  assert.equal(prState({ state: 'CLOSED', isDraft: true }), 'closed');
});

test("reviews: no approving one's own pull request, and words unless approving or carrying diff comments", () => {
  const theirs = toOverview(payload());
  const mine: PrOverview = { ...theirs, mine: true, pending: null };
  assert.equal(reviewRefusal(theirs, 'APPROVE'), null);
  assert.match(reviewRefusal(mine, 'APPROVE') ?? '', /can't approve your own/);
  assert.match(reviewRefusal(mine, 'REQUEST_CHANGES') ?? '', /can't request changes/);
  assert.equal(reviewRefusal(mine, 'COMMENT'), null);
  assert.equal(reviewNeeds(mine, 'COMMENT', ''), 'Write a comment first.');
  assert.equal(reviewNeeds(mine, 'APPROVE', ''), null);
  assert.equal(reviewNeeds(theirs, 'COMMENT', ''), null, 'the pending review has comments');
});

test('the fake GitHub: a review submits the pending one, and a merge refuses a head that moved', async () => {
  const v = { owner: 'acme', name: 'widgets', number: 12 };
  const before = toOverview(await mockGraphql('query PrViewOverview', v));
  assert.equal(before.pending?.comments, 2);
  await mockGraphql('mutation PrViewSubmitReview', { id: before.pending?.id, event: 'COMMENT', body: 'Nits' });
  const after = toOverview(await mockGraphql('query PrViewOverview', v));
  assert.equal(after.pending, null);
  const review = after.timeline.at(-1);
  assert.deepEqual(review?.kind === 'review' && [review.state, review.body, review.comments], ['commented', 'Nits', 2]);
  await assert.rejects(mockRest('PUT', '/repos/acme/widgets/pulls/12/merge', { merge_method: 'squash', sha: 'f'.repeat(40) }), /Head branch was modified/);
  await mockRest('PUT', '/repos/acme/widgets/pulls/12/merge', { merge_method: 'squash', sha: after.headSha });
  const merged = toOverview(await mockGraphql('query PrViewOverview', v));
  assert.equal(merged.state, 'merged');
  const last = merged.timeline.at(-1);
  assert.equal(last?.kind === 'event' ? last.type : null, 'merged');
  assert.equal(db.pulls.find((p: any) => p.number === 12).state, 'MERGED');
});
