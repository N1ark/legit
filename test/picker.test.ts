import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startCursor } from '../src/ui/lib/picker.ts';

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
