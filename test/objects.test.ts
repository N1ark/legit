import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Git, MAX_RUNNING, type RunOpts, run } from '../src/server/git.ts';
import { setup } from './util.ts';

const t = setup();

test('objects are read through one process, in order, concurrently, large or missing', async () => {
  const a = t.commit('one', { f: '1\n' });
  const big = 'x'.repeat(3_000_000) + '\n';
  t.commit('two', { big });
  const blob = t.git('rev-parse', 'HEAD:big');
  const git = await Git.open(t.dir);
  const [r1, r2, r3] = await Promise.all([
    git.readObjects([blob, '0'.repeat(40), a]),
    git.readObjects([a]),
    git.readObjects(['HEAD:f', 'nope\nmore']),
  ]);
  assert.equal(r1.get(blob)?.data.toString(), big);
  assert.equal(r1.has('0'.repeat(40)), false);
  assert.equal(r1.get(a)?.type, 'commit');
  assert.equal(r2.get(a)?.type, 'commit');
  assert.equal(r3.get('HEAD:f')?.data.toString(), '1\n');
  assert.equal(r3.size, 1);
  // Objects written since are found.
  const c = t.commit('three', { f: '3\n' });
  assert.equal((await git.commit(c)).parents[0], t.git('rev-parse', 'HEAD~1'));
});

test('git processes past a few at once take turns, the newest first; one with a timeout never waits', async () => {
  const done: string[] = [];
  const go = (name: string, args: string[], opts?: RunOpts) => run(t.dir, args, opts).then(() => done.push(name));
  const slow = ['-c', 'alias.slow=!sleep 0.4', 'slow'];
  const all = Array.from({ length: MAX_RUNNING }, (_, k) => go(`slow${k}`, slow));
  all.push(go('older', ['--version']), go('newer', ['--version']), go('timed', ['--version'], { timeout: 10_000 }));
  await Promise.all(all);
  assert.equal(done[0], 'timed');
  assert.ok(done.indexOf('newer') < done.indexOf('older'));
  assert.ok(done.indexOf('newer') > done.findIndex((d) => d.startsWith('slow')));
});

test('a git that times out ends then, its own processes too (a remote helper or hook that hangs)', async () => {
  t.commit('one', { f: '1\n' });
  const bin = t.tmp('legit-bin-');
  writeFileSync(join(bin, 'git-remote-stuck'), '#!/bin/sh\nexec sleep 20\n', { mode: 0o755 });
  const started = Date.now();
  const r = await run(t.dir, ['fetch', 'stuck::x'], { allowFail: true, timeout: 500, env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.code, -1);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});
