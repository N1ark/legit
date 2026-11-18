// Submodules following what legit does (follow.ts), discarding and restoring their commits,
// resolving their conflicts, cloning with them, and stashing around them.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

// Local paths as submodule URLs: git refuses the file protocol for submodules by default.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Ann', GIT_AUTHOR_EMAIL: 'ann@x.org', GIT_COMMITTER_NAME: 'Ann', GIT_COMMITTER_EMAIL: 'ann@x.org',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always',
});

const { Repo } = await import('../src/server/repo.ts');
const { Git } = await import('../src/server/git.ts');
const { switchBranch } = await import('../src/server/branches.ts');
const { conflictDiff, mergeBranch, continueOp, resolveSubmodule } = await import('../src/server/sync.ts');
const { discard, restoreDiscarded } = await import('../src/server/discard.ts');
const { stash } = await import('../src/server/stash.ts');
const { cloneRepo } = await import('../src/server/clone.ts');
const { followSubmodules, submoduleSnapshot } = await import('../src/server/follow.ts');

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'legit-sub-'));
  dirs.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const commitIn = (cwd: string, msg: string, files: Record<string, string>) => {
  for (const [f, s] of Object.entries(files)) writeFileSync(join(cwd, f), s);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', msg);
  return git(cwd, 'rev-parse', 'HEAD');
};
const repoAt = (path: string) => {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  return path;
};

let root = '';
let up = '';
let sup = '';
let lib = '';
let s: string[] = [];

/** `up`: a repo with commits s1..s3 (s[1..3]); `sup`: main with `lib` at s2, branch `old` with it at s1. */
beforeEach(() => {
  root = tmp();
  up = repoAt(join(root, 'up'));
  s = ['', commitIn(up, 's1', { 's.txt': '1\n' }), commitIn(up, 's2', { 's.txt': '2\n' }), commitIn(up, 's3', { 's.txt': '3\n' })];
  sup = repoAt(join(root, 'sup'));
  commitIn(sup, 'a', { 'a.txt': 'a\n' });
  git(sup, 'submodule', '-q', 'add', up, 'lib');
  lib = join(sup, 'lib');
  git(lib, 'checkout', '-q', s[1]);
  git(sup, 'add', 'lib');
  git(sup, 'commit', '-qm', 'lib at s1');
  git(sup, 'branch', 'old');
  git(lib, 'checkout', '-q', s[2]);
  git(sup, 'commit', '-qam', 'lib at s2');
});

const at = (dir = lib) => git(dir, 'rev-parse', 'HEAD');
const status = () => git(sup, 'status', '--porcelain');

test('switching branch checks out the submodule commit the branch has, and back', async () => {
  const repo = await Repo.open(sup);
  await switchBranch(repo, { branch: 'old' });
  assert.equal(at(), s[1]);
  assert.equal(status(), '');
  await switchBranch(repo, { branch: 'main' });
  assert.equal(at(), s[2]);
  assert.equal(status(), '');
});

test('a submodule you moved, or whose changes are in the way, stays as it is, with a note', async () => {
  const repo = await Repo.open(sup);
  git(lib, 'checkout', '-q', s[3]);
  const r = await switchBranch(repo, { branch: 'old' });
  assert.equal(at(), s[3]);
  assert.match(r.note ?? '', /Submodule lib stays at .{7}, which you checked out/);
  git(lib, 'checkout', '-q', s[2]);
  await switchBranch(repo, { branch: 'main' });
  writeFileSync(join(lib, 's.txt'), 'mine\n');
  const r2 = await switchBranch(repo, { branch: 'old' });
  assert.equal(at(), s[2]);
  assert.match(r2.note ?? '', /its own changes are in the way/);
  assert.equal(git(lib, 'status', '--porcelain'), 'M s.txt');
});

test('dropping the commit that moved a submodule moves it back, and undo forward again', async () => {
  const repo = await Repo.open(sup);
  await repo.drop({ shas: [git(sup, 'rev-parse', 'HEAD')] });
  assert.equal(at(), s[1]);
  assert.equal(status(), '');
  await repo.undo();
  assert.equal(at(), s[2]);
  assert.equal(status(), '');
});

