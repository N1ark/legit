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
const { mockCalls, mockLimits } = await import('../src/server/gh/mock/registry.ts');
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

test('the status brings the pull request of the branch asked about when the server has it at hand', async () => {
  const repo = await Repo.open(demo);
  const get = (name: string, q: Record<string, string> = {}) => githubRoute(repo, 'GET', name, new URLSearchParams(q)) as Promise<any>;
  const pr = await get('pr', { branch: 'feature/parser' });
  assert.deepEqual(await calls(async () => assert.deepEqual((await get('status', { branch: 'feature/parser' })).pr, pr)), []);
  assert.equal((await get('status', { branch: 'feature/cache' })).pr, undefined);
  assert.equal((await get('status')).pr, undefined);
  await get('pr', { branch: 'feature/cache' });
  assert.equal((await get('status', { branch: 'feature/cache' })).pr, null);
});

test("checks aren't warmed for a head the branch's remote-tracking ref isn't at (the header shows another commit's)", async () => {
  const repo = await Repo.open(demo);
  const ref = `refs/remotes/origin/${git('symbolic-ref', '--short', 'HEAD')}`;
  const tip = git('rev-parse', ref);
  git('update-ref', ref, `${tip}~`);
  try {
    assert.ok(!(await calls(() => warmGithub(repo))).includes('GraphQL CommitChecks'));
  } finally {
    git('update-ref', ref, tip);
  }
  assert.ok((await calls(() => warmGithub(repo))).includes('GraphQL CommitChecks'));
});

test("the warm-up also has the pull request's stack and review threads ready", async () => {
  const repo = await Repo.open(demo);
  const get = (name: string, q: Record<string, string> = {}) => githubRoute(repo, 'GET', name, new URLSearchParams(q)) as Promise<any>;
  // A branch the stack and threads weren't looked up for yet, with another branch about.
  const was = git('symbolic-ref', '--short', 'HEAD');
  const branch = 'feature/parser';
  git('switch', '-q', branch);
  git('branch', 'extra');
  after(() => (git('switch', '-q', was), git('branch', '-D', 'extra')));
  assert.deepEqual((await calls(() => warmGithub(repo))).filter((c) => /PrStack|ReviewThreads/.test(c)).sort(), ['GraphQL PrStack', 'GraphQL ReviewThreads']);
  const pr = await get('pr', { branch });
  assert.deepEqual(await calls(() => Promise.all([get('prStack', { branch }), get('reviewThreads', { number: String(pr.number) })])), []);
});

test("a REST read asked again sends its ETag, and GitHub's 304 is answered with what it had", async () => {
  const repo = await Repo.open(demo);
  const checks = (await githubRoute(repo, 'GET', 'checks', new URLSearchParams({ sha: git('rev-parse', 'origin/feature/parser') }))) as any;
  const path = `/repos/acme/widgets/actions/jobs/${checks.groups[0].jobs[0].jobId}`;
  let first: any;
  assert.deepEqual(await calls(async () => (first = await rest('GET', path))), [`GET ${path}`]);
  let again: any;
  assert.deepEqual(await calls(async () => (again = await rest('GET', path))), [`GET ${path} 304`]);
  assert.deepEqual(again, first);
});

test("a finished job's steps and log are asked for side by side, once; a running one's each time", async () => {
  const repo = await Repo.open(demo);
  const get = (name: string, q: Record<string, string> = {}) => githubRoute(repo, 'GET', name, new URLSearchParams(q)) as Promise<any>;
  const done = (await get('checks', { sha: git('rev-parse', 'origin/feature/parser') })).groups[0].jobs[1].jobId;
  const jobs = `/repos/acme/widgets/actions/jobs/${done}`;
  let log: any;
  assert.deepEqual((await calls(async () => (log = await get('checksLog', { job: String(done) })))).sort(), [`GET ${jobs}`, `GET ${jobs}/logs`]);
  assert.ok(log.steps.some((s: any) => s.lines.length));
  assert.deepEqual(await calls(async () => assert.deepEqual(await get('checksLog', { job: String(done) }), log)), []);
  assert.deepEqual(await calls(() => get('checksJob', { job: String(done) })), []);

  const queued = (await get('checks', { sha: git('rev-parse', 'origin/feature/pretty-errors') })).groups[0].jobs[0].jobId;
  await assert.rejects(get('checksLog', { job: String(queued) }), /once the job finishes/);
  assert.equal((await calls(() => get('checksJob', { job: String(queued) }))).length, 1);
});

test('rate-limited, requests wait it out rather than each asking GitHub again', async () => {
  const path = '/repos/acme/widgets/actions/runs/1/rerun';
  const refused = { code: 'github-limit' };
  const limits = [() => ({ 'retry-after': '1' }), () => ({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 1) })];
  for (const headers of limits) {
    mockLimits.headers = headers();
    assert.equal((await calls(() => assert.rejects(rest('GET', '/notifications'), refused))).length, 1);
    mockLimits.headers = {};
    assert.deepEqual(await calls(() => assert.rejects(rest('POST', path, undefined, { text: true }), refused)), []);
    await new Promise((r) => setTimeout(r, 2100));
    assert.match((await calls(() => rest('GET', '/notifications'))).join(), /^GET \/notifications( 304)?$/);
  }
});
