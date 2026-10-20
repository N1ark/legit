import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HunkData } from '../src/shared/types.ts';
import { type FileRows, buildRows, isHead, rowMap } from '../src/ui/lib/rows.ts';

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
