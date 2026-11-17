import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CommitDiff } from '../src/shared/types.ts';
import { Git, type RunOpts } from '../src/server/git.ts';
import { workDiff } from '../src/server/work.ts';
import { setup } from './util.ts';

const t = setup();

/** What a listing shows of each file. */
const shown = (d: CommitDiff) =>
  d.files.map((f) => ({ ...f, hunks: f.hunks.map((h) => ({ ...h, lines: h.lines.map((l) => ({ ...l })) })) }));

test("listing again asks git only for the patches of files that changed, and lists what a fresh look would", async () => {
  const { git, write, commit } = t;
  const body = (n: number, s: string) => Array.from({ length: n }, (_, k) => `${s} line ${k}\n`).join('');
  commit('base', { a: body(20, 'a'), b: body(20, 'b'), c: body(40, 'c'), x: 'x\n', 'é': 'e\n' });
  write('a', body(20, 'A'));
  write('b', body(10, 'b'));
  git('mv', 'c', 'd');
  write('d', body(40, 'c') + 'more\n');
  const repo = await Git.open(t.dir);
  const patches: string[][] = [];
  const run = repo.run.bind(repo);
  repo.run = (args: string[], opts?: RunOpts) => {
    if (args.includes('--patch-with-raw')) patches.push(args.slice(args.indexOf('HEAD') + 1));
    return run(args, opts);
  };
  const fresh = async () => shown((await workDiff(await Git.open(t.dir), '')).diff);
  // Only a file that changed a while ago can be told unchanged by its stat.
  await sleep(2100);
  const look = async () => shown((await workDiff(repo, '')).diff);
  assert.deepEqual(await look(), await fresh());
  assert.deepEqual(patches.splice(0), [[]]);
  assert.deepEqual(await look(), await fresh());
  assert.deepEqual(patches.splice(0), []);

  write('b', body(5, 'b'));
  write('x', 'y\n');
  write('é', 'é\n');
  await sleep(2100);
  assert.deepEqual(await look(), await fresh());
  assert.deepEqual(patches.splice(0), [['--', 'b', 'x', 'é']]);

  // A changed .gitattributes can change any file's patch: all of them are asked for again.
  write('.gitattributes', 'a -diff\n');
  await sleep(2100);
  const binary = await look();
  assert.deepEqual(binary, await fresh());
  assert.equal(binary.find((f) => f.path === 'a')!.binary, true);
  assert.deepEqual(patches.splice(0), [[]]);
  // As does a new commit.
  write('e', 'e\n');
  git('add', 'e');
  git('commit', '-qm', 'more', '--', 'e');
  assert.deepEqual(await look(), await fresh());
  assert.deepEqual(patches.splice(0), [[]]);
  // A rename that no longer reads as one is a deletion and a file added.
  await sleep(2100);
  await look();
  patches.length = 0;
  write('d', 'something else\n');
  await sleep(2100);
  const split = await look();
  assert.deepEqual(split, await fresh());
  assert.deepEqual(split.filter((f) => f.path === 'c' || f.path === 'd').map((f) => f.status), ['D', 'A']);
  assert.deepEqual(patches.splice(0), [['--', 'c', 'd']]);
});
