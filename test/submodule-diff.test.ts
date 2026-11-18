import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FileDiff } from '../src/shared/types.ts';
import { commitDiff, fileSizes } from '../src/server/diff.ts';
import { Git } from '../src/server/git.ts';
import { Repo } from '../src/server/repo.ts';
import { submoduleHead, submoduleLog, submodulePaths } from '../src/server/submodules.ts';
import { workDiff } from '../src/server/work.ts';
import { setup } from './util.ts';

const t = setup();

/** A repository with commits s1, s2, s3 (newest last), added to the test repo as submodule `lib` at s1. */
function withSubmodule(path = 'lib') {
  const sub = t.tmp('legit-sub-');
  t.gitIn(sub, 'init', '-q', '-b', 'main');
  const shas: string[] = [];
  for (const n of [1, 2, 3]) {
    writeFileSync(join(sub, 's.txt'), `s${n}\n`);
    t.gitIn(sub, 'add', '.');
    t.gitIn(sub, 'commit', '-qm', `s${n}`);
    shas.push(t.gitIn(sub, 'rev-parse', 'HEAD'));
  }
  t.commit('a', { 'a.txt': 'a\n' });
  t.git('-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', sub, path);
  t.gitIn(join(t.dir, path), 'checkout', '-q', shas[0]);
  t.git('add', path);
  t.git('commit', '-qm', 'add sub');
  return { sub, s: shas };
}

const inLib = (...args: string[]) => t.gitIn(join(t.dir, 'lib'), ...args);
const listed = async (path = 'lib') => (await workDiff(await Git.open(t.dir), '')).diff.files.find((f) => f.path === path);
const snapshot = async (repo: Repo) => (await repo.work()).sha;

test("a commit's submodule change says which commits it points at, and is whole", async () => {
  const { s } = withSubmodule();
  const git = await Git.open(t.dir);
  const added = (await commitDiff(git, t.git('rev-parse', 'HEAD'))).files.find((f) => f.path === 'lib')!;
  assert.deepEqual(added.submodule, { new: s[0] });
  inLib('checkout', '-q', s[1]);
  t.git('commit', '-qam', 'bump');
  const bump = (await commitDiff(git, t.git('rev-parse', 'HEAD'))).files.find((f) => f.path === 'lib')!;
  assert.deepEqual(bump.submodule, { old: s[0], new: s[1] });
  assert.equal(bump.partial, false);
  assert.equal(bump.binary, false);
  assert.deepEqual([bump.added, bump.removed], [1, 1]);
  // Turned into a file: one side is a submodule, the other a file.
  t.git('rm', '-q', '--cached', 'lib');
  rmSync(join(t.dir, 'lib'), { recursive: true, force: true });
  t.git('config', '-f', '.gitmodules', '--remove-section', 'submodule.lib');
  t.commit('now a file', { lib: 'one\ntwo\n' });
  const d = await commitDiff(git, t.git('rev-parse', 'HEAD'));
  const typed = d.files.find((f) => f.path === 'lib')!;
  assert.equal(typed.status, 'T');
  assert.deepEqual(typed.submodule, { old: s[1] });
  assert.equal(typed.added, 2);
  assert.ok(typed.hunks.some((h) => h.lines.some((l) => l.s === `Subproject commit ${s[1]}`)));
  // Sizes are only asked of the file's side.
  await fileSizes(git, d);
});

test("a submodule named like an image has no size and no bytes", async () => {
  withSubmodule('pic.png');
  const git = await Git.open(t.dir);
  const d = await commitDiff(git, t.git('rev-parse', 'HEAD'));
  const k = d.files.findIndex((f) => f.path === 'pic.png');
  assert.deepEqual((await fileSizes(git, d)).get(k) ?? {}, {});
});

