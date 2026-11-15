import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { checkoutPr, fetchPrHead, planCheckout, remoteFor } from '../src/server/gh/checkout.ts';
import { ghRepos } from '../src/server/gh/context.ts';
import { toInbox } from '../src/server/gh/inbox.ts';
import { mockGraphql } from '../src/server/gh/mock/registry.ts';
import '../src/server/gh/mock/index.ts';
import { Repo } from '../src/server/repo.ts';
import { inboxList, parsePrRef } from '../src/ui/lib/gh-inbox.ts';
import type { InboxPr, PrInbox } from '../src/shared/gh-inbox.ts';
import { setup } from './util.ts';

const t = setup();
const { git, commit } = t;

// Worktrees go next to the repo, so each test's repo gets a folder of its own.
beforeEach(() => {
  t.dir = join(t.tmp(), 'repo');
  mkdirSync(t.dir);
  git('init', '-q', '-b', 'main');
});

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

/** A remote with pull request 5 on `feature` (and refs/pull/5/head), and the repo opened. */
async function withPr() {
  const base = commit('base', { f: '1\n' });
  const remote = t.remote();
  git('push', '-q', 'origin', 'main');
  git('switch', '-q', '-c', 'feature');
  const head = commit('feature', { g: '1\n' });
  git('push', '-q', 'origin', 'feature', 'HEAD:refs/pull/5/head');
  git('switch', '-q', 'main');
  git('branch', '-q', '-D', 'feature');
  return { base, head, remote, repo: await Repo.open(t.dir) };
}

test("check out a pull request: a branch tracking its head's, fast-forwarded when it moves on", async () => {
  const { head, remote, repo } = await withPr();
  const sha = await fetchPrHead(repo.git, 'origin', 5, 'feature');
  assert.equal(sha, head);
  assert.equal(git('rev-parse', 'refs/worktree/legit/pull/5/head'), head);
  assert.equal(git('rev-parse', 'refs/remotes/origin/feature'), head);
  const pr = { number: 5, head: 'feature', owner: 'a' };
  const plan = await planCheckout(repo, pr, sha, 'origin');
  assert.deepEqual([plan.branch, plan.relation, plan.tip, plan.upstream], ['feature', 'new', null, { remote: 'origin', branch: 'feature' }]);
  const r = await checkoutPr(repo, plan);
  assert.equal(r.branch, 'feature');
  assert.equal(git('branch', '--show-current'), 'feature');
  assert.equal(git('rev-parse', '--abbrev-ref', 'feature@{upstream}'), 'origin/feature');

  // Pushed to since: the branch you're on is fast-forwarded; then, left, the branch alone.
  const other = t.tmp();
  t.gitIn(other, 'clone', '-q', remote, '.');
  t.gitIn(other, 'switch', '-q', 'feature');
  const next = (n: string) => {
    t.gitIn(other, 'commit', '-q', '--allow-empty', '-m', n);
    t.gitIn(other, 'push', '-q', 'origin', 'feature', 'HEAD:refs/pull/5/head');
    return t.gitIn(other, 'rev-parse', 'HEAD');
  };
  const second = next('second');
  let p = await planCheckout(repo, pr, await fetchPrHead(repo.git, 'origin', 5, 'feature'), 'origin');
  assert.deepEqual([p.relation, p.current, p.behind], ['behind', true, 1]);
  await checkoutPr(repo, p);
  assert.equal(git('rev-parse', 'HEAD'), second);
  git('switch', '-q', 'main');
  const third = next('third');
  p = await planCheckout(repo, pr, await fetchPrHead(repo.git, 'origin', 5, 'feature'), 'origin');
  assert.deepEqual([p.relation, p.current], ['behind', false]);
  await checkoutPr(repo, p);
  assert.equal(git('rev-parse', 'feature'), third);
  assert.equal(git('branch', '--show-current'), 'feature');
  p = await planCheckout(repo, pr, third, 'origin');
  assert.equal(p.relation, 'same');
});

