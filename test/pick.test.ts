import assert from 'node:assert/strict';
import { test } from 'node:test';
import { branchCommits, cherryPick, copyTo } from '../src/server/pick.ts';
import { Repo } from '../src/server/repo.ts';
import { abortOp, continueOp, markResolved } from '../src/server/sync.ts';
import { setup } from './util.ts';

const t = setup();
const { git, commit, write, read } = t;
const log = (rev = 'HEAD') => git('log', '--format=%s', rev).split('\n');

/** main: base, then `feature` (two commits) and `topic` (one) branched from it; on topic. */
function branches() {
  commit('base', { f: '1\n2\n3\n' });
  git('checkout', '-q', '-b', 'feature');
  const a = commit('add a', { a: 'a\n' });
  const b = commit('add b', { b: 'b\n' });
  git('checkout', '-q', '-b', 'topic', 'main');
  const c = commit('add c', { c: 'c\n' });
  return { a, b, c };
}

test('copy commits to another branch without checking it out, and undo it', async () => {
  const { a, c } = branches();
  write('wip', 'untracked\n');
  write('f', '1\n2\n3\nmine\n');
  const repo = await Repo.open(t.dir);
  const head = git('rev-parse', 'HEAD');
  const feature = git('rev-parse', 'feature');

  const r = await copyTo(repo, { shas: [c], branch: 'feature' });
  assert.match(r.message, /Copied 1 commit to feature/);
  assert.deepEqual(log('feature'), ['add c', 'add b', 'add a', 'base']);
  assert.equal(git('show', 'feature:c'), 'c');
  assert.equal(git('log', '-1', '--format=%an %ae', 'feature'), 'Ann ann@x.org');
  // The current branch, its files and changes stay as they were.
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(read('f'), '1\n2\n3\nmine\n');
  assert.ok(r.state.canUndo);

  await repo.undo();
  assert.equal(git('rev-parse', 'feature'), feature);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.ok((await repo.state()).canRedo);
  await repo.redo();
  assert.deepEqual(log('feature'), ['add c', 'add b', 'add a', 'base']);

  // Already there, the current branch, merges and unknown commits are refused.
  await assert.rejects(copyTo(repo, { shas: [a], branch: 'feature' }), /already on feature/);
  await assert.rejects(copyTo(repo, { shas: [c], branch: 'topic' }), /You're on topic/);
  await assert.rejects(copyTo(repo, { shas: ['1234567'], branch: 'feature' }), /don't exist/);
  await assert.rejects(copyTo(repo, { shas: [c], branch: 'nope' }), /No local branch named nope/);
});

test('copying refuses on a conflict, changing nothing', async () => {
  commit('base', { f: '1\n2\n3\n' });
  git('checkout', '-q', '-b', 'other');
  commit('theirs', { f: '1\ntheirs\n3\n' });
  git('checkout', '-q', 'main');
  const mine = commit('mine', { f: '1\nmine\n3\n' });
  const other = git('rev-parse', 'other');
  const repo = await Repo.open(t.dir);
  await assert.rejects(copyTo(repo, { shas: [mine], branch: 'other' }), /would conflict\. .* "mine" conflicts in f\..*Switch to other/s);
  assert.equal(git('rev-parse', 'other'), other);
});

test("another branch's commits, and cherry-picking them onto this one in memory, oldest first", async () => {
  const { a, b } = branches();
  write('f', '1\n2\n3\nwip\n');
  const repo = await Repo.open(t.dir);
  const listed = await branchCommits(repo, 'feature');
  assert.deepEqual(listed.commits.map((x) => x.subject), ['add b', 'add a']);
  assert.equal(listed.total, 2);

  const head = git('rev-parse', 'HEAD');
  const r = await cherryPick(repo, { shas: [b, a] });
  assert.match(r.message, /Cherry-picked 2 commits onto topic/);
  assert.deepEqual(log(), ['add b', 'add a', 'add c', 'base']);
  assert.equal(read('a'), 'a\n');
  assert.equal(read('f'), '1\n2\n3\nwip\n');
  assert.deepEqual(r.focus, [git('rev-parse', 'HEAD')]);
  assert.deepEqual((await branchCommits(repo, 'feature')).commits.length, 2);

  git('checkout', '-q', '--', 'f');
  await repo.undo();
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(t.exists('a'), false);
});

test('a conflicting cherry-pick stops for the conflict view, continues, and undoes in one step', async () => {
  commit('base', { f: '1\n2\n3\n' });
  git('checkout', '-q', '-b', 'other');
  const x = commit('theirs', { f: '1\ntheirs\n3\n' });
  const y = commit('more', { g: 'g\n' });
  git('checkout', '-q', 'main');
  const head = commit('mine', { f: '1\nmine\n3\n' });
  const repo = await Repo.open(t.dir);

  // Uncommitted changes would make an abort unsafe: refused.
  write('f', 'dirty\n');
  await assert.rejects(cherryPick(repo, { shas: [x, y] }), /"theirs" conflicts in f\. .*without uncommitted changes.*Nothing was changed/s);
  assert.equal(git('rev-parse', 'HEAD'), head);
  git('checkout', '-q', '--', 'f');

  let r = await cherryPick(repo, { shas: [x, y] });
  assert.match(r.message, /stopped with conflicts in 1 file/);
  assert.equal(r.state.conflict?.kind, 'cherry-pick');
  write('f', '1\nboth\n3\n');
  await markResolved(repo, { path: 'f' });
  r = await continueOp(repo);
  assert.equal(r.state.conflict, null);
  assert.deepEqual(log(), ['more', 'theirs', 'mine', 'base']);
  assert.equal(read('f'), '1\nboth\n3\n');
  await repo.undo();
  assert.equal(git('rev-parse', 'HEAD'), head);

  // Aborting puts everything back.
  r = await cherryPick(repo, { shas: [x] });
  assert.equal(r.state.conflict?.kind, 'cherry-pick');
  await abortOp(repo);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(read('f'), '1\nmine\n3\n');
});
