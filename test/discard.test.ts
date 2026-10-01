import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { discard, discarded, restoreDiscarded, trashing } from '../src/server/discard.ts';
import { Repo } from '../src/server/repo.ts';

let dir = '';
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Ann', GIT_AUTHOR_EMAIL: 'ann@x.org', GIT_COMMITTER_NAME: 'Ann', GIT_COMMITTER_EMAIL: 'ann@x.org',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
const write = (f: string, s: string | Buffer) => writeFileSync(join(dir, f), s);
const read = (f: string) => readFileSync(join(dir, f), 'utf8');
const commit = (msg: string, files: Record<string, string>) => {
  for (const [f, s] of Object.entries(files)) write(f, s);
  git('add', '-A');
  git('commit', '-qm', msg);
  return git('rev-parse', 'HEAD');
};
const lines = (edit: (l: string[]) => void) => {
  const l = 'abcdefghijklmnopqrst'.split('');
  edit(l);
  return l.join('\n') + '\n';
};
/** The index and the legit backups, which a discard must leave alone. */
const untouched = () => [git('ls-files', '-s'), git('for-each-ref', 'refs/legit/backups')];
const unstagedFile = async (repo: Repo, path: string) => {
  const { unstaged } = await repo.work();
  return { key: unstaged.sha, f: unstaged.files.find((x) => x.path === path)! };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'legit-test-'));
  dirs.push(dir);
  git('init', '-q', '-b', 'main');
});

test('discard selected lines: the rest of the file stays, the index is untouched', async () => {
  commit('base', { f: lines(() => {}) });
  write('f', lines((l) => { l[1] = 'B'; l[15] = 'P'; }));
  git('add', 'f');
  const staged = git('ls-files', '-s');
  write('f', lines((l) => { l[1] = 'B2'; l[15] = 'P2'; }));
  const repo = await Repo.open(dir);
  const was = untouched();
  const { key, f } = await unstagedFile(repo, 'f');
  // Discard the second hunk ("P" -> "P2"); keep "B" -> "B2".
  const second = f.hunks[1].lines.filter((l) => l.i !== undefined).map((l) => l.i!);
  const r = await discard(repo, { key, selection: { f: second } });
  assert.equal(read('f'), lines((l) => { l[1] = 'B2'; l[15] = 'P'; }));
  assert.equal(git('ls-files', '-s'), staged);
  assert.deepEqual(untouched(), was);
  assert.match(r.ref!, /^refs\/legit\/discarded\/\d+$/);
  // The snapshot holds the file as it was; its second parent, as it was left.
  assert.equal(git('show', `${r.ref}:f`) + '\n', lines((l) => { l[1] = 'B2'; l[15] = 'P2'; }));
  assert.equal(git('show', `${r.ref}^2:f`) + '\n', lines((l) => { l[1] = 'B2'; l[15] = 'P'; }));
  assert.equal(git('rev-parse', `${r.ref}^1`), git('rev-parse', 'HEAD'));
});

test('discarded lines go through checkout filters (line endings)', async () => {
  git('config', 'core.autocrlf', 'true');
  commit('base', { f: 'a\r\nb\r\nc\r\n' });
  write('f', 'A\r\nb\r\nC\r\n');
  const repo = await Repo.open(dir);
  const { key, f } = await unstagedFile(repo, 'f');
  const lastHunkLines = f.hunks[0].lines.filter((l) => l.s === 'c' || l.s === 'C').map((l) => l.i!);
  await discard(repo, { key, selection: { f: lastHunkLines } });
  assert.equal(read('f'), 'A\r\nb\r\nc\r\n');
});

