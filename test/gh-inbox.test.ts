import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toInbox } from '../src/server/gh/inbox.ts';
import { mockGraphql } from '../src/server/gh/mock/registry.ts';
import '../src/server/gh/mock/index.ts';
import { inboxList, parsePrRef } from '../src/ui/lib/gh-inbox.ts';
import type { InboxPr, PrInbox } from '../src/shared/gh-inbox.ts';

const node = (number: number, more: Record<string, unknown> = {}) => ({
  number, title: `PR ${number}`, url: `https://github.com/a/b/pull/${number}`, state: 'OPEN', isDraft: false, isInMergeQueue: false,
  baseRefName: 'main', headRefName: `b${number}`, headRefOid: 'a'.repeat(40), author: { login: 'mona', avatarUrl: '' },
  repository: { nameWithOwner: 'a/b' }, headRepositoryOwner: { login: 'a' }, updatedAt: `2026-10-0${number}T10:00:00Z`,
  reviewDecision: 'APPROVED', isCrossRepository: false, headRepository: { nameWithOwner: 'a/b' }, comments: { totalCount: 2 },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] }, reviewRequests: { nodes: [] }, assignees: { nodes: [] },
  ...more,
});
const list = (...nodes: unknown[]) => ({ issueCount: nodes.length, nodes });

test('the inbox lists each pull request once, with why it is there, newest first', () => {
  const team = node(1, { reviewRequests: { nodes: [{ requestedReviewer: { combinedSlug: 'a/core' } }] } });
  const direct = node(2, { reviewRequests: { nodes: [{ requestedReviewer: { login: 'Me' } }, { requestedReviewer: { combinedSlug: 'a/core' } }] } });
  const fork = node(3, { author: { login: 'me', avatarUrl: '' }, isCrossRepository: true, headRepository: { nameWithOwner: 'x/b' }, reviewDecision: null });
  const inbox = toInbox({ viewer: { login: 'me' }, review: list(team, direct), mine: list(fork), assigned: list(direct), open: { issueCount: 80, nodes: [team, direct, fork] } });
  assert.deepEqual(inbox.items.map((p) => p.number), [3, 2, 1]);
  assert.deepEqual(inbox.counts, { review: 2, mine: 1, assigned: 1, open: 80 });
  const [f, d, tm] = inbox.items;
  assert.deepEqual([f.requested, d.requested, tm.requested], [null, 'you', 'a/core']);
  assert.deepEqual([f.mine, d.assigned, tm.assigned], [true, true, false]);
  assert.equal(f.fork, 'x/b');
  assert.equal(d.fork, null);
  assert.equal(d.checks, 'failure');
  assert.equal(d.reviewDecision, 'approved');
  assert.equal(f.reviewDecision, null);
  assert.deepEqual(inboxList(inbox.items, 'review').map((p) => p.number), [2, 1]);
  assert.deepEqual(inboxList(inbox.items, 'open').map((p) => p.number), [3, 2, 1]);
});

test("the mock's inbox: review requested through a team too, a fork's, and closed ones only by number", async () => {
  const q = (s: string) => `repo:acme/widgets is:pr is:open ${s} sort:updated-desc`;
  const d = await mockGraphql('query PrInbox { x }', { review: q('review-requested:@me'), mine: q('author:@me'), assigned: q('assignee:@me'), open: q('') });
  const inbox: PrInbox = toInbox(d);
  const nums = (l: InboxPr[]) => l.map((p) => p.number).sort((a, b) => a - b);
  assert.deepEqual(nums(inboxList(inbox.items, 'review')), [14, 15]);
  assert.deepEqual(nums(inboxList(inbox.items, 'mine')), [12, 13]);
  assert.ok(inboxList(inbox.items, 'assigned').some((p) => p.number === 16));
  assert.ok(!inbox.items.some((p) => p.number === 10 || p.number === 9));
  assert.equal(inbox.items.find((p) => p.number === 15)?.fork, 'defunkt/widgets');
  const closed = (await mockGraphql('query PrLookup { x }', { number: 10 })) as any;
  assert.equal(closed.repository.pullRequest.state, 'CLOSED');
});

test('a pull request is found in the filter by #number, number or URL of this repo', () => {
  assert.deepEqual(parsePrRef('#12', 'acme/widgets'), { number: 12, repo: 'acme/widgets' });
  assert.deepEqual(parsePrRef(' 7 ', 'acme/widgets'), { number: 7, repo: 'acme/widgets' });
  assert.deepEqual(parsePrRef('https://github.com/Acme/Widgets/pull/3/files', 'acme/widgets'), { number: 3, repo: 'acme/widgets' });
  assert.deepEqual(parsePrRef('github.com/other/thing/pull/5', 'acme/widgets'), { number: 5, repo: 'other/thing' });
  assert.deepEqual(parsePrRef('acme/widgets#9', 'acme/widgets'), { number: 9, repo: 'acme/widgets' });
  assert.equal(parsePrRef('parser', 'acme/widgets'), null);
  assert.equal(parsePrRef('#0', 'acme/widgets'), null);
  assert.equal(parsePrRef('12 errors', 'acme/widgets'), null);
});
