import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HunkData } from '../src/shared/types.ts';
import { type FileRows, buildRows, isHead, rowMap, rowsIn } from '../src/ui/lib/rows.ts';

const naive = (from: FileRows, to: FileRows) =>
  Array.from(from.kind, (k, r) =>
    isHead(k) ? -1 : to.kind.findIndex((t, s) => !isHead(t) && to.o[s] === from.o[r] && to.n[s] === from.n[r]),
  );

test('rowMap finds each line where it moved, whatever its line numbers', () => {
  for (const start of [1, 2_097_140, 5_000_000]) {
    const hunk = (oldStart: number): HunkData => ({
      header: '@@', oldStart, newStart: oldStart + 2, types: ' -+ +- ', text: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], eof: [],
    });
    const two = [hunk(start), hunk(start + 40)];
    const a = buildRows(two);
    const b = buildRows([two[1]]);
    const c = buildRows(two, false, undefined, true);
    for (const [x, y] of [[a, b], [b, a], [a, c], [c, a]]) assert.deepEqual([...rowMap(x, y)], naive(x, y));
  }
});

test('rowsIn finds the rows overlapping a window, by height', () => {
  // Rows of 1 to 4 units, some with a block of 7 under them.
  const tops = [0];
  for (let r = 0; r < 200; r++) tops.push(tops[r] + 1 + (r % 4) + (r % 13 === 5 ? 7 : 0));
  const y = (r: number) => tops[r];
  for (let top = -20; top < tops[200] + 20; top += 3) {
    for (const height of [0, 1, 10, 60]) {
      const a = top - 5;
      const b = top + height + 5;
      const inside = [...Array(200).keys()].filter((r) => tops[r + 1] > a && tops[r] < b);
      const [first, end] = rowsIn(200, y, a, b);
      assert.deepEqual([...Array(end - first).keys()].map((k) => first + k), inside, `${top} ${height}`);
    }
  }
  assert.deepEqual(rowsIn(0, y, 0, 100), [0, 0]);
});
