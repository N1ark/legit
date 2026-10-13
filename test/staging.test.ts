import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DIFF_ARGS, applyLines, parseDiff } from '../src/server/diff.ts';
import { Repo } from '../src/server/repo.ts';
import { analyse, emit, lcs, positions, restage } from '../src/server/staging.ts';
import { setup } from './util.ts';

const t = setup();

/** The hunks of a diff from `a` to `b`. */
function hunks(a: string, b: string) {
  const d = mkdtempSync(join(tmpdir(), 'legit-hunks-'));
  writeFileSync(join(d, 'a'), a);
  writeFileSync(join(d, 'b'), b);
  try {
    execFileSync('git', ['diff', '--no-index', ...DIFF_ARGS.filter((x) => x !== '-r'), 'a', 'b'], { cwd: d });
    return [];
  } catch (e) {
    return parseDiff((e as { stdout: Buffer }).stdout.toString('latin1'), '').files[0].hunks;
  }
}
const HEAD = 'a\nb\nc\nd\ne\nf\ng\nh\n';
const WORK = 'a\nB\nc\nd\ne\nf\nG\nh\nnew\n';
// Changed lines: 0 -b, 1 +B, 2 -g, 3 +G, 4 +new.

test('positions rebuild the file exactly as applyLines does, for every set of lines', () => {
  for (const [a, b] of [[HEAD, WORK], ['x\ny', 'y\nx\nz'], ['', 'one\ntwo\n'], ['one\ntwo\n', '']]) {
    const h = hunks(a, b);
    const pos = positions(a, h);
    const n = h.flatMap((x) => x.lines).filter((l) => l.i !== undefined).length;
    for (let mask = 0; mask < 1 << n; mask++) {
      const pick = (i: number) => !!((mask >> i) & 1);
      assert.equal(emit(pos, pick), applyLines(a, h, pick));
    }
  }
});

test('lcs finds a longest common subsequence', () => {
  assert.deepEqual(lcs(['a', 'b', 'c', 'a', 'b', 'b', 'a'], ['c', 'b', 'a', 'b', 'a', 'c']).filter((j) => j >= 0).length, 4);
  assert.deepEqual(lcs([], ['a']), []);
  assert.deepEqual(lcs(['a', 'x', 'b'], ['a', 'b']), [0, -1, 1]);
});

test('what is staged, line by line; a line edited again after staging is mixed until picked', () => {
  const pos = positions(HEAD, hunks(HEAD, WORK));
  const staged = (index: string) => [...analyse(pos, index).staged].sort();
  assert.deepEqual(staged(HEAD), []);
  assert.deepEqual(staged(WORK), [0, 1, 2, 3, 4]);
  assert.deepEqual(staged('a\nB\nc\nd\ne\nf\ng\nh\n'), [0, 1]);

  // "b" was staged as "BB", then edited to "B": neither version is a set of lines.
  const index = 'a\nBB\nc\nd\ne\nf\nG\nh\n';
  const s = analyse(pos, index);
  assert.deepEqual([[...s.staged], s.regions.map((r) => r.lines), s.other], [[2, 3], [[0, 1]], false]);
  // Unstaging another line keeps "BB"; staging or unstaging one of its own replaces it.
  assert.equal(restage(pos, index, s, [2, 3], false), 'a\nBB\nc\nd\ne\nf\ng\nh\n');
  assert.equal(restage(pos, index, s, [1], true), 'a\nB\nc\nd\ne\nf\nG\nh\n');
  assert.equal(restage(pos, index, s, [0], false), 'a\nb\nc\nd\ne\nf\nG\nh\n');

  // A change the working tree doesn't have, between unchanged lines: no line to pick it by.
  const odd = analyse(pos, 'a\nb\nc\nX\nd\ne\nf\ng\nh\n');
  assert.deepEqual(odd.regions.map((r) => r.lines), [[]]);
  assert.equal(restage(pos, 'a\nb\nc\nX\nd\ne\nf\ng\nh\n', odd, [4], true), 'a\nb\nc\nX\nd\ne\nf\ng\nh\nnew\n');
  // Only the final newline differs.
  assert.equal(analyse(positions('a\n', hunks('a\n', 'b\n')), 'a').other, true);
});

test('staging line after line from one snapshot, as quick clicks do; files staged in no line', async () => {
  const { git, write, commit } = t;
  commit('base', { f: HEAD, g: 'g\n', h: 'h\n' });
  write('f', WORK);
  const repo = await Repo.open(t.dir);
  const changes = await repo.work();
  const key = changes.sha;
  for (const i of [1, 0, 4]) await repo.stage({ key, selection: { f: [i] } });
  assert.equal(git('show', ':f'), 'a\nB\nc\nd\ne\nf\ng\nh\nnew');
  await repo.unstage({ key, selection: { f: [4] } });
  assert.equal(git('show', ':f'), 'a\nB\nc\nd\ne\nf\ng\nh');
  // Staging everything left is `git add`.
  await repo.stage({ key, selection: { f: [2, 3, 4] } });
  assert.equal(git('diff', '--name-only'), '');

  // Edited again after staging: the line is mixed, and staging it takes the file's version.
  write('f', WORK.replace('B', 'B2'));
  let f = (await repo.work()).files.find((x) => x.path === 'f')!;
  assert.deepEqual([f.stage, f.mixed?.length], ['some', 2]);
  await repo.stage({ key: (await repo.work()).sha, selection: { f: [f.mixed![0]] } });
  assert.equal(git('diff', '--name-only'), '');

  // Staged, then undone in the file: listed without lines; unstaging puts it back.
  write('g', 'G, longer\n');
  git('add', 'g');
  write('g', 'g\n');
  // `git rm --cached`: a staged deletion of a file that's still there.
  git('rm', '-q', '--cached', 'h');
  let all = await repo.work();
  const g = all.files.find((x) => x.path === 'g')!;
  const h = all.files.find((x) => x.path === 'h')!;
  assert.deepEqual([g.stage, g.hunks.length, !!g.unshown], ['some', 0, true]);
  assert.deepEqual([h.stage, h.untracked, !!h.unshown], ['some', undefined, true]);
  assert.equal(all.files.filter((x) => x.path === 'h').length, 1);
  await repo.unstage({ key: all.sha, selection: { g: 'all', h: 'all' } });
  assert.equal(git('status', '--porcelain'), 'M  f');
  all = await repo.work();
  f = all.files.find((x) => x.path === 'f')!;
  assert.deepEqual([f.stage, f.staged], ['all', [0, 1, 2, 3, 4]]);
});
