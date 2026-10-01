import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitDiff, fileContent, oldLines, summarize } from '../src/server/diff.ts';
import { Git } from '../src/server/git.ts';
import { HUNK, TAIL, buildRows, moveTokens, noExpansion, rowHunks } from '../src/ui/lib/rows.ts';
import { setup } from './util.ts';

const t = setup();

// Deterministic PRNG so failures reproduce.
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

function randomFile(): string[] {
  return Array.from({ length: Math.floor(rand() * 120) }, (_, k) => `line ${k}`);
}

function mutate(lines: string[]): string[] {
  const out = [...lines];
  for (let k = Math.floor(rand() * 5); k >= 0; k--) {
    const i = Math.floor(rand() * (out.length + 1));
    const r = rand();
    if (r < 0.35) out.splice(i, 0, 'new');
    else if (r < 0.7) out.splice(i, 1);
    else out[i] = 'changed';
  }
  return out;
}

function commit(content: string) {
  t.write('f', content);
  t.git('add', 'f');
  t.git('commit', '-q', '--allow-empty', '-m', 'c');
  return t.git('rev-parse', 'HEAD');
}

const text = (lines: string[], newline: boolean) => lines.join('\n') + (newline && lines.length ? '\n' : '');

test('showing the lines between hunks rebuilds both versions of the file', async () => {
  const git = await Git.open(t.dir);
  let tails = 0;
  let gaps = 0;
  for (let round = 0; round < 60; round++) {
    const old = randomFile();
    const neu = mutate(old);
    const nl = rand() < 0.8;
    commit(text(old, nl));
    const sha = commit(text(neu, nl));
    const d = await commitDiff(git, sha);
    const f = d.files[0];
    if (!f || f.status !== 'M') continue;
    const ctx = `round ${round}: ${old.length} -> ${neu.length} lines`;
    const hunks = fileContent(f);

    // Before anything is shown, the rows are what the summary counted.
    const plain = buildRows(hunks, true);
    assert.equal(plain.kind.length, summarize(d, new Set()).files[0].rows, ctx);
    if (plain.kind.includes(TAIL)) tails++;
    if (plain.hidden.some((h) => h !== null && h > 0)) gaps++;

    // Show a little of every gap from each side, then everything.
    const x = noExpansion();
    x.file = await oldLines(git, f);
    assert.deepEqual(x.file.lines, old, ctx);
    let rows = buildRows(hunks, true, x);
    rows.gaps.forEach((_, k) => {
      if (k > 0) x.top[k] = Math.min(2, rows.hidden[k]!);
      if (k < hunks.length) x.bottom[k] = Math.min(2, rows.hidden[k]! - (x.top[k] ?? 0));
    });
    const some = buildRows(hunks, true, x);
    for (const r of [plain, some]) {
      for (let k = 0; k < r.kind.length; k++) {
        if (r.o[k]) assert.equal(r.text[k], old[r.o[k] - 1], ctx);
        if (r.n[k]) assert.equal(r.text[k], neu[r.n[k] - 1], ctx);
      }
    }
    rows = some;
    rows.gaps.forEach((_, k) => {
      if (k === 0) x.bottom[k] = (x.bottom[k] ?? 0) + rows.hidden[k]!;
      else x.top[k] = (x.top[k] ?? 0) + rows.hidden[k]!;
    });
    const all = buildRows(hunks, true, x);
    const side = (nums: Uint32Array) => [...nums.keys()].filter((k) => nums[k]).map((k) => all.text[k]);
    assert.deepEqual(side(all.o), old, ctx);
    assert.deepEqual(side(all.n), neu, ctx);
    assert.equal(all.kind.filter((k) => k === HUNK).length, 1, ctx);
    assert.equal(all.kind.includes(TAIL), false, ctx);

    // The highlighter sees the same rows, and highlighting follows lines to where they moved.
    assert.equal(rowHunks(all).reduce((n, h) => n + h.text.length + 1, 0), all.kind.length, ctx);
    const offsets = Uint32Array.from({ length: plain.kind.length + 1 }, (_, k) => k);
    const tok = moveTokens({ classes: [''], offsets, data: Uint32Array.from({ length: plain.kind.length }, (_, k) => k) }, plain, all);
    for (let k = 0; k < plain.kind.length; k++) {
      if (plain.kind[k] === HUNK || plain.kind[k] === TAIL) continue;
      const to = [...all.kind.keys()].find((j) => all.o[j] === plain.o[k] && all.n[j] === plain.n[k])!;
      assert.deepEqual([...tok.data.subarray(tok.offsets[to], tok.offsets[to + 1])], [k], ctx);
    }
  }
  // The rounds did have hidden lines, and the file going on after the last hunk.
  assert.ok(tails >= 10 && gaps >= 10, `${tails} tails, ${gaps} with gaps`);
});
