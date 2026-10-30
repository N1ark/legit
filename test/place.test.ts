import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HunkData } from '../src/shared/types.ts';
import { anchorAt, knotList, lineStarts, rowAnchor, rowOfAnchor, yOf } from '../src/ui/lib/place.ts';
import { buildRows, noExpansion } from '../src/ui/lib/rows.ts';

// A file's old line 5 replaced by new lines 5-6, and old line 20 removed: two hunks with context, lines hidden between.
const hunks: HunkData[] = [
  {
    header: '@@ -2,7 +2,8 @@',
    oldStart: 2,
    newStart: 2,
    types: '   -++   ',
    text: ['2', '3', '4', 'x', '5', '6', '7', '8', '9'],
    eof: [],
  },
  { header: '@@ -18,6 +19,5 @@', oldStart: 18, newStart: 19, types: '  -   ', text: ['19', '20', 'y', '21', '22', '23'], eof: [] },
];
const rows = buildRows(hunks, true);

test('a row shows its new line; a removed one or a header, the next line kept in its hunk', () => {
  assert.deepEqual(rowAnchor(rows, 1, 0.5), { line: 2.5 });
  // Row 4 removes old line 5: it sits before new line 5.
  assert.equal(rows.kind[4], 3);
  assert.deepEqual(rowAnchor(rows, 4, 0.5), { line: 5, old: 5.5 });
  assert.deepEqual(rowAnchor(rows, 0, 0.9), { line: 2 });
  const second = rows.kind.indexOf(0, 1);
  assert.deepEqual(rowAnchor(rows, second, 0), { line: 19 });
  // The row after the last hunk stands for the rest of the file.
  assert.equal(rows.kind[rows.kind.length - 1], 4);
  assert.deepEqual(rowAnchor(rows, rows.kind.length - 1, 0), { line: 24 });
  assert.deepEqual(rowAnchor(rows, rows.kind.length + 3, 0), { line: 24 });
});

test('a removed line at the end of a hunk sits after the last line kept', () => {
  const r = buildRows([{ header: '@@', oldStart: 1, newStart: 1, types: ' -', text: ['a', 'b'], eof: [] }]);
  assert.deepEqual(rowAnchor(r, 2, 0), { line: 2, old: 2 });
});

test("a deleted file's places are its old lines", () => {
  const r = buildRows([{ header: '@@ -1,3 +0,0 @@', oldStart: 1, newStart: 0, types: '---', text: ['a', 'b', 'c'], eof: [] }]);
  assert.deepEqual(rowAnchor(r, 2, 0.25, 'old'), { line: 2.25 });
  assert.deepEqual(rowOfAnchor(r, { line: 3.5 }, 'old'), { r: 3, frac: 0.5 });
});

test("a line's row, or for a hidden one the header of its gap, or the row after the last hunk", () => {
  assert.deepEqual(rowOfAnchor(rows, { line: 3.25 }), { r: 2, frac: 0.25 });
  // Line 1 is above the first hunk: its header.
  assert.deepEqual(rowOfAnchor(rows, { line: 1.5 }), { r: 0, frac: 0 });
  const second = rows.kind.indexOf(0, 1);
  assert.deepEqual(rowOfAnchor(rows, { line: 14 }), { r: second, frac: 0 });
  assert.deepEqual(rowOfAnchor(rows, { line: 40 }), { r: rows.kind.length - 1, frac: 0 });
  // Without more lines after it, the end of the last one.
  const short = buildRows([{ header: '@@', oldStart: 1, newStart: 1, types: ' +', text: ['a', 'b'], eof: [] }], true);
  assert.deepEqual(rowOfAnchor(short, { line: 9 }), { r: 2, frac: 1 });
  // A removed line, by its old number.
  assert.deepEqual(rowOfAnchor(rows, { line: 5, old: 5.5 }), { r: 4, frac: 0.5 });
  // Every line shown maps back to its row.
  for (let r = 0; r < rows.kind.length; r++) if (rows.n[r]) assert.equal(rowOfAnchor(rows, rowAnchor(rows, r, 0.3)).r, r);
});

test('lines shown between hunks are found where they are', () => {
  const x = noExpansion();
  x.file = { lines: Array.from({ length: 30 }, (_, k) => String(k + 1)), noNewline: false };
  x.top[1] = 3;
  const open = buildRows(hunks, true, x);
  const r = rowOfAnchor(open, { line: 12 });
  assert.equal(open.n[r.r], 12);
  // Line 15 is still hidden: the header below the lines shown.
  assert.equal(open.kind[rowOfAnchor(open, { line: 15 }).r], 0);
});

test('knots keep to the order of both the layout and the text, and end at the end', () => {
  const k = knotList(
    [
      { y: 10, line: 1 },
      { y: 50, line: 4 },
      { y: 40, line: 6 },
      { y: 60, line: 3 },
      { y: 90, line: 8 },
    ],
    200,
    21,
  );
  assert.deepEqual(k, [
    { y: 10, line: 1 },
    { y: 50, line: 4 },
    { y: 90, line: 8 },
    { y: 200, line: 21 },
  ]);
});

test('places go along a block proportionally, both ways', () => {
  const k = knotList(
    [
      { y: 0, line: 1 },
      { y: 100, line: 3 },
      { y: 112, line: 4 },
      { y: 412, line: 24 },
      { y: 430, line: 26 },
    ],
    500,
    30,
  );
  assert.equal(yOf(k, { line: 2 }), 50);
  assert.equal(yOf(k, { line: 14 }), 262);
  assert.deepEqual(anchorAt(k, 262), { line: 14 });
  for (let y = 0; y < 500; y += 7) assert.ok(Math.abs(yOf(k, anchorAt(k, y)) - y) < 1e-9);
  // Past the end, or before the start, the nearest end.
  assert.equal(yOf(k, { line: 99 }), 500);
  assert.deepEqual(anchorAt(k, -5), { line: 1 });
  // A line with no block of its own is in the block before it.
  assert.equal(yOf(k, { line: 25 }), 421);
});

test('a removed block is found by its old line, when its knots have one', () => {
  const k = knotList(
    [
      { y: 0, line: 1, old: 1 },
      { y: 100, line: 5, old: 5 },
      { y: 150, line: 5, old: 8 },
      { y: 200, line: 5, old: 10 },
      { y: 260, line: 8, old: 13 },
    ],
    300,
    11,
  );
  assert.equal(yOf(k, { line: 5, old: 9 }), 175);
  assert.equal(yOf(k, { line: 5 }), 200);
  assert.deepEqual(anchorAt(k, 175), { line: 5, old: 9 });
});

test('line starts', () => {
  assert.deepEqual([...lineStarts('a\nbc\n\nd')], [0, 2, 5, 6]);
  assert.deepEqual([...lineStarts('')], [0]);
});
