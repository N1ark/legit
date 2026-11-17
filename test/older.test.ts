import assert from 'node:assert/strict';
import { test } from 'node:test';
import { carryOlder } from '../src/ui/lib/older.ts';
import type { CommitInfo } from '../src/shared/types.ts';

const c = (sha: string, editable = false, pushed = false): CommitInfo => ({
  sha, subject: sha, body: '', coauthors: [], author: { name: 'A', email: 'a@x', time: 0 }, pushed, editable, merge: false,
});

test('older history follows the end of the list when a commit on top moves it', () => {
  const base = [c('e', true), c('d', true), c('c', true)];
  const older = { from: 'c', commits: [c('b'), c('a')], more: true };
  const carried = carryOlder(base, older, [c('f', true), c('e', true), c('d', true)]);
  assert.deepEqual(carried, { from: 'd', commits: [c('c'), c('b'), c('a')], more: true });
});

test('older history follows the end of the list when a commit is dropped', () => {
  const base = [c('e', true), c('d', true), c('c', true)];
  const older = { from: 'c', commits: [c('b'), c('a')], more: false };
  assert.deepEqual(carryOlder(base, older, [c('e2', true), c('c', true), c('b', true)]), { from: 'b', commits: [c('a')], more: false });
});

test('what is under a pushed commit is pushed', () => {
  const base = [c('c', true), c('b', true)];
  const older = { from: 'b', commits: [c('a')], more: false };
  assert.deepEqual(carryOlder(base, older, [c('d', true, true), c('c', true, true)]), { from: 'c', commits: [c('b', false, true), c('a', false, true)], more: false });
});

test('older history is left as it is when the list ends where it did, or nowhere along it', () => {
  const base = [c('c', true), c('b', true)];
  const older = { from: 'b', commits: [c('a')], more: false };
  assert.equal(carryOlder(base, older, [c('c2', true), c('b', true)]), null);
  assert.equal(carryOlder(base, older, [c('x', true), c('y', true)]), null);
  assert.equal(carryOlder(base, null, [c('c', true)]), null);
  assert.equal(carryOlder([c('z')], older, [c('c', true)]), null);
});
