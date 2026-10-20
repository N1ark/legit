import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Against the fake GitHub, on the demo repo (scripts/gh-demo.ts), counting the calls it answers.
process.env.LEGIT_GITHUB_MOCK = '1';
const { Repo } = await import('../src/server/repo.ts');
await import('../src/server/gh/mock/index.ts');
const { mockCalls } = await import('../src/server/gh/mock/registry.ts');
const { graphql, rest } = await import('../src/server/gh/client.ts');
const { ghRepos } = await import('../src/server/gh/context.ts');
const { githubRoute, warmGithub } = await import('../src/server/gh/routes.ts');

const dir = mkdtempSync(join(tmpdir(), 'legit-gh-cache-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const demo = join(dir, 'demo');
execFileSync('node', ['scripts/gh-demo.ts', demo], { stdio: 'ignore' });
const git = (...args: string[]) => execFileSync('git', args, { cwd: demo, encoding: 'utf8' }).trim();

/** The GitHub calls `fn` makes. */
async function calls(fn: () => Promise<unknown>): Promise<string[]> {
  const from = mockCalls.length;
  await fn();
  return mockCalls.slice(from);
}

test('identical reads still waiting share one call, each caller with its own copy; writes never do', async () => {
  const q = 'query Viewer { viewer { login } }';
  let got: any[] = [];
  assert.deepEqual(await calls(async () => (got = await Promise.all([graphql(q), graphql(q), graphql(q)]))), ['GraphQL Viewer']);
  assert.deepEqual(got.map((g) => g.viewer.login), ['octocat', 'octocat', 'octocat']);
  assert.notEqual(got[0], got[1]);
  assert.deepEqual(await calls(() => graphql(q)), ['GraphQL Viewer']);
  assert.deepEqual(await calls(() => Promise.all([graphql(q, { a: 1 }), graphql(q, { a: 2 })])), ['GraphQL Viewer', 'GraphQL Viewer']);
  const path = '/notifications?all=true&per_page=50';
  assert.deepEqual(await calls(() => Promise.all([rest('GET', path), rest('GET', path)])), [`GET /notifications`]);
  assert.deepEqual(await calls(() => Promise.all([rest('PATCH', '/notifications/threads/1'), rest('PATCH', '/notifications/threads/1')])), [
    'PATCH /notifications/threads/1', 'PATCH /notifications/threads/1',
  ]);
});

test("the repos come from the push remote's config, and a repo without a GitHub remote has none", async () => {
  const repo = await Repo.open(demo);
  assert.deepEqual(await ghRepos(repo), { base: 'acme/widgets', owner: 'acme', name: 'widgets', headOwner: 'acme' });
  git('remote', 'add', 'fork', 'git@github.com:mona/widgets.git');
  git('config', 'branch.feature/parser.pushRemote', 'fork');
  assert.equal((await ghRepos(repo, 'feature/parser'))?.headOwner, 'mona');
  assert.equal((await ghRepos(repo, 'main'))?.headOwner, 'acme');
  git('config', 'remote.pushDefault', 'fork');
  assert.equal((await ghRepos(repo, 'main'))?.headOwner, 'mona');
  git('config', '--unset', 'remote.pushDefault');
  git('config', '--unset', 'branch.feature/parser.pushRemote');
  git('remote', 'remove', 'fork');

  const plain = join(dir, 'plain');
  execFileSync('git', ['init', '-q', plain]);
  assert.equal(await ghRepos(await Repo.open(plain)), null);
  assert.deepEqual(await calls(async () => warmGithub(await Repo.open(plain))), []);
});

test('a server warms what the page asks first: those answers come without asking GitHub, once', async () => {
  const repo = await Repo.open(demo);
  const get = (name: string, q: Record<string, string> = {}) => githubRoute(repo, 'GET', name, new URLSearchParams(q)) as Promise<any>;
  const branch = git('symbolic-ref', '--short', 'HEAD');
  await warmGithub(repo);
  const head = git('rev-parse', 'HEAD');
  let pr: any;
  let checks: any;
  assert.deepEqual(
    await calls(async () => {
      await get('status');
      pr = await get('pr', { branch });
      checks = await get('checks', { sha: head, pr: String(pr.number) });
      await get('notifs');
    }),
    [],
  );
  assert.equal(pr.headSha, head);
  assert.equal(checks.sha, head);
  // Only the first look is warmed: the poll after it asks GitHub.
  assert.deepEqual(await calls(() => get('checks', { sha: head, pr: String(pr.number) })), ['GraphQL CommitChecks']);
  assert.deepEqual((await calls(() => get('notifs'))).filter((c) => c.startsWith('GET')), ['GET /notifications']);
});
