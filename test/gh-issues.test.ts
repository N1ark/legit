import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blobUrl, lineSpan, refAt, refCard, refStateWords, repoUrl } from '../src/ui/lib/gh-links.ts';

// The fake GitHub answers every call (see src/server/gh/mock/), so set it before the modules load.
process.env.LEGIT_GITHUB_MOCK = '1';
const { refsQuery, resolveRefs, toIssueRef } = await import('../src/server/gh/issues.ts');
await import('../src/server/gh/mock/index.ts');

test('permalinks to a line or a span of lines, with the path encoded', () => {
  assert.equal(repoUrl('acme/widgets'), 'https://github.com/acme/widgets');
  assert.equal(repoUrl('acme/widgets', 'actions'), 'https://github.com/acme/widgets/actions');
  assert.equal(blobUrl('a/b', 'abc', 'src/x.ts', [10, 10]), 'https://github.com/a/b/blob/abc/src/x.ts#L10');
  assert.equal(blobUrl('a/b', 'abc', 'src/x.ts', [10, 14]), 'https://github.com/a/b/blob/abc/src/x.ts#L10-L14');
  assert.equal(blobUrl('a/b', 'abc', 'docs/a b#c.md', null), 'https://github.com/a/b/blob/abc/docs/a%20b%23c.md');
  assert.deepEqual(lineSpan([14, 0, 10, 12]), [10, 14]);
  assert.equal(lineSpan([0, 0]), null);
});

test('the reference being typed: after a space or at the start, up to the end of its word', () => {
  assert.deepEqual(refAt('Fix #12', 7), { from: 4, to: 7, query: '12' });
  assert.deepEqual(refAt('#', 1), { from: 0, to: 1, query: '' });
  assert.deepEqual(refAt('(#par', 5), { from: 1, to: 5, query: 'par' });
  assert.deepEqual(refAt('Fix #12 now', 6), { from: 4, to: 7, query: '12' });
  assert.equal(refAt('abc#12', 6), null);
  assert.equal(refAt('&#12', 4), null);
  assert.equal(refAt('Fix #12 now', 11), null);
  assert.equal(refAt('#12.', 4), null);
});

test("a reference's state in words", () => {
  assert.equal(refStateWords({ state: 'open', isPullRequest: false, notPlanned: false }), 'Open issue');
  assert.equal(refStateWords({ state: 'closed', isPullRequest: false, notPlanned: true }), 'Closed issue (not planned)');
  assert.equal(refStateWords({ state: 'merged', isPullRequest: true, notPlanned: false }), 'Merged pull request');
  assert.equal(refStateWords({ state: 'draft', isPullRequest: true, notPlanned: false }), 'Draft pull request');
  const ref = { repo: 'a/b', number: 7, title: 'Fix <b> & co', state: 'open' as const, isPullRequest: false, notPlanned: false, author: { login: 'hubot', avatar: '' }, url: '' };
  assert.equal(refCard(ref, '⌘-click to open'), '<b>Fix &#60;b&#62; &#38; co</b> #7<br>Open issue by hubot<br>⌘-click to open');
});

test('references are asked for in one query: a repository each, an aliased number each', () => {
  const q = refsQuery(['acme/widgets#7', 'acme/widgets#12', 'other/repo#3', 'not a ref']);
  assert.match(q.query, /^query ResolveRefs\(\$o0: String!, \$n0: String!, \$r0_0: Int!, \$r0_1: Int!, \$o1: String!, \$n1: String!, \$r1_0: Int!\)/);
  assert.match(q.query, /r0: repository\(owner: \$o0, name: \$n0\) \{ i0: issueOrPullRequest\(number: \$r0_0\)/);
  assert.deepEqual(q.variables, { o0: 'acme', n0: 'widgets', r0_0: 7, r0_1: 12, o1: 'other', n1: 'repo', r1_0: 3 });
  assert.deepEqual(q.paths, [
    ['acme/widgets#7', 'r0', 'i0'],
    ['acme/widgets#12', 'r0', 'i1'],
    ['other/repo#3', 'r1', 'i0'],
  ]);
});

test("GitHub's issues and pull requests as references", () => {
  const base = { number: 3, title: 'T', url: 'u', author: null, repository: { nameWithOwner: 'a/b' } };
  assert.equal(toIssueRef({ ...base, __typename: 'Issue', state: 'CLOSED', stateReason: 'NOT_PLANNED' })?.notPlanned, true);
  assert.equal(toIssueRef({ ...base, __typename: 'PullRequest', state: 'OPEN', isDraft: true })?.state, 'draft');
  assert.equal(toIssueRef({ ...base, __typename: 'PullRequest', state: 'MERGED', isDraft: false })?.state, 'merged');
  assert.equal(toIssueRef(null), null);
});

test('resolving references against the fake GitHub: issues, pull requests, and nothing', async () => {
  const got = await resolveRefs(['acme/widgets#7', 'ACME/widgets#12', 'acme/widgets#99', 'else/where#1']);
  assert.equal(got['acme/widgets#7']?.title, 'Parse errors should say which line they are on');
  assert.equal(got['acme/widgets#12']?.isPullRequest, true);
  assert.equal(got['acme/widgets#99'], null);
  assert.equal(got['else/where#1'], null);
});

test("without an upstream remote, issue links go to the repository GitHub says the fork is of", async () => {
  const { onRest } = await import('../src/server/gh/mock/registry.ts');
  const { forkParent, issueRepo } = await import('../src/server/gh/context.ts');
  onRest('GET /repos/:owner/:repo', ({ owner, repo }) =>
    owner === 'me' ? { full_name: `me/${repo}`, fork: true, parent: { full_name: `up/${repo}` } } : { full_name: `${owner}/${repo}`, fork: false },
  );
  assert.equal(await forkParent('me/fork-test'), 'up/fork-test');
  assert.equal(await forkParent('acme/not-a-fork'), null);
  // Known now, so not waited for.
  assert.equal(await issueRepo(new Map([['origin', 'git@github.com:me/fork-test.git']])), 'up/fork-test');
  assert.equal(await issueRepo(new Map([['origin', 'git@github.com:acme/not-a-fork.git']])), 'acme/not-a-fork');
});
