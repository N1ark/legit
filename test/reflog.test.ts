import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Git } from '../src/server/git.ts';
import { setup } from './util.ts';

const t = setup();

test("a branch's reflog read from its file lists what `git reflog show` does", async () => {
  t.commit('one', { a: '1' });
  t.commit('two', { a: '2' });
  t.git('commit', '-q', '--amend', '-m', 'two, amended');
  t.git('reset', '-q', '--hard', 'HEAD~1');
  t.git('branch', '-q', 'other');
  const git = await Git.open(t.dir);
  for (const ref of ['refs/heads/main', 'refs/heads/other']) {
    const listed = t.git('reflog', 'show', '--format=%H', ref, '--').split('\n').filter(Boolean);
    assert.deepEqual(await git.reflogShas(ref), listed, ref);
  }
  assert.deepEqual(await git.reflogShas('refs/heads/none'), []);
});
