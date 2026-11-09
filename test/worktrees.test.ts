import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { deletedBranches } from '../src/server/branches.ts';
import { Repo } from '../src/server/repo.ts';
import { addWorktree, findWorktree, removeWorktree, worktrees } from '../src/server/worktrees.ts';
import type { OpResult } from '../src/shared/types.ts';
import { setup } from './util.ts';

const t = setup();
const { git, commit } = t;

// Worktrees go next to the repo by default, so each test's repo gets a folder of its own.
beforeEach(() => {
  t.dir = join(t.tmp(), 'repo');
  mkdirSync(t.dir);
  git('init', '-q', '-b', 'main');
});

test('add worktrees for a new branch, an existing one or a remote one, and list them', async () => {
  const base = commit('base', { f: '1\n' });
  commit('a', { f: '2\n' });
  git('branch', 'old', base);
  const repo = await Repo.open(t.dir);
  const root = realpathSync(t.dir);

  // A new branch, next to the main worktree by default.
  const a = await addWorktree(repo, { branch: 'feature/x' });
  assert.equal(a.path, join(dirname(root), `${basename(root)}-feature-x`));
  t.gitIn(a.path, 'status');
  assert.equal(t.gitIn(a.path, 'branch', '--show-current'), 'feature/x');
  assert.equal(git('rev-parse', 'feature/x'), git('rev-parse', 'main'));
  assert.equal(git('branch', '--list', '--format=%(upstream)', 'feature/x'), '');

  // An existing branch, at a typed path (relative to the worktree's root).
  const b = await addWorktree(repo, { branch: 'old', path: '../wt-old' });
  assert.equal(b.path, join(dirname(root), 'wt-old'));
  assert.equal(t.gitIn(b.path, 'rev-parse', 'HEAD'), base);

  // A new branch from an older commit; another default path doesn't reuse a taken folder.
  const c = await addWorktree(repo, { branch: 'other', from: base });
  assert.equal(t.gitIn(c.path, 'rev-parse', 'HEAD'), base);

  await assert.rejects(addWorktree(repo, { branch: 'old' }), /already checked out in/);
  await assert.rejects(addWorktree(repo, { branch: 'main' }), /already checked out in/);
  await assert.rejects(addWorktree(repo, { branch: 'old', from: base }), /already exists/);
  await assert.rejects(addWorktree(repo, { branch: 'bad name' }), /not a valid branch name/);
  await assert.rejects(addWorktree(repo, { branch: 'n', path: b.path }), /already exists and isn't empty/);
  assert.equal(git('branch', '--list', 'n'), '');

  const list = await worktrees(repo);
  assert.deepEqual(
    list.map((w) => [w.name, w.branch, w.main, w.current, w.missing]),
    [
      [basename(root), 'main', true, true, false],
      [`${basename(root)}-feature-x`, 'feature/x', false, false, false],
      [`${basename(root)}-other`, 'other', false, false, false],
      ['wt-old', 'old', false, false, false],
    ],
  );
  // Branches checked out elsewhere say where.
  const branches = await repo.branches();
  assert.equal(branches.find((x) => x.name === 'old')?.worktree, b.path);
  assert.equal(branches.find((x) => x.name === 'main')?.worktree, null);

  // From a linked worktree, it's the current one and the main one stays first.
  const there = await Repo.open(b.path);
  assert.deepEqual((await worktrees(there)).map((w) => w.current), [false, false, false, true]);
  assert.equal((await findWorktree(there, root)).path, root);

  // Tracking a remote branch.
  t.remote();
  git('push', '-q', 'origin', 'main:shared');
  git('fetch', '-q', 'origin');
  const d = await addWorktree(repo, { branch: 'shared', from: 'origin/shared', track: true });
  assert.equal(t.gitIn(d.path, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/shared');
});

test('remove a worktree whatever its state: its changes are stashed first, and its detached commits kept', async () => {
  commit('base', { f: '1\n' });
  const repo = await Repo.open(t.dir);
  const root = realpathSync(t.dir);
  const { path } = await addWorktree(repo, { branch: 'x' });

  writeFileSync(join(path, '.gitignore'), 'build/\n');
  t.gitIn(path, 'add', '.gitignore');
  t.gitIn(path, 'commit', '-qm', 'on x');
  // Ignored files go with it.
  mkdirSync(join(path, 'build'));
  writeFileSync(join(path, 'build', 'out'), '');
  // Uncommitted changes and untracked files are stashed on its branch.
  writeFileSync(join(path, 'new'), 'u\n');
  writeFileSync(join(path, 'f'), 'changed\n');
  t.gitIn(path, 'add', 'f');

  await assert.rejects(removeWorktree(repo, { path: root }), /main worktree/);
  // Locked doesn't stop it either.
  git('worktree', 'lock', '--reason', 'busy', path);
  const tip = t.gitIn(path, 'rev-parse', 'HEAD');
  const r = (await removeWorktree(repo, { path })) as OpResult;
  assert.match(r.note ?? '', /stashed on x/);
  assert.equal(existsSync(path), false);
  assert.equal(git('rev-parse', 'x'), tip);
  assert.equal((await worktrees(repo)).length, 1);
  assert.deepEqual(await deletedBranches(repo), []);
  assert.match(git('stash', 'list', '--format=%gs'), /legit: on x$/);

  // The one you're in: removed from the main worktree, which it says to go to.
  const c = await addWorktree(repo, { branch: 'cur' });
  writeFileSync(join(c.path, 'wip'), 'w\n');
  const there = await Repo.open(c.path);
  const moved = await removeWorktree(there, { path: c.path });
  assert.deepEqual(moved, { moved: root, url: undefined, note: 'Its changes are stashed on cur.' });
  assert.equal(existsSync(c.path), false);
  assert.equal(git('rev-parse', 'cur'), git('rev-parse', 'main'));

  // Switching to x offers its changes back.
  const st = (await repo.switchBranch({ branch: 'x' })).state;
  assert.deepEqual(st.stashed?.files.sort(), ['f', 'new']);
  git('switch', '-q', 'main');

  // Detached, with a commit no branch has: saved under Recently deleted, named after the folder.
  const d = await addWorktree(repo, { branch: 'y', path: '../legit-detached' });
  t.gitIn(d.path, 'switch', '-q', '--detach');
  t.gitIn(d.path, 'commit', '-q', '--allow-empty', '-m', 'lonely');
  const lonely = t.gitIn(d.path, 'rev-parse', 'HEAD');
  await removeWorktree(repo, { path: d.path });
  const saved = await deletedBranches(repo);
  assert.deepEqual(saved.map((b) => [b.name, b.sha]), [['legit-detached', lonely]]);
  assert.equal(git('cat-file', '-t', lonely), 'commit');

  // One whose folder is gone is just forgotten.
  const e = await addWorktree(repo, { branch: 'z' });
  rmSync(e.path, { recursive: true, force: true });
  assert.equal((await worktrees(repo)).find((w) => w.path === e.path)?.missing, true);
  await assert.rejects(findWorktree(repo, e.path), /is gone/);
  await removeWorktree(repo, { path: e.path });
  assert.equal((await worktrees(repo)).length, 1);
  await assert.rejects(removeWorktree(repo, { path: e.path }), /no worktree at/);

  // Gone, and detached on a commit no branch has: that commit is still saved.
  const g = await addWorktree(repo, { branch: 'w', path: '../legit-gone' });
  t.gitIn(g.path, 'switch', '-q', '--detach');
  t.gitIn(g.path, 'commit', '-q', '--allow-empty', '-m', 'stranded');
  const stranded = t.gitIn(g.path, 'rev-parse', 'HEAD');
  rmSync(g.path, { recursive: true, force: true });
  await removeWorktree(repo, { path: g.path });
  assert.deepEqual((await deletedBranches(repo)).map((b) => [b.name, b.sha]), [['legit-gone', stranded], ['legit-detached', lonely]]);
});

test('remove a worktree in the middle of a merge: its files are saved as a commit under Recently deleted', async () => {
  commit('base', { f: '1\n' });
  const repo = await Repo.open(t.dir);
  const { path } = await addWorktree(repo, { branch: 'm', path: '../legit-merging' });
  const inIt = (...args: string[]) => t.gitIn(path, ...args);
  inIt('switch', '-q', '-c', 'o');
  writeFileSync(join(path, 'f'), 'o\n');
  inIt('commit', '-qam', 'o');
  inIt('switch', '-q', 'm');
  writeFileSync(join(path, 'f'), 'm\n');
  inIt('commit', '-qam', 'm');
  assert.throws(() => inIt('merge', '-q', 'o'));
  writeFileSync(join(path, 'f'), 'resolved\n');

  const r = (await removeWorktree(repo, { path })) as OpResult;
  assert.match(r.note ?? '', /Recently deleted branches, as legit-merging-changes/);
  assert.equal(existsSync(path), false);
  const saved = (await deletedBranches(repo)).find((b) => b.name === 'legit-merging-changes')!;
  assert.equal(git('show', `${saved.sha}:f`), 'resolved');
  assert.equal(git('rev-parse', `${saved.sha}^`), git('rev-parse', 'm'));
});

test('remove a worktree with submodules: asked first when they have something only they have', async () => {
  const lib = t.tmp('legit-lib-');
  t.gitIn(lib, 'init', '-q', '-b', 'main');
  writeFileSync(join(lib, 'l'), '1\n');
  t.gitIn(lib, 'add', 'l');
  t.gitIn(lib, 'commit', '-qm', 'lib');
  commit('base', { f: '1\n' });
  git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib');
  git('commit', '-qm', 'add lib');
  const repo = await Repo.open(t.dir);
  const { path } = await addWorktree(repo, { branch: 'x' });
  t.gitIn(path, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init');
  assert.ok(existsSync(join(path, 'lib', 'l')));

  // A commit only the submodule has, even recorded in the worktree's branch, would be lost.
  const sub = join(path, 'lib');
  t.gitIn(sub, 'commit', '-q', '--allow-empty', '-m', 'local');
  const asks = (e: any) => e.code === 'worktree-loses' && /submodule lib has uncommitted changes or commits on no remote branch or tag.*anyway/.test(e.message);
  await assert.rejects(removeWorktree(repo, { path }), asks);
  t.gitIn(path, 'commit', '-qam', 'bump lib');
  await assert.rejects(removeWorktree(repo, { path }), asks);
  assert.ok(existsSync(path));
  await removeWorktree(repo, { path, force: true });
  assert.equal(existsSync(path), false);
  assert.equal((await worktrees(repo)).length, 1);

  // Clean and pushed, it isn't asked.
  const other = await addWorktree(repo, { branch: 'y' });
  t.gitIn(other.path, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init');
  await removeWorktree(repo, { path: other.path });
  assert.equal(existsSync(other.path), false);
});
