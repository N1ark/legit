import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Repo } from '../src/server/repo.ts';
import { env, setup } from './util.ts';

const t = setup();
const { git, commit, write, read } = t;
const log = () => git('log', '--format=%s').split('\n');
/** A file at a revision, byte for byte (the `git` helper trims). */
const blob = (rev: string, f: string) => execFileSync('git', ['cat-file', 'blob', `${rev}:${f}`], { cwd: t.dir, env, encoding: 'latin1' });
const backups = () => git('for-each-ref', '--format=%(refname)', 'refs/legit/backups').split('\n').filter(Boolean);

/** Change index of the line of `path` in `sha`'s diff with this kind and text. */
async function change(repo: Repo, sha: string, path: string, t: '+' | '-', s: string): Promise<number> {
  const f = (await repo.diff(sha)).files.find((x) => x.path === path)!;
  const l = f.hunks.flatMap((h) => h.lines).find((x) => x.t === t && x.s === s);
  assert.ok(l, `no ${t}${s} in ${path}`);
  return l.i!;
}

test('remove an added line from an old commit: later commits and the files lose it too', async () => {
  commit('base', { f: 'a\nb\nc\n' });
  const c = commit('change', { f: 'a\nb\ndebug\nc\n', g: 'g\n' });
  commit('later', { f: 'a\nb\ndebug\nc\nd\n' });
  const repo = await Repo.open(t.dir);
  const before = git('rev-parse', 'HEAD');
  const r = await repo.removeChanges({ sha: c, selection: { f: [await change(repo, c, 'f', '+', 'debug')] } });
  assert.deepEqual(log(), ['later', 'change', 'base']);
  assert.equal(blob('HEAD~1', 'f'), 'a\nb\nc\n');
  assert.equal(blob('HEAD~1', 'g'), 'g\n');
  assert.equal(blob('HEAD', 'f'), 'a\nb\nc\nd\n');
  assert.equal(read('f'), 'a\nb\nc\nd\n');
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(r.renamed[c], git('rev-parse', 'HEAD~1'));
  assert.deepEqual(r.focus, [git('rev-parse', 'HEAD~1')]);
  assert.equal(backups().length, 1);
  assert.equal(git('rev-parse', backups()[0]), before);

  // Undo brings the line back, files included.
  await repo.undo();
  assert.equal(git('rev-parse', 'HEAD'), before);
  assert.equal(read('f'), 'a\nb\ndebug\nc\nd\n');
});

test('re-add a removed line, and take whole files out of a commit', async () => {
  commit('base', { f: 'a\nb\nc\n', old: 'old\n' });
  git('rm', '-q', 'old');
  const c = commit('change', { f: 'a\nc\n', added: 'new\n' });
  const repo = await Repo.open(t.dir);
  await repo.removeChanges({ sha: c, selection: { f: [await change(repo, c, 'f', '-', 'b')], old: 'all', added: 'all' } });
  assert.equal(blob('HEAD', 'f'), 'a\nb\nc\n');
  assert.equal(blob('HEAD', 'old'), 'old\n');
  assert.deepEqual(git('ls-tree', '--name-only', 'HEAD').split('\n'), ['f', 'old']);
  assert.equal(read('old'), 'old\n');
  assert.equal(t.exists('added'), false);
  // Nothing left: the commit stays, empty, with its message.
  assert.deepEqual(log(), ['change', 'base']);
  assert.equal(git('rev-parse', 'HEAD^{tree}'), git('rev-parse', 'HEAD~1^{tree}'));
});

test('a later commit that conflicts with the removal refuses it, with nothing changed', async () => {
  commit('base', { f: 'a\nc\n' });
  const c = commit('change', { f: 'a\nb\nc\n' });
  commit('later', { f: 'a\nB!\nc\n' });
  const repo = await Repo.open(t.dir);
  const head = git('rev-parse', 'HEAD');
  await assert.rejects(repo.removeChanges({ sha: c, selection: { f: [await change(repo, c, 'f', '+', 'b')] } }), /Conflict replaying/);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.deepEqual(backups(), []);
  assert.equal(read('f'), 'a\nB!\nc\n');
});

test('refuses when there are uncommitted changes, which are left alone', async () => {
  commit('base', { f: 'a\n', g: '1\n' });
  const c = commit('change', { f: 'a\nb\n' });
  write('g', 'wip\n');
  const repo = await Repo.open(t.dir);
  const head = git('rev-parse', 'HEAD');
  await assert.rejects(repo.removeChanges({ sha: c, selection: { f: 'all' } }), /uncommitted changes/);
  await assert.rejects(repo.editLine({ sha: c, path: 'f', line: 2, text: 'B' }), /uncommitted changes/);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(read('g'), 'wip\n');
  assert.equal(read('f'), 'a\nb\n');
});

