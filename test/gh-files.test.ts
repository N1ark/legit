import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { viewedCount } from '../src/ui/lib/gh-files.ts';

// Against the fake GitHub, on the demo repo (scripts/gh-demo.ts), as gh-cache.test.ts does.
process.env.LEGIT_GITHUB_MOCK = '1';
const { Repo } = await import('../src/server/repo.ts');
await import('../src/server/gh/mock/index.ts');
const { db, mockCalls } = await import('../src/server/gh/mock/registry.ts');
const { githubRoute } = await import('../src/server/gh/routes.ts');
const { codeownersOf } = await import('../src/server/gh/prfiles.ts');

const dir = mkdtempSync(join(tmpdir(), 'legit-gh-files-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const demo = join(dir, 'demo');
execFileSync('node', ['scripts/gh-demo.ts', demo], { stdio: 'ignore' });
const git = (...args: string[]) => execFileSync('git', args, { cwd: demo, encoding: 'utf8' }).trim();

test("viewed counts the pull request's files shown; a dismissed mark isn't viewed", () => {
  const viewed = { 'a.ts': 'VIEWED', 'b.ts': 'DISMISSED', 'c.ts': 'UNVIEWED', 'd.ts': 'VIEWED' } as const;
  assert.deepEqual(viewedCount(['a.ts', 'b.ts', 'c.ts', 'local.ts'], viewed), { viewed: 1, total: 3 });
  assert.deepEqual(viewedCount([], viewed), { viewed: 0, total: 0 });
});

test('CODEOWNERS is the first of the three places the base has one', () => {
  assert.equal(codeownersOf(null), null);
  assert.deepEqual(codeownersOf({ o0: null, o1: { object: { text: 'x @a' } }, o2: { object: { text: 'y @b' } } }), { path: 'CODEOWNERS', text: 'x @a' });
  assert.deepEqual(codeownersOf({ o0: { object: { text: '' } } }), { path: '.github/CODEOWNERS', text: '' });
});

/** The GitHub calls `fn` makes. */
async function calls(fn: () => Promise<unknown>): Promise<string[]> {
  const from = mockCalls.length;
  await fn();
  return mockCalls.slice(from);
}

test("a pull request's files: viewed marks (dismissed by a later change) and CODEOWNERS in one query, more pages for more files", async () => {
  const repo = await Repo.open(demo);
  // Which repo it's on, looked up once.
  await githubRoute(repo, 'GET', 'prFiles', new URLSearchParams({ number: '13' }));
  let files: any;
  assert.deepEqual(await calls(async () => (files = await githubRoute(repo, 'GET', 'prFiles', new URLSearchParams({ number: '13', fresh: '1' })))), ['GraphQL PrFiles']);
  assert.deepEqual(files.viewed, { 'src/errors.ts': 'VIEWED', 'src/parser.ts': 'DISMISSED' });
  assert.equal(files.viewer, 'octocat');
  assert.equal(files.headSha, git('rev-parse', 'origin/feature/parser-errors'));
  assert.equal(files.codeowners.path, '.github/CODEOWNERS');
  assert.match(files.codeowners.text, /src\/parser\.ts @octocat @hubot/);

  db.filesPage = 1;
  try {
    const pages = await calls(async () => (files = await githubRoute(repo, 'GET', 'prFiles', new URLSearchParams({ number: '12', fresh: '1' }))));
    assert.deepEqual(pages, ['GraphQL PrFiles', 'GraphQL PrFiles', 'GraphQL PrFiles']);
    assert.deepEqual(Object.keys(files.viewed).sort(), ['src/build.ts', 'src/parser.ts', 'src/tokenizer.ts']);
    assert.ok(files.codeowners);
  } finally {
    db.filesPage = 100;
  }
});

test('marking a file viewed and not, kept for the next read; GitHub refusing it says why', async () => {
  const repo = await Repo.open(demo);
  const read = async () => ((await githubRoute(repo, 'GET', 'prFiles', new URLSearchParams({ number: '12' }))) as any).viewed;
  await githubRoute(repo, 'GET', 'prFiles', new URLSearchParams({ number: '12', fresh: '1' }));
  assert.deepEqual(await calls(() => githubRoute(repo, 'POST', 'prFileViewed', { number: 12, path: 'src/build.ts', viewed: true })), ['GraphQL MarkFileViewed']);
  assert.deepEqual(await calls(read), []);
  assert.equal((await read())['src/build.ts'], 'VIEWED');
  await githubRoute(repo, 'POST', 'prFileViewed', { number: 12, path: 'src/build.ts', viewed: false });
  assert.equal((await read())['src/build.ts'], 'UNVIEWED');
  await assert.rejects(githubRoute(repo, 'POST', 'prFileViewed', { number: 12, path: 'nope.ts', viewed: true }), /not part of the pull request/);
  await assert.rejects(githubRoute(repo, 'POST', 'prFileViewed', { number: 0, path: 'a', viewed: true }), /Bad pull request number/);
});
