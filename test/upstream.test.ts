import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { Repo } from '../src/server/repo.ts';
import { rebaseBranch } from '../src/server/sync.ts';
import { env, setup } from './util.ts';

const t = setup();
const { git, commit } = t;

/** A fork: `origin` (yours) and `upstream` (the original), both with main, and a feature branch tracking origin. */
function fork() {
  commit('base', { f: '1\n' });
  const upstream = t.tmp('legit-upstream-');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', upstream], { env });
  git('remote', 'add', 'upstream', upstream);
  git('push', '-q', 'upstream', 'main');
  t.remote();
  git('push', '-q', '-u', 'origin', 'main');
  git('switch', '-q', '-c', 'feature');
  commit('mine', { g: '1\n' });
  git('push', '-q', '-u', 'origin', 'feature');
  // The original moves on; your fork's main doesn't.
  const other = t.tmp('legit-other-');
  t.gitIn(other, 'clone', '-q', upstream, '.');
  t.gitIn(other, 'commit', '-q', '--allow-empty', '-m', 'theirs');
  t.gitIn(other, 'push', '-q', 'origin', 'main');
  git('fetch', '-q', '--all');
}

test("upstream's default branch is offered when it has commits the usual base lacks", async () => {
  fork();
  const repo = await Repo.open(t.dir);
  let st = await repo.state();
  assert.equal(st.base?.name, 'origin/main');
  assert.equal(st.base?.behind, 0);
  assert.deepEqual(st.upstreamBase, { name: 'upstream/main', behind: 1 });

  await rebaseBranch(repo, { branch: 'upstream/main' });
  assert.equal(git('log', '--format=%s', '-3'), 'mine\ntheirs\nbase');
  st = await repo.state();
  assert.equal(st.upstreamBase, null);
});

test('not offered once your main has caught up, nor without an upstream remote', async () => {
  fork();
  git('push', '-q', 'origin', 'upstream/main:main');
  git('fetch', '-q', 'origin');
  const repo = await Repo.open(t.dir);
  let st = await repo.state();
  assert.equal(st.base?.behind, 1);
  assert.equal(st.upstreamBase, null);

  git('remote', 'remove', 'upstream');
  st = await repo.state();
  assert.equal(st.upstreamBase, null);
});