test('discard whole files, untracked files, and restore them all', async () => {
  commit('base', { f: '1\n', g: 'g\n', gone: 'x\n' });
  write('f', '2\n');
  write('g', 'staged\n');
  git('add', 'g');
  write('g', 'staged and more\n');
  rmSync(join(dir, 'gone'));
  mkdirSync(join(dir, 'new/deep'), { recursive: true });
  write('new/deep/n.txt', 'one\ntwo\n');
  const repo = await Repo.open(dir);
  const was = untouched();
  const { unstaged } = await repo.work();
  const r = await discard(repo, { key: unstaged.sha, selection: { f: 'all', g: 'all', gone: 'all', 'new/deep/n.txt': 'all' } });
  assert.equal(r.files, 4);
  assert.equal(read('f'), '1\n');
  assert.equal(read('g'), 'staged\n');
  assert.equal(read('gone'), 'x\n');
  assert.equal(existsSync(join(dir, 'new')), false);
  assert.deepEqual(untouched(), was);
  assert.equal(git('status', '--porcelain'), 'M  g');

  const list = await discarded(repo.git);
  assert.equal(list.length, 1);
  assert.equal(list[0].label, 'discarded changes to 4 files');
  assert.deepEqual([...list[0].files].sort(), ['f', 'g', 'gone', 'new/deep/n.txt']);

  const back = await restoreDiscarded(repo, { ref: r.ref! });
  assert.deepEqual([back.restored, back.conflicts], [4, []]);
  assert.equal(read('f'), '2\n');
  assert.equal(read('g'), 'staged and more\n');
  assert.equal(existsSync(join(dir, 'gone')), false);
  assert.equal(read('new/deep/n.txt'), 'one\ntwo\n');
  assert.deepEqual(untouched(), was);
  // Restoring again finds everything already there.
  assert.equal((await restoreDiscarded(repo, { ref: r.ref! })).restored, 0);
  await assert.rejects(restoreDiscarded(repo, { ref: 'refs/legit/backups/main/1-edit' }), /Not a legit discard/);
});

test('binary files, modes and symlinks round-trip byte for byte', async () => {
  const bin = Buffer.from([0, 1, 2, 255, 254, 10, 0, 13]);
  commit('base', { 'b.bin': 'old\0bin', 'run.sh': '#!/bin/sh\n', t: 'target\n' });
  symlinkSync('t', join(dir, 'link'));
  git('add', 'link');
  git('commit', '-qm', 'link');
  write('b.bin', bin);
  chmodSync(join(dir, 'run.sh'), 0o755);
  rmSync(join(dir, 'link'));
  symlinkSync('elsewhere', join(dir, 'link'));
  const repo = await Repo.open(dir);
  const { unstaged } = await repo.work();
  assert.deepEqual(unstaged.files.map((f) => f.path).sort(), ['b.bin', 'link', 'run.sh']);
  const r = await discard(repo, { key: unstaged.sha, selection: { 'b.bin': 'all', 'run.sh': 'all', link: 'all' } });
  assert.equal(read('b.bin'), 'old\0bin');
  assert.equal(lstatSync(join(dir, 'run.sh')).mode & 0o111, 0);
  assert.equal(readlinkSync(join(dir, 'link')), 't');
  assert.equal(git('status', '--porcelain'), '');

  await restoreDiscarded(repo, { ref: r.ref! });
  assert.deepEqual(readFileSync(join(dir, 'b.bin')), bin);
  assert.notEqual(lstatSync(join(dir, 'run.sh')).mode & 0o100, 0);
  assert.equal(readlinkSync(join(dir, 'link')), 'elsewhere');
});

test('refuses files that changed since they were shown, and partial untracked files', async () => {
  commit('base', { f: '1\n' });
  write('f', '2\n');
  write('u', 'a\nb\n');
  const repo = await Repo.open(dir);
  const { unstaged } = await repo.work();
  write('f', '3\n');
  await assert.rejects(discard(repo, { key: unstaged.sha, selection: { f: 'all' } }), /changed since it was shown/);
  assert.equal(read('f'), '3\n');
  await assert.rejects(discard(repo, { key: unstaged.sha, selection: { u: [0] } }), /only be discarded as a whole file/);
  assert.equal(read('u'), 'a\nb\n');
  assert.deepEqual(await discarded(repo.git), []);
  // A staged snapshot's key isn't accepted.
  git('add', 'u');
  const { staged } = await repo.work();
  await assert.rejects(discard(repo, { key: staged.sha, selection: { u: 'all' } }), /out of date/);
  assert.equal(read('u'), 'a\nb\n');
});

