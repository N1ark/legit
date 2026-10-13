import assert from 'node:assert/strict';
import { test } from 'node:test';
import { oldLines } from '../src/server/diff.ts';
import { discard } from '../src/server/discard.ts';
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

test('staged renames: unstage some lines keeps the rename, unstage all brings the old path back; discard refuses', async () => {
  commit('base', { 'old.txt': text() });
  git('mv', 'old.txt', 'new.txt');
  write('new.txt', text((l) => { l[1] = 'B'; l[15] = 'P'; }));
  git('add', 'new.txt');
  const repo = await Repo.open(t.dir);
  let { staged } = await repo.work();
  let f = staged.files[0];
  assert.deepEqual([staged.files.length, f.status, f.oldPath], [1, 'R', 'old.txt']);
  await assert.rejects(discard(repo, { key: staged.sha, selection: { 'new.txt': 'all' } }), /rename of old\.txt/);
  await repo.unstage({ key: staged.sha, selection: { 'new.txt': changed({ hunks: [f.hunks[0]] }) } });
  assert.equal(git('show', ':new.txt') + '\n', text((l) => (l[15] = 'P')));
  assert.equal(git('ls-files'), 'new.txt');
  ({ staged } = await repo.work());
  f = staged.files[0];
  assert.equal(f.status, 'R');
  await repo.unstage({ key: staged.sha, selection: { 'new.txt': 'all' } });
  assert.equal(git('ls-files'), 'old.txt');
  assert.equal(git('diff', '--cached', '--name-only'), '');
});