test("a branch that diverged from the pull request isn't clobbered unless asked", async () => {
  const { base, head, repo } = await withPr();
  git('branch', 'feature', base);
  git('branch', '--set-upstream-to=main', 'feature');
  git('switch', '-q', 'feature');
  const mine = commit('mine', { h: '1\n' });
  git('switch', '-q', 'main');
  const pr = { number: 5, head: 'feature', owner: 'a' };
  const sha = await fetchPrHead(repo.git, 'origin', 5);

  // `feature` tracks something else: the pull request goes on pr/5.
  let plan = await planCheckout(repo, pr, sha, 'origin');
  assert.deepEqual([plan.branch, plan.relation], ['pr/5', 'new']);

  // Tracking the pull request's branch but diverged: refused, unless reset (its tip kept in backups).
  git('branch', '--set-upstream-to=origin/feature', 'feature');
  plan = await planCheckout(repo, pr, sha, 'origin');
  assert.deepEqual([plan.branch, plan.relation, plan.ahead, plan.behind, plan.alternative], ['feature', 'diverged', 1, 1, 'pr/5']);
  await assert.rejects(checkoutPr(repo, plan), (e: Error & { code?: string }) => e.code === 'pr-diverged');
  assert.equal(git('rev-parse', 'feature'), mine);
  await checkoutPr(repo, { ...plan, branch: plan.alternative, tip: null, upstream: null });
  assert.equal(git('branch', '--show-current'), 'pr/5');
  assert.equal(git('rev-parse', 'pr/5'), head);
  await checkoutPr(repo, { ...plan, reset: true });
  assert.equal(git('rev-parse', 'feature'), head);
  assert.equal(git('branch', '--show-current'), 'feature');
  assert.ok(git('for-each-ref', '--format=%(objectname)', 'refs/legit/backups/feature/').includes(mine));

  // Moved since the plan: nothing happens.
  await assert.rejects(checkoutPr(repo, { ...plan, reset: true }), /changed meanwhile/);
});

test("a fork's pull request goes on <owner>/<branch>, tracking nothing, or in a worktree of its own", async () => {
  const { head, repo } = await withPr();
  const sha = await fetchPrHead(repo.git, 'origin', 5);
  const pr = { number: 5, head: 'feature', owner: 'mona' };
  let plan = await planCheckout(repo, pr, sha, null);
  assert.deepEqual([plan.branch, plan.upstream], ['mona/feature', null]);
  const r = await checkoutPr(repo, { ...plan, newWorktree: true });
  assert.ok(r.path && existsSync(join(r.path, 'g')));
  assert.equal(t.gitIn(r.path, 'rev-parse', 'HEAD'), head);
  assert.equal(git('branch', '--show-current'), 'main');
  assert.equal(git('for-each-ref', '--format=%(upstream)', 'refs/heads/mona/feature'), '');
  assert.equal(git('config', '--get', 'branch.mona/feature.legit-head'), 'mona:feature');

  // Asked again, it's in that worktree.
  plan = await planCheckout(repo, pr, sha, null);
  assert.equal(plan.branch, 'mona/feature');
  assert.equal(plan.worktree, r.path);
  await assert.rejects(checkoutPr(repo, plan), /checked out in/);
});

test('the remote of a GitHub repository', async () => {
  const repo = await Repo.open(t.dir);
  git('remote', 'add', 'origin', 'git@github.com:me/widgets.git');
  git('remote', 'add', 'upstream', 'https://github.com/Acme/widgets.git');
  git('remote', 'add', 'other', 'https://github.com/acme/widgets');
  assert.equal(await remoteFor(repo.git, 'acme/widgets'), 'upstream');
  assert.equal(await remoteFor(repo.git, 'me/widgets'), 'origin');
  assert.equal(await remoteFor(repo.git, 'you/widgets'), null);

  // A fork's pull request checked out tracking nothing is found by the head it notes.
  git('config', 'branch.mona/feature.legit-head', 'mona:feature');
  assert.deepEqual(await ghRepos(repo, 'mona/feature'), { base: 'Acme/widgets', owner: 'Acme', name: 'widgets', headOwner: 'mona', head: 'feature' });
  assert.equal((await ghRepos(repo, 'main'))?.head, undefined);
});