test('merging a branch that moved a submodule checks out its commit', async () => {
  git(sup, 'checkout', '-q', '-b', 'next');
  git(lib, 'checkout', '-q', s[3]);
  git(sup, 'commit', '-qam', 'lib at s3');
  git(sup, 'checkout', '-q', 'main');
  git(lib, 'checkout', '-q', s[2]);
  const repo = await Repo.open(sup);
  await mergeBranch(repo, { branch: 'next' });
  assert.equal(at(), s[3]);
  assert.equal(status(), '');
});

test('nested submodules follow too', async () => {
  const inner = repoAt(join(root, 'inner'));
  const i1 = commitIn(inner, 'i1', { 'i.txt': '1\n' });
  const i2 = commitIn(inner, 'i2', { 'i.txt': '2\n' });
  const mid = repoAt(join(root, 'mid'));
  commitIn(mid, 'm', { 'm.txt': 'm\n' });
  git(mid, 'submodule', '-q', 'add', inner, 'in');
  git(join(mid, 'in'), 'checkout', '-q', i1);
  git(mid, 'add', 'in');
  git(mid, 'commit', '-qm', 'in at i1');
  const m1 = at(mid);
  git(join(mid, 'in'), 'checkout', '-q', i2);
  git(mid, 'commit', '-qam', 'in at i2');
  const m2 = at(mid);
  const top = repoAt(join(root, 'top'));
  commitIn(top, 't', { 't.txt': 't\n' });
  git(top, 'submodule', '-q', 'add', mid, 'mid');
  git(top, 'submodule', '-q', 'update', '--init', '--recursive');
  git(top, 'commit', '-qm', 'mid at m2');
  git(join(top, 'mid'), 'checkout', '-q', m1);
  git(join(top, 'mid'), 'submodule', '-q', 'update');
  git(top, 'commit', '-qam', 'mid at m1');
  const t = await Git.open(top);
  const before = await submoduleSnapshot(t);
  git(top, 'reset', '-q', 'HEAD~');
  const r = await followSubmodules(before);
  assert.deepEqual(r.notes, []);
  assert.equal(at(join(top, 'mid')), m2);
  assert.equal(at(join(top, 'mid', 'in')), i2);
  assert.equal(git(top, 'status', '--porcelain'), '');
});

test('a repo without submodules is snapshotted without running git', async () => {
  const plain = repoAt(join(root, 'plain'));
  commitIn(plain, 'p', { p: 'p\n' });
  const g = await Git.open(plain);
  const run = g.run.bind(g);
  let ran = 0;
  g.run = (...a: Parameters<typeof run>) => (ran++, run(...a));
  assert.equal(await submoduleSnapshot(g), null);
  assert.equal(ran, 0);
});

test("a submodule's folder goes with a branch that hasn't it, only when nothing in it would be lost", async () => {
  git(sup, 'checkout', '-q', '-b', 'none');
  git(sup, 'rm', '-q', 'lib');
  git(sup, 'commit', '-qm', 'no lib');
  git(sup, 'checkout', '-q', 'main');
  git(sup, 'submodule', '-q', 'update');
  const repo = await Repo.open(sup);
  await switchBranch(repo, { branch: 'none' });
  assert.equal(existsSync(lib), false);
  assert.equal(status(), '');
  // Back: it was initialized here, so it's checked out again.
  await switchBranch(repo, { branch: 'main' });
  assert.equal(at(), s[2]);
  writeFileSync(join(lib, 'new.txt'), 'new\n');
  const r = await switchBranch(repo, { branch: 'none' });
  assert.equal(existsSync(join(lib, 'new.txt')), true);
  assert.match(r.note ?? '', /its folder stays/);
});

test("discarding a submodule's commit checks out HEAD's, keeping the other; restoring brings it back", async () => {
  const repo = await Repo.open(sup);
  git(lib, 'checkout', '-q', s[3]);
  const w = await repo.work();
  const d = await discard(repo, { key: w.sha, selection: { lib: 'all' } });
  assert.equal(at(), s[2]);
  assert.equal(status(), '');
  assert.equal(git(lib, 'for-each-ref', '--format=%(objectname)', 'refs/legit/discarded/'), s[3]);
  await restoreDiscarded(repo, { ref: d.ref! });
  assert.equal(at(), s[3]);
  assert.equal(status(), 'M lib');
});

