import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setup } from './util.ts';

// Before anything reads it (client.ts, through repo.ts).
process.env.LEGIT_GITHUB_MOCK = '1';
const { Repo } = await import('../src/server/repo.ts');
const t = setup();
const paths = (d: { files: { path: string }[] }) => d.files.map((f) => f.path).sort();

test('the diff between two commits, and between two versions only in the files either changes against its base', async () => {
  t.remote();
  const first = t.commit('base', { f: '1\n' });
  t.git('push', '-q', '-u', 'origin', 'main');
  t.git('switch', '-q', '-c', 'feature');
  const b1 = t.commit('one', { a: 'a\n' });
  t.git('switch', '-q', 'main');
  const base = t.commit('on main', { m: 'm\n' });
  t.git('switch', '-q', '-c', 'rebased');
  const b2 = t.commit('one again', { a: 'a\n', b: 'b\n' });
  const repo = await Repo.open(t.dir);
  assert.deepEqual(paths(await repo.diff(`r${b2}-${b1}`)), ['b', 'm']);
  assert.deepEqual(paths(await repo.diff(`r${b2}-${b1}-${base}-${first}`)), ['b']);
  assert.deepEqual(paths(await repo.diff(`r${b1}-${b1}-${first}-${first}`)), []);
});

// Against the fake GitHub, on the demo repo (scripts/gh-demo.ts).
const dir = mkdtempSync(join(tmpdir(), 'legit-prdiff-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('a pull request is read without checking it out: fetched into hidden refs, its changes, its versions, its commits', async () => {
  const demo = join(dir, 'demo');
  execFileSync('node', ['scripts/gh-demo.ts', demo], { stdio: 'ignore' });
  await import('../src/server/gh/mock/index.ts');
  const { githubRoute } = await import('../src/server/gh/routes.ts');
  const repo = await Repo.open(demo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: demo, encoding: 'utf8' }).trim();
  const get = (name: string, q: Record<string, string>) => githubRoute(repo, 'GET', name, new URLSearchParams(q)) as Promise<any>;
  const post = (name: string, b: object) => githubRoute(repo, 'POST', name, b) as Promise<any>;
  // The demo made #18's commits here: gone, as they would be.
  git('reflog', 'expire', '--expire=now', '--all');
  git('gc', '-q', '--prune=now');
  const refs = () => git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags');
  const before = { refs: refs(), head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain'), index: git('write-tree') };
  const branches = JSON.stringify(await repo.branches());

  const pr = await get('prview', { number: '18' });
  assert.equal(pr.myReview?.sha, git('ls-remote', 'origin', 'refs/demo/18/reviewed').split('\t')[0]);
  const got = await post('prFetch', { number: 18, head: pr.headSha, base: pr.base });
  assert.equal(got.head, pr.headSha);
  assert.equal(got.offline, null);
  assert.equal(git('rev-parse', 'refs/worktree/legit/pull/18/head'), pr.headSha);
  assert.equal(git('rev-parse', 'refs/worktree/legit/pull/18/base'), git('rev-parse', 'origin/main'));
  assert.equal(got.mergeBase, git('rev-parse', 'origin/main'));
  // Nothing else moved, and nothing lists the hidden refs.
  assert.deepEqual({ refs: refs(), head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain'), index: git('write-tree') }, before);
  assert.equal(existsSync(join(demo, '.git', 'FETCH_HEAD')), false);
  assert.equal(JSON.stringify(await repo.branches()), branches);
  assert.deepEqual(await repo.backups(), []);

  assert.deepEqual(paths(await repo.diff(`r${got.head}-${got.mergeBase}`)), ['README.md', 'src/cli.ts', 'src/watch.ts']);
  const commits = await get('prCommits', { number: '18', head: pr.headSha });
  assert.deepEqual(commits.map((c: any) => c.headline), ['Add a file watcher for specs', 'Add --watch to the CLI', 'Mention --watch in the README']);

  // Since the review: it was on the first version, which isn't in the rebased one's history.
  const since = await post('prCompare', { number: 18, from: pr.myReview.sha, to: pr.headSha });
  assert.equal(since.rebased, true);
  assert.deepEqual(paths(await repo.diff(since.key)), ['README.md', 'src/cli.ts', 'src/watch.ts']);
  // The force-push's old tip, which only GitHub has, by its SHA.
  const push = pr.timeline.find((i: any) => i.type === 'force-pushed').pushed;
  const old = await get('prCommit', { number: '18', sha: push.from });
  assert.equal(old.subject, 'Mention --watch in the README');
  assert.equal(git('rev-parse', `refs/worktree/legit/pull/18/${push.from}`), push.from);
  const forced = await post('prCompare', { number: 18, from: push.from, to: push.to });
  assert.equal(forced.rebased, true);
  // A push of commits: from its first commit's parent.
  const pushed = await post('prCompare', { number: 18, from: `${commits[1].sha}^`, to: commits[2].sha });
  assert.deepEqual([pushed.rebased, pushed.commits], [false, [commits[2].sha, commits[1].sha]]);
  assert.deepEqual(paths(await repo.diff(pushed.key)), ['README.md', 'src/cli.ts']);
  await assert.rejects(post('prCompare', { number: 13, from: 'a71c0de'.padEnd(40, '9'), to: pr.headSha }), /Couldn't get a71c0de from GitHub/);

  // The current branch's pull request, whose head is here already.
  const own = await get('prview', { number: '13' });
  const ownGot = await post('prFetch', { number: 13, head: own.headSha, base: own.base });
  assert.equal(ownGot.mergeBase, git('rev-parse', 'feature/parser'));
  assert.deepEqual(paths(await repo.diff(`r${ownGot.head}-${ownGot.mergeBase}`)), ['src/errors.ts', 'src/parser.ts']);
  assert.deepEqual(refs(), before.refs);
});

test("a pull request's hidden refs go once nothing shows it, and any left go as the server starts", async () => {
  const demo = join(dir, 'demo2');
  execFileSync('node', ['scripts/gh-demo.ts', demo], { stdio: 'ignore' });
  await import('../src/server/gh/mock/index.ts');
  const { githubRoute } = await import('../src/server/gh/routes.ts');
  const { sweepPrRefs } = await import('../src/server/gh/prdiff.ts');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: demo, encoding: 'utf8' }).trim();
  const hidden = () => git('for-each-ref', '--format=%(refname)', 'refs/worktree/legit/pull/');
  // Left over from a server that stopped while showing #14.
  git('update-ref', 'refs/worktree/legit/pull/14/head', 'HEAD');
  const repo = await Repo.open(demo);
  await sweepPrRefs(repo);
  assert.equal(hidden(), '');
  const get = (name: string, q: Record<string, string>) => githubRoute(repo, 'GET', name, new URLSearchParams(q)) as Promise<any>;
  const post = (name: string, b: object) => githubRoute(repo, 'POST', name, b) as Promise<any>;
  const pr = await get('prview', { number: '18' });
  // Two pages show #18: its refs stay until both have left it.
  await post('prFetch', { number: 18, head: pr.headSha, base: pr.base, hold: true });
  await post('prFetch', { number: 18, head: pr.headSha, base: pr.base, hold: true });
  assert.deepEqual(hidden().split('\n'), ['refs/worktree/legit/pull/18/base', 'refs/worktree/legit/pull/18/head']);
  await post('prRelease', { number: 18 });
  assert.notEqual(hidden(), '');
  await post('prRelease', { number: 18 });
  assert.equal(hidden(), '');
  // Its commits are still here for a diff still open; showing it again fetches it again.
  assert.equal(git('cat-file', '-t', pr.headSha), 'commit');
  const again = await post('prFetch', { number: 18, head: pr.headSha, base: pr.base, hold: true });
  assert.equal(git('rev-parse', 'refs/worktree/legit/pull/18/head'), again.head);
  await post('prRelease', { number: 18 });
  // Checking one out from the list (nothing showing it) keeps no ref.
  const plan = await post('prCheckoutPlan', { number: 16 });
  assert.equal(git('cat-file', '-t', plan.sha), 'commit');
  assert.equal(hidden(), '');
});

test("each worktree keeps its own pull request refs: one's cleaning up leaves another's", async () => {
  const demo = join(dir, 'demo3');
  execFileSync('node', ['scripts/gh-demo.ts', demo], { stdio: 'ignore' });
  const { dropPrRefs } = await import('../src/server/gh/prdiff.ts');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const other = join(dir, 'demo3-wt');
  git(demo, 'worktree', 'add', '-q', '--detach', other);
  git(demo, 'update-ref', 'refs/worktree/legit/pull/12/head', 'HEAD');
  git(other, 'update-ref', 'refs/worktree/legit/pull/12/head', 'HEAD');
  await dropPrRefs(await Repo.open(other));
  assert.equal(git(other, 'for-each-ref', 'refs/worktree/legit/pull/'), '');
  assert.match(git(demo, 'for-each-ref', '--format=%(refname)', 'refs/worktree/legit/pull/'), /^refs\/worktree\/legit\/pull\/12\/head$/);
});
