import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Repo } from '../src/server/repo.ts';
import { abortOp, continueOp, markResolved, rebuildBranch, rebuildPlan } from '../src/server/sync.ts';
import { setup } from './util.ts';

const t = setup();
const { git, commit, write, read } = t;
const log = (rev = 'HEAD') => git('log', '--format=%s', rev).split('\n');

/** main: base, then `fix`; feature, from base: five commits, one of them `fix` again; on feature. */
function branches() {
  commit('base', { f: '1\n2\n3\n' });
  git('checkout', '-q', '-b', 'feature');
  const a = commit('add a', { a: 'a\n' });
  const wip = commit('wip', { w: 'w\n' });
  const fix = commit('fix', { g: 'fixed\n' });
  const b = commit('add b', { b: 'b\n' });
  const logs = commit('logs', { a: 'a\nlog\n' });
  git('checkout', '-q', 'main');
  commit('fix', { g: 'fixed\n' });
  commit('main', { m: 'm\n' });
  git('checkout', '-q', 'feature');
  return { a, wip, fix, b, logs };
}

test('rebuild a branch on another from some of its commits, in memory, and undo it', async () => {
  const { a, wip, fix, b } = branches();
  write('f', '1\n2\n3\nmine\n');
  const repo = await Repo.open(t.dir);
  const head = git('rev-parse', 'HEAD');

  assert.deepEqual(await rebuildPlan(repo, { shas: [b, fix, a], branch: 'main' }), {
    base: 'main', kept: 3, there: 0, dropped: 2, unchanged: false,
  });
  const r = await rebuildBranch(repo, { shas: [b, fix, a], branch: 'main' });
  assert.match(r.message, /Rebuilt feature on main with 2 commits; 2 other commits dropped \(1 picked commit already there was left out\)/);
  assert.deepEqual(log(), ['add b', 'add a', 'main', 'fix', 'base']);
  assert.equal(git('rev-parse', 'HEAD~2'), git('rev-parse', 'main'));
  assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'feature');
  assert.equal(r.renamed[a], git('rev-parse', 'HEAD~1'));
  assert.deepEqual(r.focus, [git('rev-parse', 'HEAD')]);
  assert.equal(read('f'), '1\n2\n3\nmine\n');
  assert.ok(!t.exists('w'));
  assert.ok((await repo.backups()).some((x) => x.label === 'rebuild' && x.sha === head));

  // Rebuilding again with every commit changes nothing.
  const kept = [git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD~1')];
  assert.equal((await rebuildPlan(repo, { shas: kept, branch: 'main' })).unchanged, true);
  assert.match((await rebuildBranch(repo, { shas: kept, branch: 'main' })).message, /already is main plus those commits/);

  git('checkout', '-q', '--', 'f');
  await repo.undo();
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(read('w'), 'w\n');

  // Merges, commits not on the branch, only commits already there, and the branch itself are refused.
  await assert.rejects(rebuildBranch(repo, { shas: [git('rev-parse', 'main~2')], branch: 'main' }), /already on main.*Nothing was changed/);
  git('checkout', '-q', '-b', 'side', 'main');
  const side = commit('side', { s: '1\n' });
  git('checkout', '-q', 'feature');
  await assert.rejects(rebuildBranch(repo, { shas: [side, wip], branch: 'main' }), /isn't on feature/);
  await assert.rejects(rebuildBranch(repo, { shas: [a], branch: 'feature' }), /another branch than feature/);
  git('merge', '-q', '--no-edit', 'side');
  const merge = git('rev-parse', 'HEAD');
  await assert.rejects(rebuildBranch(repo, { shas: [a, merge], branch: 'main' }), /is a merge.*Nothing was changed/);
  assert.equal(git('rev-parse', 'HEAD'), merge);
});

/** main changes f and g; feature: a commit that conflicts, a clean one, one to drop, one main has too, another conflicting one. */
function conflicting() {
  commit('base', { f: '1\n', g: '1\n' });
  git('checkout', '-q', '-b', 'feature');
  const mine = commit('mine', { f: 'mine\n' });
  const clean = commit('clean', { h: 'h\n' });
  commit('drop me', { d: 'd\n' });
  const same = commit('same', { s: 's\n' });
  const too = commit('mine too', { g: 'mine\n' });
  git('checkout', '-q', 'main');
  commit('same', { s: 's\n' });
  commit('theirs', { f: 'theirs\n', g: 'theirs\n' });
  git('checkout', '-q', 'feature');
  return [mine, clean, same, too];
}

test('a conflicting rebuild stops at each conflict, continues, and undoes in one step', async () => {
  const picks = conflicting();
  const head = git('rev-parse', 'HEAD');
  const repo = await Repo.open(t.dir);

  write('h', 'dirty\n');
  await assert.rejects(rebuildBranch(repo, { shas: picks, branch: 'main' }), /Rebuilding feature on main conflicts\. .* "mine" conflicts in f\..*Nothing was changed/s);
  assert.equal(git('rev-parse', 'HEAD'), head);
  git('checkout', '-q', '--', 'h');

  let r = await rebuildBranch(repo, { shas: picks, branch: 'main' });
  assert.match(r.message, /Rebuilding feature on main stopped with conflicts in 1 file/);
  assert.equal(r.state.conflict?.kind, 'rebase');
  assert.deepEqual(r.state.conflict?.files.map((f) => f.path), ['f']);
  write('f', 'both\n');
  await markResolved(repo, { path: 'f' });
  r = await continueOp(repo);
  assert.deepEqual(r.state.conflict?.files.map((f) => f.path), ['g']);
  write('g', 'both\n');
  await markResolved(repo, { path: 'g' });
  r = await continueOp(repo);
  assert.equal(r.state.conflict, null);
  assert.equal(r.state.branch, 'feature');
  assert.deepEqual(log(), ['mine too', 'clean', 'mine', 'theirs', 'same', 'base']);
  assert.ok(!t.exists('d'));
  assert.ok((await repo.backups()).some((x) => x.label === 'rebuild' && x.sha === head));
  await repo.undo();
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(read('d'), 'd\n');
});

test('aborting a conflicting rebuild puts everything back', async () => {
  const picks = conflicting();
  const head = git('rev-parse', 'HEAD');
  const repo = await Repo.open(t.dir);
  const r = await rebuildBranch(repo, { shas: picks.slice(0, 1), branch: 'main' });
  assert.equal(r.state.conflict?.kind, 'rebase');
  await abortOp(repo);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'feature');
  assert.equal(git('status', '--porcelain'), '');
  assert.deepEqual(log(), ['mine too', 'same', 'drop me', 'clean', 'mine', 'base']);
});
