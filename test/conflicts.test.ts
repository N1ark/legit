import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASE, MARKER, NONE, OURS, THEIRS, conflictRoles } from '../src/ui/lib/conflicts.ts';
import { buildRows } from '../src/ui/lib/rows.ts';

const rows = (body: string[], newStart = 1) =>
  buildRows([{ header: '@@', oldStart: newStart, newStart, types: body.map((l) => l[0]).join(''), text: body.map((l) => l.slice(1)), eof: [] }]);

test("a conflict's markers and sides, diff3's base included; removed lines and headers aren't in it", () => {
  const r = rows([' a', '+<<<<<<< HEAD', ' mine', '-gone', '+||||||| base', '+old', '+=======', '+theirs\r', '+>>>>>>> feature', ' b']);
  assert.deepEqual([...conflictRoles(r)], [NONE, NONE, MARKER, OURS, NONE, MARKER, BASE, MARKER, THEIRS, MARKER, NONE]);
});

test('a conflict goes on across a folded gap, and text that only looks like a marker is left alone', () => {
  const hunks = [
    { header: '@@ -1 +1 @@', oldStart: 1, newStart: 1, types: '+ ', text: ['<<<<<<< HEAD', 'mine'], eof: [] },
    { header: '@@ -20 +21 @@', oldStart: 20, newStart: 21, types: ' ++ ', text: ['more', '=======', '>>>>>>> x', '======='], eof: [] },
  ];
  const r = buildRows(hunks);
  assert.deepEqual([...conflictRoles(r)], [NONE, MARKER, OURS, NONE, OURS, MARKER, MARKER, NONE]);
  assert.deepEqual([...conflictRoles(rows([' ========', ' >>>>>>> x', ' <<<<<<<<']))], [NONE, NONE, NONE, NONE]);
});
