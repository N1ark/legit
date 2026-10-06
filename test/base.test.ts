import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultBranch, freshest } from '../src/server/base.ts';

test("the default branch: the remote's HEAD, else main, else master, here or on the remote", () => {
  const refs = (...names: string[]) => new Map(names.map((n) => [n, 'x']));
  assert.equal(defaultBranch(['trunk', 'main', 'master'], 'origin', refs('refs/remotes/origin/trunk', 'refs/heads/main')), 'trunk');
  assert.equal(defaultBranch(['main', 'master'], 'origin', refs('refs/heads/master', 'refs/remotes/origin/main')), 'main');
  assert.equal(defaultBranch(['main', 'master'], null, refs('refs/heads/master')), 'master');
  assert.equal(defaultBranch(['main', 'master'], null, refs('refs/remotes/origin/main')), null);
});

test('rebase onto whichever of the default branch and its remote-tracking one has the other, else the remote one', () => {
  assert.equal(freshest('a', 'a', false, false), 'remote');
  assert.equal(freshest('a', 'b', true, false), 'remote');
  assert.equal(freshest('a', 'b', false, true), 'local');
  assert.equal(freshest('a', 'b', false, false), 'remote');
  assert.equal(freshest('a', null, false, false), 'local');
  assert.equal(freshest(null, 'b', false, false), 'remote');
  assert.equal(freshest(null, null, false, false), null);
});
