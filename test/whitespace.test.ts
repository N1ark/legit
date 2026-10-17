import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitDiff, fileContent, summarize } from '../src/server/diff.ts';
import { Git } from '../src/server/git.ts';
import { matchKeys, whitespacePairs } from '../src/shared/whitespace.ts';
import { ADDED, CONTEXT, SPACED, buildRows, changesIn, isHead, rowOfChange } from '../src/ui/lib/rows.ts';
import { setup } from './util.ts';

const t = setup();

test('matching keys: the longest run in order, or greedily when the lists are huge', () => {
  assert.deepEqual(matchKeys(['a', 'b'], ['x', 'a', 'b', 'y']), [[0, 1], [1, 2]]);
  assert.deepEqual(matchKeys(['x', 'a', 'b', 'c'], ['a', 'b', 'c', 'x']), [[1, 0], [2, 1], [3, 2]]);
  assert.deepEqual(matchKeys([], ['a']), []);
  const big = Array.from({ length: 1200 }, (_, k) => `l${k}`);
  const pairs = matchKeys(big, ['new', ...big]);
  assert.equal(pairs.length, 1200);
  assert.deepEqual(pairs[0], [0, 1]);
});

test('whitespace pairs: only within a run of changes, never across a missing newline', () => {
  const types = '--++ -+-+';
  const text = ['  a', 'b', 'a', 'x', 'ctx', 'c', 'c ', 'd', 'd'];
  const pairs = whitespacePairs(types, text, (k) => k === 7);
  assert.deepEqual([...pairs], [[0, 2], [5, 6]]);
  // `a + b` and `a+b` are the same once whitespace is ignored, as `git diff -w` has it.
  assert.equal(whitespacePairs('-+', ['a + b', '\ta+b'], () => false).size, 1);
  // A UTF-8 byte that reads as a no-break space in latin1 isn't whitespace.
  assert.equal(whitespacePairs('-+', [' x', 'x'], () => false).size, 0);
});

test('hiding whitespace shows each pair as one row carrying both changes', () => {
  const hunks = [{ header: '@@', oldStart: 1, newStart: 1, types: ' --++++ ', text: ['{', 'for', '  x', 'if', '  for', '    x', '}', '}'], eof: [] }];
  const plain = buildRows(hunks);
  const rows = buildRows(hunks, false, undefined, true);
  assert.equal(rows.kind.length, plain.kind.length - 2);
  assert.deepEqual([...rows.kind], [0, CONTEXT, ADDED, SPACED, SPACED, ADDED, CONTEXT]);
  assert.deepEqual(rows.text.slice(1), ['{', 'if', '  for', '    x', '}', '}']);
  assert.deepEqual([...rows.o], [0, 1, 0, 2, 3, 0, 4]);
  assert.deepEqual([...rows.n], [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...rows.ci], [-1, -1, 2, 0, 1, 5, -1]);
  assert.deepEqual([...rows.c2], [-1, -1, -1, 3, 4, -1, -1]);
  assert.deepEqual(changesIn(rows, 2, 3), [2, 0, 3]);
  assert.equal(rowOfChange(rows, 4), 4);
  assert.equal(rowOfChange(rows, 9), -1);
});

// Deterministic PRNG so failures reproduce.
let seed = 11;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

function reindent(lines: string[]): string[] {
  const out = [...lines];
  for (let k = Math.floor(rand() * 6); k >= 0; k--) {
    const i = Math.floor(rand() * (out.length + 1));
    const r = rand();
    if (r < 0.4) out[i] = '  ' + (out[i] ?? '');
    else if (r < 0.55) out[i] = (out[i] ?? '').replace(/ /g, '');
    else if (r < 0.7) out.splice(i, 0, 'new');
    else if (r < 0.85) out.splice(i, 1);
    else out[i] = 'changed';
  }
  return out;
}

test('with whitespace hidden, every change and line still shows exactly once, as the summary counted', async () => {
  const git = await Git.open(t.dir);
  let spaced = 0;
  for (let round = 0; round < 60; round++) {
    const old = Array.from({ length: 5 + Math.floor(rand() * 60) }, (_, k) => (k % 7 ? `line ${k % 9}` : `  block ${k}`));
    t.write('f', old.join('\n') + '\n');
    t.git('add', 'f');
    t.git('commit', '-q', '--allow-empty', '-m', 'a');
    t.write('f', reindent(old).join('\n') + '\n');
    t.git('add', 'f');
    t.git('commit', '-q', '--allow-empty', '-m', 'b');
    const d = await commitDiff(git, t.git('rev-parse', 'HEAD'));
    const f = d.files[0];
    if (!f) continue;
    const ctx = `round ${round}`;
    const s = summarize(d, new Set()).files[0];
    const rows = buildRows(fileContent(f), true, undefined, true);
    assert.equal(rows.kind.length, s.rows - s.ws, ctx);
    const seen = changesIn(rows, 0, rows.kind.length - 1).sort((a, b) => a - b);
    assert.deepEqual(seen, Array.from({ length: f.added + f.removed }, (_, k) => k), ctx);
    const olds: number[] = [];
    const news: number[] = [];
    for (let r = 0; r < rows.kind.length; r++) {
      if (isHead(rows.kind[r])) continue;
      if (rows.o[r]) olds.push(rows.o[r]);
      if (rows.n[r]) news.push(rows.n[r]);
      if (rows.kind[r] === SPACED) {
        spaced++;
        assert.equal(rows.text[r].replace(/\s/g, ''), f.hunks.flatMap((h) => h.lines).find((l) => l.o === rows.o[r])!.s.replace(/\s/g, ''), ctx);
      }
    }
    // Line numbers rise on each side, as in the file.
    assert.deepEqual(olds, [...olds].sort((a, b) => a - b), ctx);
    assert.deepEqual(news, [...news].sort((a, b) => a - b), ctx);
  }
  assert.ok(spaced > 20);
});
