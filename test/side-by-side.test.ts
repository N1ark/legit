import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitDiff, fileContent, summarize } from '../src/server/diff.ts';
import { Git } from '../src/server/git.ts';
import { pairedRows, sideRows } from '../src/shared/side-by-side.ts';
import { whitespacePairs } from '../src/shared/whitespace.ts';
import { ADDED, CONTEXT, REMOVED, SPACED, buildRows, isHead } from '../src/ui/lib/rows.ts';
import { rowOn, sideBlocks, sideBySide, sideOffsets, sideWords } from '../src/ui/lib/side-by-side.ts';
import { setup } from './util.ts';

const t = setup();

const hunk = (types: string, text: string[], oldStart = 1, newStart = 1) => ({ header: '@@', oldStart, newStart, types, text, eof: [] });

test('side by side: removed lines beside added ones row by row, padded; the rest on both sides', () => {
  const rows = buildRows([hunk(' ---++ +-', ['a', 'r1', 'r2', 'r3', 'a1', 'a2', 'b', 'a3', 'r4'])]);
  const s = sideBySide(rows);
  // Rows: header, a, r1..r3, a1, a2, b, a3, r4.
  assert.deepEqual([...s.left], [0, 1, 2, 3, 4, 7, 9]);
  assert.deepEqual([...s.right], [0, 1, 5, 6, -1, 7, 8]);
  assert.deepEqual([...s.at], [0, 1, 2, 3, 4, 2, 3, 5, 6, 6]);
  assert.equal(rowOn(s, 4), 4);
  assert.equal(rowOn(s, 6), 9);
  assert.equal(rowOn({ left: Int32Array.of(-1), right: Int32Array.of(3), at: Int32Array.of() }, 0), 3);
  assert.equal(s.left.length, rows.kind.length - pairedRows(' ---++ +-', rows.hunks[0].text));
});

test('side by side, a line sits beside the one it was edited into, the lines around it row by row', () => {
  assert.deepEqual(sideRows(['i++;'], ['if (bad) throw err;', 'i++;']), [[-1, 0], [0, 1]]);
  assert.deepEqual(sideRows(['a = 1;', 'x', 'y'], ['p', 'a = 2;', 'q']), [[-1, 0], [0, 1], [1, 2], [2, -1]]);
  assert.deepEqual(sideRows(['u'], ['v', 'w']), [[0, 0], [-1, 1]]);
  const rows = buildRows([hunk(' -++', ['ctx', '  i++;', '  if (bad) throw err;', '  i++;'])]);
  const s = sideBySide(rows);
  assert.deepEqual([...s.left], [0, 1, -1, 2]);
  assert.deepEqual([...s.right], [0, 1, 3, 4]);
  assert.equal(s.left.length, rows.kind.length - pairedRows(' -++', rows.hunks[0].text));
});

