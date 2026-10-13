import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRows } from '../src/ui/lib/rows.ts';
import { wrappedOffsets, wrappedRows } from '../src/ui/lib/wrap.ts';

test('wrapped rows: by columns, tabs to their stops, headers never wrap', () => {
  assert.equal(wrappedRows('', 10), 1);
  assert.equal(wrappedRows('x'.repeat(10), 10), 1);
  assert.equal(wrappedRows('x'.repeat(11), 10), 2);
  assert.equal(wrappedRows('x'.repeat(31), 10), 4);
  assert.equal(wrappedRows('x'.repeat(31), 0), 1);
  // A tab from column 1 reaches 4; one that doesn't fit starts the next row.
  assert.equal(wrappedRows('x\t\tx', 9), 1);
  assert.equal(wrappedRows('xxxxxxxx\tx', 9), 2);
  const rows = buildRows([{ header: '@@ -1,2 +1,2 @@ ' + 'h'.repeat(40), oldStart: 1, newStart: 1, types: ' -+', text: ['short', 'y'.repeat(25), 'z'.repeat(5)], eof: [] }]);
  assert.deepEqual([...wrappedOffsets(rows, 10)], [0, 1, 2, 5, 6]);
});