test('refuses an empty selection and commits that are not editable', async () => {
  commit('base', { f: 'a\n' });
  const c = commit('change', { f: 'a\nb\n' });
  const repo = await Repo.open(t.dir);
  await assert.rejects(repo.removeChanges({ sha: c, selection: {} }), /Select some changes/);
  await assert.rejects(repo.removeChanges({ sha: c, selection: { f: [] } }), /Select some changes/);
  await assert.rejects(repo.editLine({ sha: '0'.repeat(40), path: 'f', line: 1, text: 'x' }), /not editable/);
});

test('edit an added line of an old commit, into several lines', async () => {
  commit('base', { f: 'a\nc\n' });
  const c = commit('change', { f: 'a\ntypo\nc\n' });
  commit('later', { f: 'a\ntypo\nc\nd\n' });
  const repo = await Repo.open(t.dir);
  const r = await repo.editLine({ sha: c, path: 'f', line: 2, text: 'fixed\nmore' });
  assert.deepEqual(log(), ['later', 'change', 'base']);
  assert.equal(blob('HEAD~1', 'f'), 'a\nfixed\nmore\nc\n');
  assert.equal(blob('HEAD', 'f'), 'a\nfixed\nmore\nc\nd\n');
  assert.equal(read('f'), 'a\nfixed\nmore\nc\nd\n');
  assert.deepEqual(r.focus, [git('rev-parse', 'HEAD~1')]);
  assert.equal(backups().length, 1);
});

test('editing an unchanged line makes the commit change it', async () => {
  commit('base', { f: 'a\nb\nc\n' });
  const c = commit('change', { f: 'a\nb\nc\nd\n' });
  const repo = await Repo.open(t.dir);
  await repo.editLine({ sha: c, path: 'f', line: 1, text: 'A' });
  assert.equal(blob('HEAD', 'f'), 'A\nb\nc\nd\n');
  assert.equal(blob('HEAD~1', 'f'), 'a\nb\nc\n');
});

test('editing keeps CRLF line endings and a missing final newline', async () => {
  commit('base', { f: 'a\r\n' });
  const c = commit('change', { f: 'a\r\nb\r\nlast' });
  const repo = await Repo.open(t.dir);
  await repo.editLine({ sha: c, path: 'f', line: 2, text: 'B\r\nB2' });
  assert.equal(blob('HEAD', 'f'), 'a\r\nB\r\nB2\r\nlast');
  await repo.editLine({ sha: git('rev-parse', 'HEAD'), path: 'f', line: 4, text: 'end\nend2' });
  assert.equal(blob('HEAD', 'f'), 'a\r\nB\r\nB2\r\nend\r\nend2');
});

test('editing a line keeps other bytes as they are, and refuses lines that are not UTF-8', async () => {
  commit('base', { f: 'x\n' });
  // Line 2 is Latin-1, line 3 UTF-8.
  writeFileSync(join(t.dir, 'f'), Buffer.concat([Buffer.from('x\ncaf\xe9\n', 'latin1'), Buffer.from('naïve\n', 'utf8')]));
  git('add', 'f');
  git('commit', '-qm', 'latin1');
  const repo = await Repo.open(t.dir);
  const head = git('rev-parse', 'HEAD');
  await assert.rejects(repo.editLine({ sha: head, path: 'f', line: 2, text: 'cafe' }), /isn't UTF-8/);
  await repo.editLine({ sha: head, path: 'f', line: 1, text: 'y' });
  const bytes = () => Buffer.from(blob('HEAD', 'f'), 'latin1');
  assert.deepEqual(bytes(), Buffer.concat([Buffer.from('y\ncaf\xe9\n', 'latin1'), Buffer.from('naïve\n', 'utf8')]));
  await repo.editLine({ sha: git('rev-parse', 'HEAD'), path: 'f', line: 3, text: 'naïf' });
  assert.deepEqual(bytes(), Buffer.concat([Buffer.from('y\ncaf\xe9\n', 'latin1'), Buffer.from('naïf\n', 'utf8')]));
});

test('editing refuses lines that are not there, unchanged text, deleted and untouched files', async () => {
  commit('base', { f: 'a\n', gone: 'g\n', other: 'o\n' });
  git('rm', '-q', 'gone');
  const c = commit('change', { f: 'a\nb\n' });
  const repo = await Repo.open(t.dir);
  await assert.rejects(repo.editLine({ sha: c, path: 'f', line: 3, text: 'x' }), /no line 3/);
  await assert.rejects(repo.editLine({ sha: c, path: 'f', line: 0, text: 'x' }), /no line 0/);
  await assert.rejects(repo.editLine({ sha: c, path: 'f', line: 2, text: 'b' }), /unchanged/);
  await assert.rejects(repo.editLine({ sha: c, path: 'gone', line: 1, text: 'x' }), /can't be edited/);
  await assert.rejects(repo.editLine({ sha: c, path: 'other', line: 1, text: 'x' }), /isn't changed/);
  assert.equal(git('rev-parse', 'HEAD'), c);
  assert.deepEqual(backups(), []);
});
