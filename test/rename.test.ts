import assert from 'node:assert/strict';
import { test } from 'node:test';
import { oldLines } from '../src/server/diff.ts';
import { discard, restoreDiscarded } from '../src/server/discard.ts';
import { Repo } from '../src/server/repo.ts';
import { setup } from './util.ts';

const t = setup();
const { git, commit, write } = t;
const text = (edit: (l: string[]) => void = () => {}) => {
  const l = 'abcdefghijklmnopqrst'.split('');
  edit(l);
  return l.join('\n') + '\n';
};
const changed = (f: { hunks: { lines: { i?: number }[] }[] }) => f.hunks.flatMap((h) => h.lines).filter((l) => l.i !== undefined).map((l) => l.i!);
const tree = (rev: string) => git('ls-tree', '-r', '--name-only', rev).split('\n');

test('renames in a commit show as one file, with only the content changes', async () => {
  commit('base', { 'old.txt': text(), 'same.txt': 'same\n' });
  git('mv', 'same.txt', 'moved.txt');
  git('mv', 'old.txt', 'new.txt');
  const c = commit('rename', { 'new.txt': text((l) => (l[3] = 'D')) });
  const repo = await Repo.open(t.dir);
  const files = (await repo.diff(c)).files;
  assert.equal(files.length, 2);
  const f = files.find((x) => x.path === 'new.txt')!;
  const moved = files.find((x) => x.path === 'moved.txt')!;
  assert.deepEqual([moved.status, moved.oldPath, moved.path], ['R', 'same.txt', 'moved.txt']);
  assert.deepEqual([moved.added, moved.removed, moved.hunks.length], [0, 0, 0]);
  assert.deepEqual([f.status, f.oldPath, f.path, f.added, f.removed], ['R', 'old.txt', 'new.txt', 1, 1]);
  assert.ok(f.partial);
  // Its unchanged lines can be shown, from the old file.
  assert.equal((await oldLines(repo.git, f)).lines.length, 20);
});

test('split a renamed file: the rename goes with its picked lines, or alone', async () => {
  commit('base', { 'old.txt': text(), 'b.txt': 'b\n' });
  git('mv', 'old.txt', 'new.txt');
  git('mv', 'b.txt', 'c.txt');
  const c = commit('rename', { 'new.txt': text((l) => { l[1] = 'B'; l[15] = 'P'; }) });
  const repo = await Repo.open(t.dir);
  const f = (await repo.diff(c)).files.find((x) => x.path === 'new.txt')!;
  const second = changed({ hunks: [f.hunks[1]] });
  await repo.split({ sha: c, selection: { 'new.txt': second, 'c.txt': 'all' }, message: 'moved', before: true });
  assert.deepEqual(git('log', '--format=%s').split('\n'), ['rename', 'moved', 'base']);
  // The first commit renames both, with only the picked change.
  assert.deepEqual(tree('HEAD~1'), ['c.txt', 'new.txt']);
  assert.equal(git('show', 'HEAD~1:new.txt') + '\n', text((l) => (l[15] = 'P')));
  assert.equal(git('show', 'HEAD:new.txt') + '\n', text((l) => { l[1] = 'B'; l[15] = 'P'; }));
  const rest = (await repo.diff(git('rev-parse', 'HEAD'))).files;
  assert.deepEqual(rest.map((x) => [x.path, x.status]), [['new.txt', 'M']]);
});

test('take a rename out of a commit: the file goes back to its old name and content', async () => {
  commit('base', { 'old.txt': text() });
  git('mv', 'old.txt', 'new.txt');
  const c = commit('rename', { 'new.txt': text((l) => (l[1] = 'B')) });
  const repo = await Repo.open(t.dir);
  await repo.removeChanges({ sha: c, selection: { 'new.txt': 'all' } });
  assert.deepEqual(tree('HEAD'), ['old.txt']);
  assert.equal(git('show', 'HEAD:old.txt') + '\n', text());
});

test('a staged rename is one file: its lines stage and unstage, unstaging all brings the old path back, discard puts it back', async () => {
  commit('base', { 'old.txt': text() });
  git('mv', 'old.txt', 'new.txt');
  write('new.txt', text((l) => { l[1] = 'B'; l[15] = 'P'; }));
  git('add', 'new.txt');
  const repo = await Repo.open(t.dir);
  let changes = await repo.work();
  let f = changes.files[0];
  assert.deepEqual([changes.files.length, f.status, f.oldPath, f.stage], [1, 'R', 'old.txt', 'all']);
  await repo.unstage({ key: changes.sha, selection: { 'new.txt': changed({ hunks: [f.hunks[0]] }) } });
  assert.equal(git('show', ':new.txt') + '\n', text((l) => (l[15] = 'P')));
  assert.equal(git('ls-files'), 'new.txt');
  changes = await repo.work();
  f = changes.files[0];
  assert.deepEqual([f.status, f.stage], ['R', 'some']);
  await repo.unstage({ key: changes.sha, selection: { 'new.txt': 'all' } });
  assert.equal(git('ls-files'), 'old.txt');
  assert.equal(git('diff', '--cached', '--name-only'), '');
  // Unstaged, it's a deletion and an untracked file; staging both makes it one renamed file again.
  changes = await repo.work();
  assert.deepEqual(changes.files.map((x) => [x.path, x.status, x.stage]), [['new.txt', 'A', 'none'], ['old.txt', 'D', 'none']]);
  await repo.stage({ key: changes.sha, selection: { 'new.txt': 'all', 'old.txt': 'all' } });
  changes = await repo.work();
  assert.deepEqual(changes.files.map((x) => [x.path, x.status, x.stage]), [['new.txt', 'R', 'all']]);

  // Discarding all of it: the old file is back, the new one gone, from the files and the index.
  const r = await discard(repo, { key: changes.sha, selection: { 'new.txt': 'all' } });
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(t.read('old.txt'), text());
  assert.equal(t.exists('new.txt'), false);
  await restoreDiscarded(repo, { ref: r.ref! });
  assert.equal(git('status', '--porcelain'), 'R  old.txt -> new.txt');
});
