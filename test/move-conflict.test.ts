import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Repo } from '../src/server/repo.ts';
import { abortOp, continueOp, markResolved } from '../src/server/sync.ts';
import { setup } from './util.ts';

const t = setup();
const { git, commit, write, read } = t;
const log = () => git('log', '--format=%s').split('\n');
const backups = () => git('for-each-ref', '--format=%(refname)', 'refs/legit/backups').split('\n').filter(Boolean);

/** base, then a and b both changing f's one line, then c. */
function history() {
  commit('base', { f: '1\n' });
  const a = commit('a', { f: '2\n' });
  const b = commit('b', { f: '3\n' });
  const c = commit('c', { g: 'g\n' });
  return { a, b, c, base: git('rev-parse', 'HEAD~3') };
}

test('a reorder that conflicts stops in a rebase at the conflict; resolving and continuing finishes it', async () => {
  const { a, b, c, base } = history();
  const repo = await Repo.open(t.dir);
  await repo.reorder({ order: [c, a, b, base] });
  const state = await repo.state();
  assert.equal(state.conflict?.kind, 'rebase');
  assert.deepEqual(state.conflict?.files.map((f) => f.path), ['f']);
  assert.equal(git('rev-parse', backups()[0]), c);

  // b, then a on top of it, each conflict.
  write('f', '3\n');
  await markResolved(repo, { path: 'f' });
  await continueOp(repo);
  assert.equal((await repo.state()).conflict?.kind, 'rebase');
  write('f', '2\n');
  await markResolved(repo, { path: 'f' });
  await continueOp(repo);
  assert.equal((await repo.state()).conflict, null);
  assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main');
  assert.deepEqual(log(), ['c', 'a', 'b', 'base']);
  assert.equal(read('f'), '2\n');
  await repo.undo();
  assert.equal(git('rev-parse', 'HEAD'), c);
});

test('aborting a reorder that stopped at a conflict puts everything back', async () => {
  const { a, b, c, base } = history();
  const repo = await Repo.open(t.dir);
  await repo.reorder({ order: [c, a, b, base] });
  assert.equal((await repo.state()).conflict?.kind, 'rebase');
  await abortOp(repo);
  assert.equal(git('rev-parse', 'HEAD'), c);
  assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(read('f'), '3\n');
  assert.equal(git('status', '--porcelain'), '');
});

test('a reorder that conflicts with uncommitted changes refuses, changing nothing', async () => {
  const { a, b, c, base } = history();
  write('g', 'dirty\n');
  const repo = await Repo.open(t.dir);
  await assert.rejects(repo.reorder({ order: [c, a, b, base] }), /conflict in f needs a working tree without uncommitted changes.*Commit or stash/s);
  assert.equal(git('rev-parse', 'HEAD'), c);
  assert.equal(read('g'), 'dirty\n');
  assert.equal((await repo.state()).conflict, null);
});

test('a drop that conflicts stops at the conflict', async () => {
  const { a, c } = history();
  const repo = await Repo.open(t.dir);
  await repo.drop({ shas: [a] });
  assert.equal((await repo.state()).conflict?.kind, 'rebase');
  write('f', '3\n');
  await markResolved(repo, { path: 'f' });
  await continueOp(repo);
  assert.deepEqual(log(), ['c', 'b', 'base']);
  assert.equal(read('f'), '3\n');
  await repo.undo();
  assert.equal(git('rev-parse', 'HEAD'), c);
});

test('a squash that conflicts stops at the conflict, and keeps its message and author', async () => {
  commit('base', { f: '1\n' });
  const a = commit('a', { f: '2\n' });
  commit('mid', { f: '3\n' });
  commit('b', { f: '4\n', h: 'h\n' });
  git('commit', '--amend', '-q', '--no-edit', '--author', 'Bo <bo@x.org>');
  const repo = await Repo.open(t.dir);
  const top = git('rev-parse', 'HEAD');
  await repo.squash({ shas: [git('rev-parse', 'HEAD'), a], subject: 'a and b', body: 'both', coauthors: [] });
  assert.equal((await repo.state()).conflict?.kind, 'rebase');
  write('f', '4\n');
  await markResolved(repo, { path: 'f' });
  await continueOp(repo);
  // mid comes after the squash, and conflicts with it in turn.
  assert.equal((await repo.state()).conflict?.kind, 'rebase');
  write('f', '3\n');
  await markResolved(repo, { path: 'f' });
  await continueOp(repo);
  assert.equal((await repo.state()).conflict, null);
  assert.deepEqual(log(), ['mid', 'a and b', 'base']);
  assert.equal(git('log', '-1', '--format=%B', 'HEAD~1').trim(), 'a and b\n\nboth');
  assert.equal(git('log', '-1', '--format=%an', 'HEAD~1'), 'Ann');
  assert.equal(git('show', 'HEAD~1:h'), 'h');
  await repo.undo();
  assert.equal(git('rev-parse', 'HEAD'), top);
});