test('a staged submodule commit is discarded from the index too', async () => {
  const repo = await Repo.open(sup);
  git(lib, 'checkout', '-q', s[3]);
  git(sup, 'add', 'lib');
  const w = await repo.work();
  await discard(repo, { key: w.sha, selection: { lib: 'all' } });
  assert.equal(at(), s[2]);
  assert.equal(status(), '');
});

test('discarding a submodule with changes of its own is refused', async () => {
  const repo = await Repo.open(sup);
  git(lib, 'checkout', '-q', s[3]);
  writeFileSync(join(lib, 's.txt'), 'mine\n');
  const w = await repo.work();
  await assert.rejects(discard(repo, { key: w.sha, selection: { lib: 'all' } }), /has changes of its own.*Nothing was discarded/);
  assert.equal(at(), s[3]);
});

/** main has lib at a, branch `side` at b: both children of s1, so merging conflicts. */
async function conflicted() {
  git(lib, 'checkout', '-q', s[1]);
  const a = commitIn(lib, 'a', { 'a.txt': 'a\n' });
  git(lib, 'checkout', '-q', s[1]);
  const b = commitIn(lib, 'b', { 'b.txt': 'b\n' });
  git(sup, 'checkout', '-q', '-b', 'side');
  git(sup, 'commit', '-qam', 'lib at b');
  git(sup, 'checkout', '-q', 'main');
  git(lib, 'checkout', '-q', a);
  git(sup, 'commit', '-qam', 'lib at a');
  const repo = await Repo.open(sup);
  await mergeBranch(repo, { branch: 'side' }).catch(() => null);
  return { repo, a, b };
}

test('a submodule conflict lists both commits, and resolves to the side picked, checked out', async () => {
  const { repo, a, b } = await conflicted();
  const f = (await repo.state()).conflict!.files.find((x) => x.path === 'lib')!;
  assert.deepEqual(f.submodule, { base: s[2], ours: a, theirs: b, checkedOut: a });
  assert.equal(f.markers, false);
  // What finishing would commit: the submodule at what's checked out.
  const d = await conflictDiff(repo);
  assert.deepEqual(d.files.map((x) => [x.path, x.conflicted]), [['lib', true]]);
  await resolveSubmodule(repo, { path: 'lib', side: 'theirs' });
  assert.equal(at(), b);
  assert.equal((await repo.state()).conflict!.files.length, 0);
  await continueOp(repo);
  assert.equal(git(sup, 'rev-parse', 'HEAD:lib'), b);
  assert.equal(status(), '');
});

test('resolving to ours, or to what is checked out, keeps the checkout', async () => {
  const { repo, a } = await conflicted();
  await resolveSubmodule(repo, { path: 'lib', side: 'ours' });
  assert.equal(at(), a);
  assert.equal(git(sup, 'ls-files', '-s', 'lib').split(' ')[1], a);
  await assert.rejects(resolveSubmodule(repo, { path: 'lib' }), /isn't a conflicted submodule/);
});

test('cloning brings the submodules along', async () => {
  const repo = await Repo.open(sup);
  const dest = join(root, 'copy');
  const r = await cloneRepo(repo, { url: sup, path: dest });
  assert.equal(r.path, dest);
  assert.equal(at(join(dest, 'lib')), s[2]);
  assert.equal(git(dest, 'status', '--porcelain'), '');
});

test('stashing only submodule changes says git does not stash them, and leaves them be', async () => {
  const repo = await Repo.open(sup);
  git(lib, 'checkout', '-q', s[3]);
  await assert.rejects(stash(repo), /git doesn't stash those/);
  writeFileSync(join(sup, 'a.txt'), 'b\n');
  await stash(repo);
  assert.equal(at(), s[3]);
  assert.equal(status(), 'M lib');
});

test('unstaging a submodule commit never moves its checkout', async () => {
  const repo = await Repo.open(sup);
  git(lib, 'checkout', '-q', s[3]);
  git(sup, 'add', 'lib');
  const w = await repo.work();
  await repo.unstage({ key: w.sha, selection: { lib: 'all' } });
  assert.equal(at(), s[3]);
  assert.equal(git(sup, 'diff', '--cached', '--name-only'), '');
});