test('the working tree lists a moved submodule at the commit it has checked out, and stages it whole', async () => {
  const { s } = withSubmodule();
  inLib('checkout', '-q', s[2]);
  const f = (await listed())!;
  assert.equal(f.status, 'M');
  assert.equal(f.newSha, s[2]);
  assert.equal(f.stage, 'none');
  assert.equal(f.submodule!.old, s[0]);
  assert.equal(f.submodule!.new, s[2]);
  assert.equal(f.submodule!.dirty, undefined);
  assert.match(f.submodule!.url!, /legit-sub-/);

  const repo = await Repo.open(t.dir);
  // Picking one of its lines picks all of it.
  await repo.stage({ key: await snapshot(repo), selection: { lib: [1] } });
  assert.equal(t.git('rev-parse', ':lib'), s[2]);
  const staged = (await listed())!;
  assert.equal(staged.stage, 'all');
  assert.equal(staged.unshown, undefined);
  await repo.unstage({ key: await snapshot(repo), selection: { lib: 'all' } });
  assert.equal(t.git('rev-parse', ':lib'), s[0]);
  assert.equal((await listed())!.stage, 'none');
  // Staged at another commit than the one checked out.
  inLib('checkout', '-q', s[1]);
  t.git('add', 'lib');
  inLib('checkout', '-q', s[2]);
  const other = (await listed())!;
  assert.equal(other.stage, 'some');
  assert.match(other.unshown!, /Staged at commit/);
});

test("a submodule with changes only inside it shows them, and has nothing to stage", async () => {
  const { s } = withSubmodule();
  writeFileSync(join(t.dir, 'lib', 's.txt'), 'changed\n');
  let f = (await listed())!;
  assert.deepEqual([f.hunks.length, f.added, f.removed, f.stage], [0, 0, 0, 'none']);
  assert.deepEqual(f.submodule, { old: s[0], new: s[0], dirty: { modified: true, untracked: false }, url: f.submodule!.url });
  assert.match(f.unshown!, /inside the submodule/);
  const repo = await Repo.open(t.dir);
  await assert.rejects(repo.stage({ key: await snapshot(repo), selection: { lib: 'all' } }), /inside the submodule/);
  assert.equal(t.git('rev-parse', ':lib'), s[0]);

  inLib('checkout', '-q', 's.txt');
  writeFileSync(join(t.dir, 'lib', 'new.txt'), 'new\n');
  f = (await listed())!;
  assert.deepEqual(f.submodule!.dirty, { modified: false, untracked: true });

  // Moved and dirty: the move is what's staged.
  inLib('checkout', '-q', s[1]);
  writeFileSync(join(t.dir, 'lib', 's.txt'), 'changed\n');
  f = (await listed())!;
  assert.equal(f.submodule!.new, s[1]);
  assert.deepEqual(f.submodule!.dirty, { modified: true, untracked: true });
  assert.deepEqual([f.added, f.removed], [1, 1]);
  await repo.stage({ key: await snapshot(repo), selection: { lib: 'all' } });
  assert.equal(t.git('rev-parse', ':lib'), s[1]);
  assert.equal((await listed())!.stage, 'all');
});

test("a submodule that isn't checked out isn't listed as changed, and has no head", async () => {
  withSubmodule();
  t.git('submodule', '-q', 'deinit', '-f', 'lib');
  assert.equal(await listed(), undefined);
  const git = await Git.open(t.dir);
  assert.equal(await submoduleHead(git, 'lib'), null);
  assert.equal((await submodulePaths(git)).get('lib')?.name, 'lib');
});

