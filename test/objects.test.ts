import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Git } from '../src/server/git.ts';
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
