import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cancelEdit, editChanges, finishEdit, startEdit } from '../src/server/edit.ts';
import { Repo } from '../src/server/repo.ts';
import { continueOp, markResolved } from '../src/server/sync.ts';
import { env, setup } from './util.ts';

const t = setup();
const { git, commit, write, read } = t;
const log = () => git('log', '--format=%s').split('\n');
const blob = (rev: string, f: string) => execFileSync('git', ['cat-file', 'blob', `${rev}:${f}`], { cwd: t.dir, env, encoding: 'latin1' });
const files = (rev: string) => git('ls-tree', '--name-only', rev).split('\n');
const branch = () => git('symbolic-ref', '-q', '--short', 'HEAD');

test('check out a commit, change it, and finish: amended, later commits replayed', async () => {
  commit('base', { f: 'a\nx\ny\nz\n', gone: 'g\n' });
  const c = commit('change', { f: 'a\nb\nx\ny\nz\n' });
  commit('later', { h: 'h\n' });
  const last = commit('last', { f: 'a\nb\nx\ny\nz\nc\n' });
  const repo = await Repo.open(t.dir);

  const started = await startEdit(repo, { sha: c });
  assert.equal(git('rev-parse', 'HEAD'), c);
  assert.equal(read('f'), 'a\nb\nx\ny\nz\n');
  assert.equal(t.exists('h'), false);
  const edit = started.state.conflict?.edit;
  assert.ok(edit);
  assert.equal(edit.sha, c);
  assert.equal(edit.subject, 'change');
  assert.deepEqual(edit.pending.map((p) => p.subject), ['later', 'last']);
  assert.equal(edit.legit, true);
  assert.equal(started.state.conflict?.files.length, 0);

  // Edit a tracked file, add one, delete one.
  write('f', 'a\nB\nx\ny\nz\n');
  write('new', 'n\n');
  rmSync(join(t.dir, 'gone'));
  const shown = (await editChanges(repo)).files.map((f) => `${f.status} ${f.path}`).sort();
  assert.deepEqual(shown, ['A new', 'D gone', 'M f']);

  const r = await finishEdit(repo);
  assert.equal(r.state.conflict, null);
  assert.equal(branch(), 'main');
  assert.deepEqual(log(), ['last', 'later', 'change', 'base']);
  assert.equal(blob('HEAD~2', 'f'), 'a\nB\nx\ny\nz\n');
  assert.deepEqual(files('HEAD~2'), ['f', 'new']);
  assert.equal(git('log', '-1', '--format=%an %s', 'HEAD~2'), 'Ann change');
  assert.equal(blob('HEAD', 'f'), 'a\nB\nx\ny\nz\nc\n');
  assert.deepEqual(files('HEAD'), ['f', 'h', 'new']);
  assert.equal(read('f'), 'a\nB\nx\ny\nz\nc\n');
  assert.equal(git('status', '--porcelain'), '');
  assert.deepEqual(r.focus, [git('rev-parse', 'HEAD~2')]);
  assert.match(r.message, /Amended "change" and replayed the 2 commits after it/);

  // One undo puts the branch back where it was.
  await repo.undo();
  assert.equal(git('rev-parse', 'HEAD'), last);
});

test('untracked files from before stay out of the commit, and stay on disk', async () => {
  commit('base', { f: 'a\n' });
  const c = commit('change', { f: 'a\nb\n' });
  commit('later', { g: 'g\n' });
  write('notes', 'mine\n');
  const repo = await Repo.open(t.dir);
  await startEdit(repo, { sha: c });
  write('f', 'a\nB\n');
  assert.deepEqual((await editChanges(repo)).files.map((f) => f.path), ['f']);
  await finishEdit(repo);
  assert.deepEqual(files('HEAD~1'), ['f']);
  assert.deepEqual(files('HEAD'), ['f', 'g']);
  assert.equal(read('notes'), 'mine\n');
});

test('finishing with no changes leaves history as it was', async () => {
  commit('base', { f: 'a\n' });
  const c = commit('change', { f: 'a\nb\n' });
  const last = commit('later', { g: 'g\n' });
  const repo = await Repo.open(t.dir);
  await startEdit(repo, { sha: c });
  const r = await finishEdit(repo);
  assert.equal(git('rev-parse', 'HEAD'), last);
  assert.equal(branch(), 'main');
  assert.match(r.message, /unchanged/);
});

