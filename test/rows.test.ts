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

test('expanded gaps carry over to another version of the diff by old line', async () => {
  const { expansionOf, gapsOf, shownRanges } = await import('../src/ui/lib/rows.ts');
  const file = { lines: Array.from({ length: 100 }, (_, k) => `l${k + 1}`), noNewline: false };
  const hunk = (at: number, types = '   +   '): HunkData => ({ header: '@@', oldStart: at, newStart: at, types, text: types.split(''), eof: [] });
  const a = gapsOf([hunk(20), hunk(60)], file);
  // 5 lines down from the top of the file, 3 up into the second hunk, all of the end.
  const ranges = shownRanges(a, { file, top: [5, 0, 35], bottom: [0, 3] });
  assert.deepEqual(ranges, [[1, 5], [57, 59], [66, 100]]);
  // A hunk added between them: its gaps open where the ranges touch them.
  const b = gapsOf([hunk(20), hunk(40), hunk(60)], file);
  const x = expansionOf(b, ranges, file);
  assert.deepEqual([x.top, x.bottom], [[5, , , 35], [, , 3]]);
  // A range covering a whole gap shows all of it, from the top.
  assert.deepEqual(expansionOf(gapsOf([hunk(20)], file), [[1, 19]], file).top, [19]);
});

test('a row is found again in another version by its old line, edits above it or not', async () => {
  const { rowOfPlace, rowPlace } = await import('../src/ui/lib/rows.ts');
  const h = (oldStart: number, types: string): HunkData => ({ header: '@@', oldStart, newStart: oldStart, types, text: types.split(''), eof: [] });
  const before = buildRows([h(10, '  ++  ')]);
  // Row 4 is the second added line: two rows below old line 11.
  const p = rowPlace(before, 4, 0.5);
  assert.deepEqual(p, { old: 11, after: 2, line: 13, frac: 0.5 });
  // Lines added above it in the file: new numbers move, old ones don't.
  const after = buildRows([h(2, '+++'), h(10, '  ++  ')].map((x, k) => (k ? { ...x, newStart: 13 } : x)));
  assert.deepEqual(rowOfPlace(after, p), { r: 8, frac: 0.5 });
});
