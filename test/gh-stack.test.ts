import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ancestors, byHead, missingBase, stackAround } from '../src/server/gh/stacks.ts';
import { humanize, prDraft } from '../src/ui/lib/gh-pr.ts';
import type { PrState, PullRequest } from '../src/shared/github.ts';

const pr = (number: number, head: string, base: string, state: PrState = 'open'): PullRequest => ({
  number, head, base, state, title: `#${number}`, url: '', headSha: '', author: null, repo: 'o/r',
});
const shape = (prs: PullRequest[], head: string) => stackAround(prs, head, 'main').map((p) => `${' '.repeat(p.indent)}${p.pr.number}`);

test('a linear stack, top first, whichever of its branches is asked about', () => {
  const prs = [pr(12, 'parser', 'main'), pr(13, 'errors', 'parser', 'draft'), pr(14, 'pretty', 'errors')];
  assert.deepEqual(shape(prs, 'errors'), ['14', '13', '12']);
  assert.deepEqual(shape(prs, 'parser'), ['14', '13', '12']);
  assert.deepEqual(shape(prs, 'pretty'), ['14', '13', '12']);
  assert.deepEqual(shape(prs, 'other'), []);
  assert.deepEqual(shape([pr(1, 'a', 'main')], 'a'), ['1']);
});

test('a stack that forks: the branch toward the current one stays in its column, others are indented above', () => {
  const prs = [pr(1, 'a', 'main'), pr(2, 'b', 'a'), pr(3, 'c', 'a'), pr(4, 'd', 'c')];
  assert.deepEqual(shape(prs, 'b'), [' 4', ' 3', '2', '1']);
  assert.deepEqual(shape(prs, 'd'), [' 2', '4', '3', '1']);
});

test("merged and closed pull requests: under the current one they're kept, beside it they're left out", () => {
  const prs = [pr(1, 'a', 'main', 'merged'), pr(2, 'b', 'a'), pr(3, 'c', 'a', 'closed'), pr(4, 'd', 'b', 'merged')];
  assert.deepEqual(shape(prs, 'b'), ['2', '1']);
  assert.deepEqual(shape(prs, 'd'), ['4', '2', '1']);
});

test("a branch's open pull request wins over its older ones; cycles end", () => {
  const heads = byHead([pr(5, 'a', 'main', 'closed'), pr(6, 'a', 'x'), pr(7, 'a', 'y')]);
  assert.equal(heads.get('a')?.number, 6);
  const cycle = [pr(1, 'a', 'b'), pr(2, 'b', 'a')];
  assert.deepEqual(ancestors(byHead(cycle), 'a', 'main').map((p) => p.number), [2]);
  assert.deepEqual(shape(cycle, 'a'), ['1', '2']);
});

test('the base to look up next: below the lowest pull request known, unless it is the trunk', () => {
  assert.equal(missingBase([pr(13, 'errors', 'parser')], 'errors', 'main'), 'parser');
  assert.equal(missingBase([pr(13, 'errors', 'parser'), pr(12, 'parser', 'main')], 'errors', 'main'), null);
  assert.equal(missingBase([pr(13, 'errors', 'parser'), pr(12, 'parser', 'base')], 'errors', 'main'), 'base');
  assert.equal(missingBase([], 'errors', 'main'), null);
});

test("a new pull request's title and description from the branch's commits", () => {
  assert.equal(humanize('feature/parser-errors'), 'Parser errors');
  assert.equal(humanize('fix_the.thing'), 'Fix the thing');
  assert.equal(humanize('x/'), 'X');
  assert.deepEqual(prDraft('feature/cache', [{ subject: 'Cache specs', body: 'By hash.' }]), { title: 'Cache specs', body: 'By hash.' });
  assert.deepEqual(prDraft('feature/parser-errors', [{ subject: 'One', body: 'x' }, { subject: 'Two', body: '' }]), {
    title: 'Parser errors',
    body: '- One\n- Two',
  });
  assert.deepEqual(prDraft('wip', []), { title: 'Wip', body: '' });
});