test('an untracked nested repository is listed as a submodule to add, and staging adds it with its URL', async () => {
  t.commit('a', { 'a.txt': 'a\n' });
  const nested = join(t.dir, 'nested');
  mkdirSync(nested);
  t.gitIn(nested, 'init', '-q', '-b', 'main');
  let f = (await listed('nested'))!;
  assert.deepEqual([f.status, f.newMode, f.untracked, f.submodule!.nested], ['A', '160000', true, true]);
  assert.match(f.unshown!, /no commit yet/);
  const repo = await Repo.open(t.dir);
  await assert.rejects(repo.stage({ key: await snapshot(repo), selection: { nested: 'all' } }), /no commit yet/);

  writeFileSync(join(nested, 'n.txt'), 'n\n');
  t.gitIn(nested, 'add', '.');
  t.gitIn(nested, 'commit', '-qm', 'n');
  const head = t.gitIn(nested, 'rev-parse', 'HEAD');
  f = (await listed('nested'))!;
  assert.equal(f.submodule!.new, head);
  assert.equal(f.submodule!.url, undefined);
  await assert.rejects(repo.stage({ key: await snapshot(repo), selection: { nested: 'all' } }), /no remote/);
  assert.equal(t.git('ls-files', '-s', 'nested'), '');

  t.gitIn(nested, 'remote', 'add', 'origin', 'https://example.com/nested.git');
  f = (await listed('nested'))!;
  assert.equal(f.submodule!.url, 'https://example.com/nested.git');
  await repo.stage({ key: await snapshot(repo), selection: { nested: 'all' } });
  assert.equal(t.git('ls-files', '-s', 'nested'), `160000 ${head} 0\tnested`);
  assert.equal(t.git('config', '-f', '.gitmodules', 'submodule.nested.url'), 'https://example.com/nested.git');
  // In place: still its own repository, at the same commit.
  assert.equal(t.gitIn(nested, 'rev-parse', 'HEAD'), head);
  const added = (await listed('nested'))!;
  assert.equal(added.stage, 'all');
  assert.equal(added.untracked, undefined);
});

test('splitting or taking out a submodule change moves it whole', async () => {
  const { s } = withSubmodule();
  inLib('checkout', '-q', s[1]);
  t.write('a.txt', 'a\nb\n');
  t.git('commit', '-qam', 'bump and more');
  const repo = await Repo.open(t.dir);
  await repo.split({ sha: t.git('rev-parse', 'HEAD'), selection: { lib: [0] }, message: 'bump', before: true });
  assert.equal(t.git('log', '--format=%s', '-2'), 'bump and more\nbump');
  assert.equal(t.git('rev-parse', 'HEAD~1:lib'), s[1]);
  assert.equal(t.git('rev-parse', 'HEAD~1:a.txt'), t.git('rev-parse', 'HEAD~2:a.txt'));

  inLib('checkout', '-q', s[2]);
  t.git('commit', '-qam', 'bump again');
  await repo.removeChanges({ sha: t.git('rev-parse', 'HEAD'), selection: { lib: [1] } });
  assert.equal(t.git('rev-parse', 'HEAD:lib'), s[1]);
});

test("a submodule's log lists the commits between two of its commits, either way", async () => {
  const { s } = withSubmodule();
  const git = await Git.open(t.dir);
  const subjects = (l: { subject: string }[]) => l.map((c) => c.subject);
  const up = await submoduleLog(git, 'lib', s[0], s[2]);
  assert.deepEqual([subjects(up.added), subjects(up.removed), up.more], [['s3', 's2'], [], { added: 0, removed: 0 }]);
  assert.equal(up.added[0].sha, s[2]);
  assert.ok(up.added[0].time > 0);
  const down = await submoduleLog(git, 'lib', s[2], s[0]);
  assert.deepEqual([subjects(down.added), subjects(down.removed)], [[], ['s3', 's2']]);
  // Added: its history so far.
  assert.deepEqual(subjects((await submoduleLog(git, 'lib', null, s[1])).added), ['s2', 's1']);
  // A commit it doesn't have, and one it can't look at.
  assert.equal((await submoduleLog(git, 'lib', s[0], 'f'.repeat(40))).unavailable, 'missing-commit');
  await assert.rejects(submoduleLog(git, 'a.txt', s[0], s[1]), /isn't a submodule/);
  await assert.rejects(submoduleLog(git, '../x', s[0], s[1]), /isn't a submodule/);
  await assert.rejects(submoduleLog(git, 'lib', 'HEAD', s[1]), /Which commits/);
  t.git('submodule', '-q', 'deinit', '-f', 'lib');
  assert.equal((await submoduleLog(git, 'lib', s[0], s[2])).added.length, 2, 'kept once read');
  assert.equal((await submoduleLog(git, 'lib', s[1], s[2])).unavailable, 'not-checked-out');
});

test('a repository without submodules reads no .gitmodules', async () => {
  t.commit('a', { 'a.txt': 'a\n' });
  const git = await Git.open(t.dir);
  assert.equal((await submodulePaths(git)).size, 0);
  const f: FileDiff | undefined = await listed('a.txt');
  assert.equal(f, undefined);
});