test('restore refuses files changed since the discard unless told to overwrite, saving them first', async () => {
  commit('base', { f: '1\n', g: '1\n' });
  write('f', 'mine\n');
  write('g', 'mine too\n');
  const repo = await Repo.open(dir);
  const { unstaged } = await repo.work();
  const r = await discard(repo, { key: unstaged.sha, selection: { f: 'all', g: 'all' } });
  write('f', 'newer\n');
  const refused = await restoreDiscarded(repo, { ref: r.ref! });
  assert.deepEqual([refused.restored, refused.conflicts], [0, ['f']]);
  assert.equal(read('f'), 'newer\n');
  assert.equal(read('g'), '1\n');

  const forced = await restoreDiscarded(repo, { ref: r.ref!, overwrite: true });
  assert.equal(forced.restored, 2);
  assert.equal(read('f'), 'mine\n');
  assert.equal(read('g'), 'mine too\n');
  // The overwritten content is a discard of its own, which brings it back.
  assert.ok(forced.saved);
  assert.equal(git('show', `${forced.saved}:f`), 'newer');
  assert.equal((await discarded(repo.git))[0].ref, forced.saved);
  await restoreDiscarded(repo, { ref: forced.saved! });
  assert.equal(read('f'), 'newer\n');
  assert.equal(read('g'), 'mine too\n');
});

test('big files go to the Trash instead of into git, and are refused if they cannot', async () => {
  const trash = mkdtempSync(join(tmpdir(), 'legit-trash-'));
  dirs.push(trash);
  const saved = { ...trashing };
  trashing.above = 10;
  let fail = false;
  trashing.trash = async (p) => {
    if (fail) throw new Error('no Trash here');
    renameSync(p, join(trash, 'big'));
  };
  try {
    commit('base', { small: '1\n' });
    write('big', 'x'.repeat(100));
    write('small', '2\n');
    const repo = await Repo.open(dir);
    let { unstaged } = await repo.work();
    fail = true;
    await assert.rejects(discard(repo, { key: unstaged.sha, selection: { big: 'all', small: 'all' } }), /Couldn't move big to the Trash.*Nothing was discarded/s);
    assert.equal(read('big'), 'x'.repeat(100));
    assert.equal(read('small'), '2\n');
    fail = false;
    ({ unstaged } = await repo.work());
    const r = await discard(repo, { key: unstaged.sha, selection: { big: 'all', small: 'all' } });
    assert.deepEqual(r.trashed, ['big']);
    assert.equal(existsSync(join(dir, 'big')), false);
    assert.equal(readFileSync(join(trash, 'big'), 'utf8'), 'x'.repeat(100));
    assert.equal(read('small'), '1\n');
    assert.equal(git('ls-tree', '--name-only', r.ref!), 'small');
    assert.deepEqual((await discarded(repo.git))[0].files.toSorted(), ['big (moved to the Trash)', 'small']);

    // An edit that lands mid-discard stops it before that file is touched.
    write('big', 'y'.repeat(100));
    write('small', '3\n');
    ({ unstaged } = await repo.work());
    trashing.trash = async (p) => {
      renameSync(p, join(trash, 'big2'));
      write('small', 'edited meanwhile\n');
    };
    await assert.rejects(
      discard(repo, { key: unstaged.sha, selection: { big: 'all', small: 'all' } }),
      /small changed in the meantime, so it was left as it is\. 1 of 2 files were discarded before that\. What was there before is saved in refs\/legit\/discarded\//,
    );
    assert.equal(read('small'), 'edited meanwhile\n');
  } finally {
    Object.assign(trashing, saved);
  }
});
