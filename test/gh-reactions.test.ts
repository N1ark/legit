import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REACTIONS, gridStep } from '../src/ui/lib/gh-reactions.ts';

test('the reaction picker walks its 4×2 grid with the arrows, wrapping around', () => {
  const step = (i: number, key: string) => gridStep(i, key, 4, REACTIONS.length);
  assert.equal(REACTIONS.length, 8);
  assert.deepEqual([step(0, 'ArrowRight'), step(3, 'ArrowRight'), step(7, 'ArrowRight'), step(0, 'ArrowLeft')], [1, 4, 0, 7]);
  assert.deepEqual([step(1, 'ArrowDown'), step(5, 'ArrowDown'), step(2, 'ArrowUp'), step(6, 'ArrowUp')], [5, 1, 6, 2]);
  assert.deepEqual([step(5, 'Home'), step(2, 'End'), step(2, 'Enter')], [0, 7, null]);
  assert.equal(gridStep(1, 'ArrowDown', 4, 6), 5);
  assert.equal(gridStep(3, 'ArrowDown', 4, 6), 5, 'a short last row takes its last cell');
});
