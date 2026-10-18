import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Picks, pick, startCursor } from '../src/ui/lib/picker.ts';

type Row = { name: string; score?: number; current?: boolean };
const at = (rows: Row[], fallback?: number) => rows[startCursor(rows, (r) => !r.current, fallback)].name;

test('picker: the cursor starts on the best match, across groups, before any action', () => {
  const worktrees = [{ name: 'feature', score: 3000 }];
  const recent = [{ name: 'legit', score: 4500 }, { name: 'purr', score: 3500 }];
  assert.equal(at([...worktrees, { name: 'new' }, ...recent, { name: 'open' }]), 'legit');
  assert.equal(at([{ name: 'new' }, { name: 'purr', score: 3500 }, { name: 'open' }]), 'purr');
});

test('picker: on a tie, a row that opens something, then the earlier', () => {
  assert.equal(at([{ name: 'here', score: 5000, current: true }, { name: 'a', score: 5000 }, { name: 'b', score: 5000 }]), 'a');
  assert.equal(at([{ name: 'here', score: 5000, current: true }, { name: 'a', score: 4000 }]), 'here');
});

test('picker: with nothing matching, the fallback row', () => {
  const actions = [{ name: 'new' }, { name: 'open' }];
  assert.equal(at(actions), 'new');
  assert.equal(at(actions, 1), 'open');
  assert.equal(at(actions, 9), 'open');
  assert.equal(startCursor([]), 0);
});

test('picker: ⇧-click picks from the last ⌘-clicked row and keeps the others, as in Finder', () => {
  const rows = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
  const clicks = (list: [string, boolean][]) => list.reduce((s, [name, range]) => pick(s, rows, name, range), { chosen: [], anchor: null, base: [] } as Picks);
  assert.deepEqual(clicks([['b1', false], ['b3', false], ['b5', true]]).chosen, ['b1', 'b3', 'b4', 'b5']);
  // Another ⇧-click changes only the range, from the same anchor.
  assert.deepEqual(clicks([['b1', false], ['b3', false], ['b5', true], ['b2', true]]).chosen, ['b1', 'b2', 'b3']);
  // ⌘ after ⇧ adds to it, and anchors the next range there.
  assert.deepEqual(clicks([['b1', false], ['b3', false], ['b5', true], ['b6', false]]).chosen, ['b1', 'b3', 'b4', 'b5', 'b6']);
  assert.deepEqual(clicks([['b1', false], ['b3', false], ['b5', true], ['b4', false], ['b6', true]]).chosen, ['b1', 'b3', 'b4', 'b5', 'b6']);
  // ⌘ removes, and anchors there: the range starts from it.
  assert.deepEqual(clicks([['b1', false], ['b3', false], ['b3', false], ['b5', true]]).chosen, ['b1', 'b3', 'b4', 'b5']);
  // Without an anchor, ⇧ picks the one row.
  assert.deepEqual(clicks([['b4', true]]).chosen, ['b4']);
});

test('picker: a ⇧-click after the picks were cleared starts afresh from the anchor', () => {
  const rows = ['b1', 'b2', 'b3', 'b4'];
  let s = pick(pick({ chosen: [], anchor: null, base: [] }, rows, 'b1', false), rows, 'b2', false);
  s = { ...s, chosen: [] };
  assert.deepEqual(pick(s, rows, 'b4', true).chosen, ['b2', 'b3', 'b4']);
  // Picks filtered out of the list stay picked.
  assert.deepEqual(pick({ chosen: ['x', 'b1'], anchor: 'b1', base: ['x', 'b1'] }, rows, 'b3', true).chosen, ['x', 'b1', 'b2', 'b3']);
  // An anchor filtered out of the list: the click only toggles.
  assert.deepEqual(pick({ chosen: ['x'], anchor: 'x', base: ['x'] }, rows, 'b3', true).chosen, ['x', 'b3']);
});
