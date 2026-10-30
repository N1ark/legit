import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HunkData } from '../src/shared/types.ts';
import { addedLines } from '../src/ui/lib/rendered.ts';
import { ADDED, buildRows } from '../src/ui/lib/rows.ts';

test('the lines a diff adds are those its rows show added, whitespace hidden or not', () => {
  let seed = 3;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
  const words = ['a', '  a', 'b', 'b ', 'c'];
  for (let round = 0; round < 300; round++) {
    const hunks: HunkData[] = [];
    let start = 1 + rand(5);
    for (let k = rand(4); k >= 0; k--) {
      let types = '';
      const text: string[] = [];
      for (let j = 1 + rand(12); j > 0; j--) {
        types += ' -+'[rand(3)];
        text.push(words[rand(words.length)]);
      }
      const eof = rand(5) ? [] : [types.length - 1];
      hunks.push({ header: '@@', oldStart: start, newStart: start + rand(3), types, text, eof });
      start += types.length + 3;
    }
    for (const ws of [false, true]) {
      const rows = buildRows(hunks, false, undefined, ws);
      const want = new Set<number>();
      for (let r = 0; r < rows.kind.length; r++) if (rows.kind[r] === ADDED) want.add(rows.n[r]);
      assert.deepEqual([...addedLines(hunks, ws)].sort((a, b) => a - b), [...want].sort((a, b) => a - b));
    }
  }
  const h: HunkData[] = [{ header: '@@', oldStart: 1, newStart: 1, types: '+', text: ['x'], eof: [] }];
  assert.equal(addedLines(h, false), addedLines(h, false), 'the same set for the same hunks');
});