test('a later commit that conflicts stops the replay for the conflict view; continuing finishes it', async () => {
  commit('base', { f: 'a\nb\nc\n' });
  const c = commit('change', { f: 'a\nB\nc\n' });
  commit('later', { f: 'a\nB!\nc\n' });
  const repo = await Repo.open(t.dir);
  await startEdit(repo, { sha: c });
  write('f', 'a\nbee\nc\n');
  const r = await finishEdit(repo);
  assert.equal(r.state.conflict?.kind, 'rebase');
  assert.deepEqual(r.state.conflict?.files.map((f) => f.path), ['f']);
  assert.equal(r.state.conflict?.edit, null);
  assert.match(r.message, /stopped with conflicts in 1 file/);
  assert.equal(blob('HEAD', 'f'), 'a\nbee\nc\n');

  write('f', 'a\nbee!\nc\n');
  await markResolved(repo, { path: 'f' });
  await continueOp(repo);
  assert.equal(branch(), 'main');
  assert.deepEqual(log(), ['later', 'change', 'base']);
  assert.equal(blob('HEAD~1', 'f'), 'a\nbee\nc\n');
  assert.equal(blob('HEAD', 'f'), 'a\nbee!\nc\n');
});

test('cancelling puts everything back, after saving the edits (new files included)', async () => {
  commit('base', { f: 'a\n' });
  const c = commit('change', { f: 'a\nb\n' });
  const last = commit('later', { g: 'g\n' });
  write('notes', 'mine\n');
  const repo = await Repo.open(t.dir);
  await startEdit(repo, { sha: c });
  write('f', 'edited\n');
  write('made', 'while editing\n');
  const r = await cancelEdit(repo);
  assert.equal(r.state.conflict, null);
  assert.equal(git('rev-parse', 'HEAD'), last);
  assert.equal(branch(), 'main');
  assert.equal(read('f'), 'a\nb\n');
  assert.equal(read('notes'), 'mine\n');
  assert.match(r.message, /^Stopped editing; nothing was changed\./);
  const saved = git('for-each-ref', '--format=%(refname)', 'refs/legit/aborted');
  assert.equal(blob(saved, 'f'), 'edited\n');
  assert.equal(blob(saved, 'made'), 'while editing\n');
  assert.equal(files(saved).includes('notes'), false);
});

test('the newest commit and the first commit can be edited too', async () => {
  const first = commit('first', { f: '1\n' });
  const newest = commit('newest', { g: '2\n' });
  const repo = await Repo.open(t.dir);
  await startEdit(repo, { sha: newest });
  write('g', 'two\n');
  await finishEdit(repo);
  assert.equal(blob('HEAD', 'g'), 'two\n');
  assert.deepEqual(log(), ['newest', 'first']);

  await startEdit(repo, { sha: first });
  assert.equal(git('rev-parse', 'HEAD'), first);
  write('f', 'one\n');
  await finishEdit(repo);
  assert.deepEqual(log(), ['newest', 'first']);
  assert.equal(blob('HEAD~1', 'f'), 'one\n');
  assert.deepEqual(files('HEAD~1'), ['f']);
  assert.equal(blob('HEAD', 'f'), 'one\n');
  assert.equal(blob('HEAD', 'g'), 'two\n');
});

test('refuses with uncommitted changes, or an untracked file in the way, changing nothing', async () => {
  commit('base', { f: 'a\n', u: 'tracked\n' });
  const c = commit('change', { f: 'a\nb\n' });
  git('rm', '-q', 'u');
  git('commit', '-qm', 'drop u');
  const last = git('rev-parse', 'HEAD');
  const repo = await Repo.open(t.dir);

  write('f', 'wip\n');
  await assert.rejects(startEdit(repo, { sha: c }), /uncommitted changes/);
  assert.equal(read('f'), 'wip\n');
  git('checkout', '-q', 'f');

  write('u', 'precious\n');
  await assert.rejects(startEdit(repo, { sha: c }), /nothing was changed/);
  assert.equal(read('u'), 'precious\n');
  assert.equal(git('rev-parse', 'HEAD'), last);
  assert.equal(branch(), 'main');
  assert.equal((await repo.state()).conflict, null);
});

test("an edit stop from a terminal rebase works too, leaving untracked files alone", async () => {
  commit('base', { f: 'a\n' });
  const c = commit('change', { f: 'a\nb\n' });
  commit('later', { g: 'g\n' });
  const repo = await Repo.open(t.dir);
  execFileSync('git', ['rebase', '-i', `${c}~1`], {
    cwd: t.dir, env: { ...env, GIT_SEQUENCE_EDITOR: "sed -i.bak -E '1s/^pick /edit /'" },
  });
  const state = await repo.state();
  assert.equal(state.conflict?.edit?.legit, false);
  write('f', 'a\nB\n');
  write('stray', 'x\n');
  await finishEdit(repo);
  assert.equal(blob('HEAD~1', 'f'), 'a\nB\n');
  assert.deepEqual(files('HEAD'), ['f', 'g']);
  assert.equal(read('stray'), 'x\n');
});
