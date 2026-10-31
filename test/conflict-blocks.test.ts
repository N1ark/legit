import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Repo } from '../src/server/repo.ts';
import { resolveBlock, unresolveBlock } from '../src/server/sync.ts';
import { setup } from './util.ts';

const t = setup();
const { git, commit } = t;

/** A merge of `feature` into main that conflicts in two places of f (diff3 markers: a base section too). */
async function conflicted() {
  git('init', '-q', '-b', 'main');
  git('config', 'merge.conflictStyle', 'diff3');
  commit('base', { f: 'a\nx\nb\nc\nd\ne\ny\nf\n' });
  git('switch', '-qc', 'feature');
  commit('theirs', { f: 'a\nTHEIRS1\nb\nc\nd\ne\nTHEIRS2\nf\n' });
  git('switch', '-q', 'main');
  commit('ours', { f: 'a\nOURS1\nb\nc\nd\ne\nOURS2\nf\n' });
  assert.throws(() => git('merge', '-q', 'feature'));
  const repo = await Repo.open(t.dir);
  const lines = t.read('f').split('\n');
  return { repo, at: (n: number) => lines.findIndex((l, k) => l.startsWith('<<<<<<<') && n-- === 0) + 1 };
}

test('keep one side of a conflict, then both of the last: the file is marked resolved', async () => {
  const { repo, at } = await conflicted();
  const second = at(1);
  let r = await resolveBlock(repo, { path: 'f', line: at(0), side: 'theirs', id: '1' });
  assert.match(r.message, /Kept feature's side in f\.$/);
  assert.equal(t.read('f').split('<<<<<<<')[0], 'a\nTHEIRS1\nb\nc\nd\ne\n');
  assert.equal(r.state.conflict?.files.length, 1);
  // Its line moved up: the old number no longer starts a conflict.
  await assert.rejects(resolveBlock(repo, { path: 'f', line: second, side: 'ours' }), /doesn't start a conflict any more/);
  const now = t.read('f').split('\n').findIndex((l) => l.startsWith('<<<<<<<')) + 1;
  r = await resolveBlock(repo, { path: 'f', line: now, side: 'both', id: '2' });
  assert.match(r.message, /Kept both sides in f; no conflicts are left in it, so it's marked resolved\./);
  assert.equal(t.read('f'), 'a\nTHEIRS1\nb\nc\nd\ne\nOURS2\nTHEIRS2\nf\n');
  assert.equal(r.state.conflict?.files.length, 0);
  assert.equal(git('ls-files', '-u'), '');

  // Undo: the file as it was, conflicted again.
  // Only the last choice: an older toast's Undo is refused.
  await assert.rejects(unresolveBlock(repo, { path: 'f', id: '1' }), /Only the last choice/);
  r = await unresolveBlock(repo, { path: 'f', id: '2' });
  assert.equal(r.state.conflict?.files.length, 1);
  assert.match(t.read('f'), /^a\nTHEIRS1\n(.|\n)*<<<<<<< HEAD\nOURS2\n\|\|\|\|\|\|\| [^\n]+\ny\n=======\nTHEIRS2\n>>>>>>> feature\nf\n$/);
  await assert.rejects(unresolveBlock(repo, { path: 'f', id: '2' }), /nothing to undo/);
  r = await resolveBlock(repo, { path: 'f', line: now, side: 'ours' });
  assert.equal(t.read('f'), 'a\nTHEIRS1\nb\nc\nd\ne\nOURS2\nf\n');
});

test('refused for a file that is not conflicted, or a path outside the repository', async () => {
  const { repo, at } = await conflicted();
  await assert.rejects(resolveBlock(repo, { path: 'g', line: 1, side: 'ours' }), /isn't conflicted/);
  await assert.rejects(resolveBlock(repo, { path: '../f', line: 1, side: 'ours' }), /isn't a path in the repository/);
  await assert.rejects(resolveBlock(repo, { path: 'f', line: at(0), side: 'neither' as never }), /Keep which side/);
});