test('side by side with whitespace hidden: a pair is a row of its own, the lines around it paired apart', () => {
  const types = ' --++++ ';
  const text = ['{', 'for', '  x', 'if', '  for', '    x', 'y', '}'];
  const rows = buildRows([hunk(types, text)], false, undefined, true);
  assert.deepEqual([...rows.kind], [0, CONTEXT, ADDED, SPACED, SPACED, ADDED, CONTEXT]);
  const s = sideBySide(rows);
  assert.deepEqual([...s.left], [0, 1, -1, 3, 4, -1, 6]);
  assert.deepEqual([...s.right], [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(s.left.length, rows.kind.length - pairedRows(types, text, whitespacePairs(types, text, () => false)));
});

test('wrapped side by side, a row is as tall as its taller side', () => {
  const rows = buildRows([hunk('-+ ', ['x'.repeat(25), 'y'.repeat(5), 'z'.repeat(12)])]);
  const s = sideBySide(rows);
  assert.deepEqual([...sideOffsets(rows, s, 10)], [0, 1, 4, 6]);
  const pad = buildRows([hunk('--+', ['a', 'b'.repeat(21), 'c'])]);
  assert.deepEqual([...sideOffsets(pad, sideBySide(pad), 10)], [0, 1, 2, 5]);
});

test('side by side, changed words are those of the line beside it', () => {
  // Unified, the similar lines would pair across positions; side by side, it's what's beside each.
  const rows = buildRows([hunk('--++', ['const a = 1;', 'zzz', 'const a = 2;', 'const b = 3;'])]);
  const words = sideWords(rows, sideBySide(rows));
  assert.deepEqual(words(1), [10, 11]);
  assert.deepEqual(words(3), [10, 11]);
  assert.equal(words(2), null, 'too different from what it sits beside');
  assert.equal(words(4), null);
  const odd = buildRows([hunk('--+', ['a = 1', 'b', 'a = 2'])]);
  assert.equal(sideWords(odd, sideBySide(odd))(2), null, 'beside a filler');
});

test('blocks go under the row side by side that shows their row, left before right', () => {
  const rows = buildRows([hunk('--++', ['a', 'b', 'c', 'd'])]);
  const s = sideBySide(rows);
  const out = sideBlocks([{ key: 'x', row: 1, start: 1 }, { key: 'y', row: 2, start: 2 }, { key: 'z', row: 3, start: 1 }], s);
  assert.deepEqual(out.map((b) => [b.key, b.row]), [['x', 1], ['z', 1], ['y', 2]]);
});

// Deterministic PRNG so failures reproduce.
let seed = 5;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

function edit(lines: string[]): string[] {
  const out = [...lines];
  for (let k = Math.floor(rand() * 8); k >= 0; k--) {
    const i = Math.floor(rand() * (out.length + 1));
    const r = rand();
    if (r < 0.3) out[i] = '  ' + (out[i] ?? '');
    else if (r < 0.5) out.splice(i, 0, ...Array.from({ length: 1 + Math.floor(rand() * 4) }, () => 'new'));
    else if (r < 0.7) out.splice(i, 1 + Math.floor(rand() * 3));
    else out[i] = 'changed';
  }
  return out;
}

test('side by side, every line shows once on its side, in order, and the summary counts the rows', async () => {
  const git = await Git.open(t.dir);
  let fillers = 0;
  for (let round = 0; round < 60; round++) {
    const old = Array.from({ length: 5 + Math.floor(rand() * 80) }, (_, k) => (k % 5 ? `line ${k % 11}` : `  block ${k}`));
    t.write('f', old.join('\n') + '\n');
    t.git('add', 'f');
    t.git('commit', '-q', '--allow-empty', '-m', 'a');
    t.write('f', edit(old).join('\n') + '\n');
    t.git('add', 'f');
    t.git('commit', '-q', '--allow-empty', '-m', 'b');
    const d = await commitDiff(git, t.git('rev-parse', 'HEAD'));
    const f = d.files[0];
    if (!f) continue;
    const sum = summarize(d, new Set()).files[0];
    for (const ws of [false, true]) {
      const ctx = `round ${round}${ws ? ', whitespace hidden' : ''}`;
      const rows = buildRows(fileContent(f), true, undefined, ws);
      const s = sideBySide(rows);
      assert.equal(s.left.length, sum.rows - (ws ? sum.ws + sum.pairedWs : sum.paired), ctx);
      const olds: number[] = [];
      const news: number[] = [];
      const seen = new Set<number>();
      for (let v = 0; v < s.left.length; v++) {
        const [l, r] = [s.left[v], s.right[v]];
        assert.ok(l >= 0 || r >= 0, ctx);
        if (l < 0 || r < 0) fillers++;
        for (const x of [l, r]) if (x >= 0) assert.equal(s.at[x], v, ctx);
        if (l >= 0) assert.ok(l === r || rows.kind[l] === REMOVED, ctx);
        if (r >= 0) assert.ok(l === r || rows.kind[r] === ADDED, ctx);
        if (l >= 0 && !isHead(rows.kind[l]) && rows.o[l]) olds.push(rows.o[l]);
        if (r >= 0 && !isHead(rows.kind[r]) && rows.n[r]) news.push(rows.n[r]);
        seen.add(l).add(r);
      }
      seen.delete(-1);
      assert.equal(seen.size, rows.kind.length, ctx);
      assert.deepEqual(olds, [...olds].sort((a, b) => a - b), ctx);
      assert.deepEqual(news, [...news].sort((a, b) => a - b), ctx);
    }
  }
  assert.ok(fillers > 20);
});
