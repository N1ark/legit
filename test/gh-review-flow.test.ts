import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { PrReview } from '../src/shared/gh-review.ts';

// The demo repo (scripts/gh-demo.ts) against the fake GitHub, as `LEGIT_GITHUB_MOCK=1` runs it.
process.env.LEGIT_GITHUB_MOCK = '1';
const { githubRoute } = await import('../src/server/gh/routes.ts');
const { db } = await import('../src/server/gh/mock/registry.ts');
await import('../src/server/gh/mock/index.ts');
const { Repo } = await import('../src/server/repo.ts');

const tmp = mkdtempSync(join(tmpdir(), 'legit-ghflow-'));
const dir = join(tmp, 'demo');
let repo: InstanceType<typeof Repo>;
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const post = <T = PrReview>(name: string, body: unknown) => githubRoute(repo, 'POST', name, body) as Promise<T>;
const get = <T = PrReview>(name: string, q: Record<string, string>) => githubRoute(repo, 'GET', name, new URLSearchParams(q)) as Promise<T>;

before(async () => {
  execFileSync(process.execPath, ['scripts/gh-demo.ts', dir], { stdio: 'ignore' });
  repo = await Repo.open(dir);
  await get('reviewThreads', { number: '13' });
});
after(() => rmSync(tmp, { recursive: true, force: true }));

test('a comment on a whole file, alone or in the pending review; refused for a file the pull request leaves alone', async () => {
  const head = git('rev-parse', 'HEAD');
  const first = git('rev-parse', 'HEAD~1');
  let r = await post('reviewComment', { number: 13, commitId: head, path: 'src/parser.ts', subject: 'FILE', line: 0, side: 'RIGHT', body: 'On the parser' });
  const t = r.threads.find((x) => x.comments[0].body === 'On the parser');
  assert.equal(t?.subject, 'FILE');
  assert.equal(t?.line, null);
  assert.ok(!t?.comments[0].pending);
  r = await post('reviewComment', { number: 13, commitId: first, path: 'src/errors.ts', subject: 'FILE', line: 0, side: 'RIGHT', body: 'Pending one', pending: true });
  assert.equal(r.threads.find((x) => x.comments[0].body === 'Pending one')?.subject, 'FILE');
  assert.equal(r.pending?.comments, 1);
  await assert.rejects(
    post('reviewComment', { number: 13, commitId: head, path: 'README.md', subject: 'FILE', line: 0, side: 'RIGHT', body: 'Nope' }),
    /files the pull request changes/,
  );
  db.threads = db.threads.filter((x: { comments: { body: string }[] }) => !['On the parser', 'Pending one'].includes(x.comments[0]?.body));
  delete db.pending[13];
  assert.equal((await get('reviewThreads', { number: '13', fresh: '1' })).pending, null);
});
