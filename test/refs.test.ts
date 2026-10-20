import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Git } from '../src/server/git.ts';
import { Repo } from '../src/server/repo.ts';
import { setup } from './util.ts';

const t = setup();

/** What git itself says HEAD is. */
const gitHead = () => ({
  branch: t.git('symbolic-ref', '-q', '--short', 'HEAD') || null,
  head: (() => {
    try {
      return t.git('rev-parse', '-q', '--verify', 'HEAD^{commit}');
    } catch {
      return null;
    }
  })(),
});

test('HEAD and refs read from their files agree with git: loose, packed, detached, unborn, symbolic', async () => {
  const a = t.commit('one', { f: '1\n' });
  const git = await Git.open(t.dir);
  assert.deepEqual(await git.headState(), gitHead());
  assert.equal(await git.readRef('refs/heads/main'), a);
  assert.equal(await git.readRef('refs/heads/nope'), null);

  t.git('pack-refs', '--all');
  assert.equal(await git.readRef('refs/heads/main'), a);
  const b = t.commit('two', { f: '2\n' });
  // The loose ref wins over the packed one.
  assert.equal(await git.readRef('refs/heads/main'), b);
  assert.deepEqual(await git.headState(), gitHead());
  t.git('pack-refs', '--all');
  t.git('branch', 'other', a);
  t.git('pack-refs', '--all');
  assert.equal(await git.readRef('refs/heads/other'), a);
  t.git('branch', '-D', 'other');
  assert.equal(await git.readRef('refs/heads/other'), null);

  t.git('symbolic-ref', 'refs/heads/alias', 'refs/heads/main');
  assert.equal(await git.readRef('refs/heads/alias'), b);
  assert.equal(await git.readSymref('refs/heads/alias'), 'refs/heads/main');
  assert.equal(await git.readSymref('refs/heads/main'), null);
  assert.equal(await git.resolve('refs/heads/main^{commit}'), b);
  assert.equal(await git.readRef('refs/heads/main^{commit}'), undefined);
  assert.equal(await git.readRef('HEAD'), undefined);

  t.git('checkout', '-q', '--detach', a);
  assert.deepEqual(await git.headState(), { branch: null, head: a });
  t.git('checkout', '-q', '--orphan', 'fresh');
  assert.deepEqual(await git.headState(), { branch: 'fresh', head: null });
  t.git('checkout', '-q', '-f', 'main');
  t.git('branch', 'dir/x');
  // refs/heads/dir is a directory, not a ref.
  assert.equal(await git.readRef('refs/heads/dir'), null);
  assert.deepEqual(await git.headState(), gitHead());
});

test("a linked worktree's HEAD is its own", async () => {
  const a = t.commit('one', { f: '1\n' });
  const wt = t.tmp('legit-wt-');
  t.git('worktree', 'add', '-q', '-b', 'side', `${wt}/w`);
  t.gitIn(`${wt}/w`, 'commit', '-q', '--allow-empty', '-m', 'side');
  const b = t.gitIn(`${wt}/w`, 'rev-parse', 'HEAD');
  const git = await Git.open(`${wt}/w`);
  assert.deepEqual(await git.headState(), { branch: 'side', head: b });
  assert.equal(await git.readRef('refs/heads/main'), a);
});

test('the remotes and their URLs come from the config, sorted as `git remote` lists them', async () => {
  t.commit('one', { f: '1\n' });
  t.git('remote', 'add', 'zed', 'https://github.com/a/zed.git');
  t.git('remote', 'add', 'origin', 'git@github.com:a/b.git');
  t.git('config', 'remote.no.url.fetch', '+refs/heads/*:refs/remotes/no.url/*');
  t.git('config', 'remote.pushDefault', 'origin');
  const git = await Git.open(t.dir);
  const { names, urls } = await git.remotes();
  assert.deepEqual(names, t.git('remote').split('\n'));
  assert.deepEqual([...urls], [['zed', 'https://github.com/a/zed.git'], ['origin', 'git@github.com:a/b.git']]);
});

test('cached answers never outlive what they depend on: the state follows refs moved behind its back', async () => {
  const remote = t.remote();
  t.commit('one', { f: '1\n' });
  t.git('push', '-q', '-u', 'origin', 'main');
  const b = t.commit('two', { f: '2\n' });
  const repo = await Repo.open(t.dir);
  let s = await repo.state();
  assert.deepEqual([s.push?.ahead, s.commits.map((c) => c.pushed)], [1, [false, true]]);
  t.git('push', '-q');
  s = await repo.state();
  assert.deepEqual([s.push?.ahead, s.commits.map((c) => c.pushed)], [0, [true, true]]);
  // Someone else pushes; a fetch brings it in.
  const other = t.tmp('legit-clone-');
  t.gitIn(other, 'clone', '-q', remote, 'c');
  t.gitIn(`${other}/c`, '-c', 'user.name=B', '-c', 'user.email=b@x', 'commit', '-q', '--allow-empty', '-m', 'theirs');
  t.gitIn(`${other}/c`, 'push', '-q');
  t.git('fetch', '-q');
  s = await repo.state();
  assert.deepEqual([s.push?.ahead, s.push?.behind, s.head], [0, 1, b]);
  t.git('pack-refs', '--all');
  t.git('merge', '-q', '--ff-only', 'origin/main');
  s = await repo.state();
  assert.deepEqual([s.push?.behind, s.commits[0].subject, s.commits.length], [0, 'theirs', 3]);
  t.git('branch', '-q', '--unset-upstream');
  s = await repo.state();
  assert.equal(s.push?.publish, true);
  t.write('f', 'changed\n');
  t.git('stash', 'push', '-q', '-m', 'legit: on main');
  assert.deepEqual((await repo.state()).stashed?.files, ['f']);
  t.git('stash', 'drop', '-q');
  assert.equal((await repo.state()).stashed, null);
});

test('deepening a shallow clone shows the history it brings, with HEAD unchanged', async () => {
  t.commit('one', { f: '1\n' });
  t.commit('two', { f: '2\n' });
  t.commit('three', { f: '3\n' });
  const clone = `${t.tmp('legit-shallow-')}/c`;
  t.gitIn(t.dir, 'clone', '-q', '--depth=1', `file://${t.dir}`, clone);
  const repo = await Repo.open(clone);
  assert.deepEqual((await repo.state()).commits.map((c) => c.subject), ['three']);
  t.gitIn(clone, 'fetch', '-q', '--unshallow');
  assert.deepEqual((await repo.state()).commits.map((c) => c.subject), ['three', 'two', 'one']);
});
