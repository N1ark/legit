import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { test } from 'node:test';
import {
  checkoutRemote, createBranch, deleteBranch, deleteRemoteBranch, deletedBranches, remoteBranches, renameBranch, restoreBranch,
} from '../src/server/branches.ts';
import { Repo } from '../src/server/repo.ts';
import { setup } from './util.ts';

const t = setup();
const { git, commit, write, read } = t;
const A = { name: 'Ann', email: 'ann@x.org' };
const dir = () => t.dir;

test('create a branch from HEAD or an older commit, switching to it or not', async () => {
  const base = commit('base', { f: '1\n' });
  commit('a', { f: '2\n' });
  const repo = await Repo.open(dir());
  let st = (await createBranch(repo, { name: 'feature' })).state;
  assert.equal(st.branch, 'feature');
  assert.equal(git('rev-parse', 'feature'), git('rev-parse', 'main'));

  st = (await createBranch(repo, { name: 'old', from: base, checkout: false })).state;
  assert.equal(st.branch, 'feature');
  assert.equal(git('rev-parse', 'old'), base);

  await assert.rejects(createBranch(repo, { name: 'old' }), /already exists/);
  await assert.rejects(createBranch(repo, { name: 'bad name' }), /not a valid branch name/);
  await assert.rejects(createBranch(repo, { name: '@{-1}' }), /not a valid branch name/);
  await assert.rejects(createBranch(repo, { name: '-x' }), /not a valid branch name/);
  await assert.rejects(createBranch(repo, { name: ' ' }), /needs a name/);
  assert.equal(git('rev-parse', 'old'), base);

  // From an older commit: uncommitted changes in the way make git refuse, and nothing changes.
  write('f', 'dirty\n');
  await assert.rejects(createBranch(repo, { name: 'older', from: base }), /Couldn't switch to older; nothing was changed/);
  assert.equal(read('f'), 'dirty\n');
  assert.equal(git('branch', '--show-current'), 'feature');
  assert.equal(git('branch', '--list', 'older'), '');

  // Leaving them on the current branch stashes them first.
  st = (await createBranch(repo, { name: 'older', from: base, stash: true })).state;
  assert.equal(st.branch, 'older');
  assert.equal(read('f'), '1\n');
  assert.match(git('stash', 'list', '--format=%gs'), /legit: on feature$/);
});

test('rename a branch: undo history and backups follow it', async () => {
  commit('base', { f: '1\n' });
  const a = commit('a', { f: '2\n' });
  git('branch', 'taken');
  const repo = await Repo.open(dir());
  await repo.edit({ sha: a, subject: 'A', body: '', author: A, coauthors: [] });
  assert.equal((await repo.backups()).length, 1);

  await assert.rejects(renameBranch(repo, { from: 'main', to: 'taken' }), /already exists/);
  await assert.rejects(renameBranch(repo, { from: 'main', to: 'no..dots' }), /not a valid/);
  await assert.rejects(renameBranch(repo, { from: 'nope', to: 'x' }), /No local branch/);
  const st = (await renameBranch(repo, { from: 'main', to: 'trunk' })).state;
  assert.equal(st.branch, 'trunk');
  assert.equal(st.canUndo, true);
  assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/legit/backups/main'), '');
  const backups = await repo.backups();
  assert.equal(backups.length, 1);
  assert.equal(backups[0].sha, a);
  await repo.undo();
  assert.equal(git('rev-parse', 'trunk'), a);
});

test('delete a branch: refuses the current one, saves the tip, and can bring it back', async () => {
  commit('base', { f: '1\n' });
  git('switch', '-q', '-c', 'feature');
  const tip = commit('feature work', { g: '1\n' });
  git('switch', '-q', 'main');
  git('config', 'branch.feature.remote', 'origin');
  const repo = await Repo.open(dir());

  await assert.rejects(deleteBranch(repo, { branch: 'main' }), /You're on main/);
  await assert.rejects(deleteBranch(repo, { branch: 'nope' }), /No local branch/);
  await deleteBranch(repo, { branch: 'feature' });
  assert.equal(git('branch', '--list', 'feature'), '');
  assert.throws(() => git('config', '--get', 'branch.feature.remote'));
  const deleted = await deletedBranches(repo);
  assert.equal(deleted.length, 1);
  assert.deepEqual([deleted[0].name, deleted[0].sha, deleted[0].subject, deleted[0].remote], ['feature', tip, 'feature work', null]);
  assert.match(deleted[0].ref, /^refs\/legit\/deleted\/feature\/\d{13}$/);
  // The existing restore (which moves HEAD) can't be pointed at it.
  await assert.rejects(repo.restore({ ref: deleted[0].ref }), /Not a legit backup/);

  // A branch of the same name now exists: restoring refuses, or takes a new name.
  git('branch', 'feature');
  await assert.rejects(restoreBranch(repo, { ref: deleted[0].ref }), /already exists/);
  assert.equal(git('rev-parse', 'feature'), git('rev-parse', 'main'));
  await restoreBranch(repo, { ref: deleted[0].ref, name: 'feature-old' });
  assert.equal(git('rev-parse', 'feature-old'), tip);
  assert.deepEqual(await deletedBranches(repo), []);
  await assert.rejects(restoreBranch(repo, { ref: deleted[0].ref }), /no longer there/);

  // Branches checked out in another worktree are left alone.
  const wt = t.tmp('legit-wt-');
  git('worktree', 'add', '-q', wt, 'feature-old');
  await assert.rejects(deleteBranch(repo, { branch: 'feature-old' }), /checked out in/);
  assert.equal(git('rev-parse', 'feature-old'), tip);
});

test('remote branches: list the untracked ones, check one out, delete one only as last seen', async () => {
  commit('base', { f: '1\n' });
  const remote = t.remote();
  git('push', '-q', '-u', 'origin', 'main');
  git('push', '-q', 'origin', 'main:feature', 'main:other');
  git('fetch', '-q');
  git('remote', 'set-head', 'origin', 'main');
  const repo = await Repo.open(dir());

  assert.deepEqual((await remoteBranches(repo)).map((b) => [b.remote, b.name, b.ref]).sort(), [
    ['origin', 'feature', 'refs/remotes/origin/feature'],
    ['origin', 'other', 'refs/remotes/origin/other'],
  ]);
  let st = (await checkoutRemote(repo, { ref: 'refs/remotes/origin/feature' })).state;
  assert.equal(st.branch, 'feature');
  assert.equal(git('rev-parse', '--abbrev-ref', 'feature@{u}'), 'origin/feature');
  assert.deepEqual((await remoteBranches(repo)).map((b) => b.name), ['other']);
  await assert.rejects(checkoutRemote(repo, { ref: 'refs/remotes/origin/nope' }), /No remote branch/);
  git('branch', 'other');
  assert.deepEqual(await remoteBranches(repo), []);
  await assert.rejects(checkoutRemote(repo, { ref: 'refs/remotes/origin/other' }), /already exists/);

  // Someone pushes to "other": deleting it as last fetched refuses, and nothing is deleted.
  const other = t.tmp('legit-other-');
  t.gitIn(other, 'clone', '-q', remote, '.');
  t.gitIn(other, 'switch', '-q', 'other');
  t.gitIn(other, 'commit', '-q', '--allow-empty', '-m', 'their work');
  t.gitIn(other, 'push', '-q', 'origin', 'other');
  const theirs = t.gitIn(other, 'rev-parse', 'HEAD');
  await assert.rejects(deleteRemoteBranch(repo, { ref: 'refs/remotes/origin/other' }), /haven't fetched/);
  assert.equal(t.gitIn(remote, 'rev-parse', 'other'), theirs);
  assert.deepEqual(await deletedBranches(repo), []);

  await assert.rejects(deleteRemoteBranch(repo, { ref: 'refs/remotes/nope/other' }), /not a remote branch/);
  await assert.rejects(deleteRemoteBranch(repo, { ref: 'refs/remotes/origin/gone' }), /fetch first/);
  git('fetch', '-q');
  st = (await deleteRemoteBranch(repo, { ref: 'refs/remotes/origin/other' })).state;
  assert.equal(t.gitIn(remote, 'branch', '--list', 'other'), '');
  assert.equal(git('branch', '-r', '--list', 'origin/other'), '');
  const deleted = await deletedBranches(repo);
  assert.deepEqual(deleted.map((d) => [d.name, d.sha, d.remote]), [['other', theirs, 'origin']]);
  assert.equal(git('rev-parse', 'other'), git('rev-parse', 'main'));
  void st;
});

test('switching with "leave my changes" stashes them, and puts them back if the switch fails', async () => {
  commit('base', { f: '1\n' });
  git('branch', 'other');
  commit('a', { f: '2\n' });
  write('f', 'mine\n');
  write('new', 'untracked\n');
  const repo = await Repo.open(dir());

  // Bringing them along would overwrite f: git refuses.
  await assert.rejects(repo.switchBranch({ branch: 'other' }), /Couldn't switch/);
  assert.equal(read('f'), 'mine\n');

  let st = (await repo.switchBranch({ branch: 'other', stash: true })).state;
  assert.equal(st.branch, 'other');
  assert.equal(read('f'), '1\n');
  assert.equal(t.exists('new'), false);
  assert.equal(st.stashed, null);
  st = (await repo.switchBranch({ branch: 'main' })).state;
  assert.equal(st.stashed?.branch, 'main');
  assert.deepEqual(st.stashed?.files.sort(), ['f', 'new']);

  // A switch that fails after stashing (here: "other" is checked out in another worktree) puts
  // the changes back exactly as they were, staged ones included.
  git('stash', 'pop', '-q', '--index');
  git('add', 'new');
  git('worktree', 'add', '-q', t.tmp('legit-wt-'), 'other');
  await assert.rejects(repo.switchBranch({ branch: 'other', stash: true }), /nothing was changed. Your changes were put back/);
  assert.equal(git('branch', '--show-current'), 'main');
  assert.equal(read('f'), 'mine\n');
  assert.equal(git('diff', '--cached', '--name-only'), 'new');
  assert.equal(git('stash', 'list'), '');
});

test('a switch that a hook fails after it happened says so and leaves the changes stashed', async () => {
  commit('base', { f: '1\n' });
  git('branch', 'other');
  write('f', 'mine\n');
  write('.git/hooks/post-checkout', '#!/bin/sh\nexit 1\n');
  chmodSync(`${t.dir}/.git/hooks/post-checkout`, 0o755);
  const repo = await Repo.open(dir());
  await assert.rejects(repo.switchBranch({ branch: 'other', stash: true }), /Switched to other, but/);
  assert.equal(git('branch', '--show-current'), 'other');
  assert.equal(read('f'), '1\n');
  assert.match(git('stash', 'list', '--format=%gs'), /legit: on main$/);
});