// Against the fake GitHub, on the demo repo (scripts/gh-demo.ts).
const dir = mkdtempSync(join(tmpdir(), 'legit-gh-stack-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('the stack, restacking after the parent moved or was merged, opening and retargeting pull requests', async () => {
  process.env.LEGIT_GITHUB_MOCK = '1';
  const demo = join(dir, 'demo');
  execFileSync('node', ['scripts/gh-demo.ts', demo], { stdio: 'ignore' });
  const { Repo } = await import('../src/server/repo.ts');
  await import('../src/server/gh/mock/index.ts');
  const { db } = await import('../src/server/gh/mock/registry.ts');
  const { githubRoute } = await import('../src/server/gh/routes.ts');
  const repo = await Repo.open(demo);
  const get = (name: string, q: Record<string, string>) => githubRoute(repo, 'GET', name, new URLSearchParams({ ...q, fresh: '1' })) as Promise<any>;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: demo, encoding: 'utf8' }).trim();

  const locals = git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').join('\n');
  const byBranch = await get('prBranches', { names: locals });
  assert.deepEqual(Object.fromEntries(Object.entries(byBranch).map(([b, p]: [string, any]) => [b, p.number])), {
    'feature/parser': 12, 'feature/parser-errors': 13, 'feature/pretty-errors': 14,
  });

  let s = await get('prStack', { branch: 'feature/parser-errors' });
  assert.equal(s.trunk, 'main');
  assert.deepEqual(s.entries.map((e: any) => [e.pr.number, e.current, e.ahead, e.behind, e.restack]), [
    [14, false, 1, 0, false], [13, true, 2, 0, false], [12, false, 2, 0, false],
  ]);
  assert.equal(s.restack, null);

  // The parent gets a commit: this branch needs restacking, with only its own two commits.
  git('switch', '-q', 'feature/parser');
  git('commit', '-q', '--allow-empty', '-m', 'More parser');
  git('switch', '-q', 'feature/parser-errors');
  s = await get('prStack', { branch: 'feature/parser-errors' });
  assert.deepEqual(s.entries.map((e: any) => e.restack), [false, true, false]);
  assert.equal(s.restack.why, 'moved');
  assert.equal(s.restack.onto, 'feature/parser');
  assert.deepEqual(s.restack.shas, git('rev-list', '--reverse', 'feature/parser-errors', '^origin/feature/parser').split('\n'));

  // The parent is squash-merged: rebase onto main without its commits, and point #13 at main.
  git('switch', '-q', 'main');
  git('merge', '-q', '--squash', 'origin/feature/parser');
  git('commit', '-q', '-m', 'Add a parser for widget specs (#12)');
  git('push', '-q', 'origin', 'main');
  git('switch', '-q', 'feature/parser-errors');
  db.pulls.find((p: any) => p.number === 12).state = 'MERGED';
  s = await get('prStack', { branch: 'feature/parser-errors' });
  assert.equal(s.restack.why, 'merged');
  assert.equal(s.restack.onto, 'origin/main');
  assert.equal(s.restack.retarget, 'main');
  assert.equal(s.restack.shas.length, 2);
  const moved = (await githubRoute(repo, 'POST', 'prRetarget', { number: 13, base: 'main' })) as any;
  assert.equal(moved.base, 'main');
  assert.equal(db.pulls.find((p: any) => p.number === 13).baseRefName, 'main');

  // A branch without a pull request: stacked on nothing, its one commit as the draft.
  git('switch', '-q', 'feature/cache');
  const info = (await get('prCreateInfo', { branch: 'feature/cache' })) as any;
  assert.equal(info.base, 'main');
  assert.equal(info.suggested, null);
  assert.deepEqual(info.commits, [{ subject: 'Cache built specs by file hash', body: '' }]);
  const cache = { title: 'Cache', body: '', base: 'main', head: 'feature/cache', draft: false };
  await assert.rejects(githubRoute(repo, 'POST', 'prCreate', cache), /push it first/);
  git('push', '-q', '-u', 'origin', 'feature/cache');
  const number = db.nextNumber;
  const made = (await githubRoute(repo, 'POST', 'prCreate', { title: 'Cache', body: 'b', base: 'main', head: 'feature/cache', draft: true })) as any;
  assert.deepEqual([made.number, made.state, made.base, made.head], [number, 'draft', 'main', 'feature/cache']);
  assert.equal((await get('prBranches', { names: 'feature/cache' }))['feature/cache'].number, number);

  // A branch started from one with an open pull request is offered to stack on it.
  git('switch', '-q', '-c', 'feature/more-errors', 'feature/pretty-errors');
  const stacked = (await get('prCreateInfo', { branch: 'feature/more-errors' })) as any;
  assert.deepEqual(stacked.suggested, { base: 'feature/pretty-errors', number: 14 });
  assert.equal(stacked.bases[0], 'main');
  assert.equal(stacked.base, 'feature/pretty-errors');
});

test("the branch list's pull requests: every branch shown, however many, and a name forks share", async () => {
  process.env.LEGIT_GITHUB_MOCK = '1';
  const demo = join(dir, 'many');
  execFileSync('node', ['scripts/gh-demo.ts', demo], { stdio: 'ignore' });
  const { Repo } = await import('../src/server/repo.ts');
  await import('../src/server/gh/mock/index.ts');
  const { db } = await import('../src/server/gh/mock/registry.ts');
  const { githubRoute } = await import('../src/server/gh/routes.ts');
  const repo = await Repo.open(demo);
  const get = (name: string, names: string[]) => githubRoute(repo, 'GET', name, new URLSearchParams({ names: names.join('\n'), fresh: '1' })) as Promise<any>;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: demo, encoding: 'utf8' }).trim();
  const user = { login: 'octocat', avatarUrl: '' };
  const pull = (number: number, head: string, more: object = {}) =>
    db.pulls.push({ number, title: head, state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: head, headRefOid: '0'.repeat(40), author: user, ...more });

  const names = Array.from({ length: 70 }, (_, i) => `many/${i}`);
  names.forEach((b, i) => {
    git('branch', b, 'main');
    git('update-ref', `refs/remotes/origin/${b}`, 'main');
    pull(1000 + i, b);
  });
  // Forks' newer pull requests from a branch of the same name.
  git('branch', 'patch-1', 'main');
  pull(2000, 'patch-1');
  for (let i = 0; i < 12; i++) pull(2001 + i, 'patch-1', { headRepositoryOwner: { login: `fork${i}` } });

  const local = await get('prBranches', [...names, 'patch-1']);
  assert.deepEqual(names.map((b) => local[b]?.number), names.map((_, i) => 1000 + i));
  assert.equal(local['patch-1'].number, 2000);
  const remote = await get('prRemoteBranches', names.map((b) => `origin/${b}`));
  assert.equal(Object.keys(remote).length, 70);
  assert.equal(remote['origin/many/69'].number, 1069);
});
