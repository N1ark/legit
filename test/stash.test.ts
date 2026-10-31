import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { Repo } from '../src/server/repo.ts';
import { stash, stashApply, stashDrop, stashPop, stashes } from '../src/server/stash.ts';
import { abortOp, conflictDiff, continueOp, markResolved } from '../src/server/sync.ts';
import { setup } from './util.ts';

const t = setup();
const { git, commit, write, read, exists } = t;
const stashList = () => git('stash', 'list', '--format=%H').split('\n').filter(Boolean);

test('stash and pop on the same commit brings everything back, staged changes included', async () => {
  commit('base', { f: '1\n', g: '1\n' });
  write('f', '2\n');
  write('g', '2\n');
  git('add', 'g');
  write('new', 'untracked\n');
  const repo = await Repo.open(t.dir);
  await assert.rejects(repo.switchBranch({ branch: 'nope', stash: true }), /No local branch/);
  assert.deepEqual(stashList(), []);

  let st = (await stash(repo)).state;
  assert.deepEqual(st.work, { staged: 0, unstaged: 0, untracked: 0 });
  assert.equal(st.stashed?.branch, 'main');
  assert.equal(st.stashed?.legit, true);
  await assert.rejects(stash(repo), /no changes to stash/);

  st = (await stashPop(repo, { sha: st.stashed!.sha })).state;
  assert.equal(read('f'), '2\n');
  assert.equal(read('new'), 'untracked\n');
  assert.equal(git('diff', '--cached', '--name-only'), 'g');
  assert.equal(st.stashed, null);
  assert.deepEqual(stashList(), []);
  // Popped, but kept.
  const { entries, dropped } = await stashes(repo.git);
  assert.deepEqual(entries, []);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].label, 'pop');
  assert.match(dropped[0].ref, /^refs\/legit\/stashes\/\d{13}-pop$/);
  assert.match(dropped[0].message, /legit: on main/);
});

test('apply refuses when uncommitted changes overlap, and when files it creates exist', async () => {
  commit('base', { f: '1\n', g: '1\n' });
  write('f', 'stashed\n');
  write('new', 'stashed\n');
  const repo = await Repo.open(t.dir);
  const sha = (await stash(repo)).state.stashed!.sha;

  write('f', 'other\n');
  await assert.rejects(stashApply(repo, { sha }), /uncommitted changes to files the stash also changes: f\. .*Nothing was changed/);
  assert.equal(read('f'), 'other\n');
  git('checkout', '--', 'f');

  write('new', 'mine\n');
  await assert.rejects(stashPop(repo, { sha }), /would create files that already exist: new/);
  assert.equal(read('new'), 'mine\n');
  assert.equal(read('f'), '1\n');
  assert.deepEqual(stashList(), [sha]);

  // Unrelated changes are fine.
  git('clean', '-qf');
  write('g', 'unrelated\n');
  await stashPop(repo, { sha });
  assert.deepEqual([read('f'), read('g'), read('new')], ['stashed\n', 'unrelated\n', 'stashed\n']);
});

test('apply refuses a stash that would conflict with the branch, leaving no conflict markers', async () => {
  commit('base', { f: '1\n2\n3\n', g: '1\n' });
  git('branch', 'other');
  write('f', '1\nmine\n3\n');
  write('g', '2\n');
  const repo = await Repo.open(t.dir);
  await repo.switchBranch({ branch: 'other', stash: true });
  commit('theirs', { f: '1\ntheirs\n3\n' });
  const entry = (await stashes(repo.git)).entries[0];
  await assert.rejects(stashPop(repo, { sha: entry.sha }), (e: Error & { code?: string }) =>
    e.code === 'stash-conflicts' && /conflicts with this branch in: f\. Nothing was changed; the stash is kept\. Restore it anyway/.test(e.message),
  );
  await assert.rejects(stashApply(repo, { sha: entry.sha }), /Apply it anyway/);
  assert.equal(read('f'), '1\ntheirs\n3\n');
  assert.equal(git('status', '--porcelain'), '');
  assert.deepEqual(stashList(), [entry.sha]);

  // On a branch where it merges cleanly, it applies (as unstaged changes).
  commit('theirs elsewhere', { f: '1\n2\n3\ntheirs\n' });
  await stashPop(repo, { sha: entry.sha });
  assert.equal(read('f'), '1\nmine\n3\ntheirs\n');
  assert.equal(read('g'), '2\n');
  assert.deepEqual(stashList(), []);
});

test("a stash's untracked file that the branch now tracks is refused", async () => {
  commit('base', { f: '1\n' });
  git('branch', 'other');
  write('new', 'mine\n');
  const repo = await Repo.open(t.dir);
  await repo.switchBranch({ branch: 'other', stash: true });
  commit('adds new', { new: 'theirs\n' });
  const sha = stashList()[0];
  await assert.rejects(stashApply(repo, { sha }), /already exist: new/);
  assert.equal(read('new'), 'theirs\n');
});

test('drop keeps the stash under refs/legit/stashes, from where it can still be applied', async () => {
  commit('base', { f: '1\n' });
  write('f', 'first\n');
  git('stash', 'push', '-q', '-m', 'not legit');
  const first = stashList()[0];
  write('f', 'second\n');
  const repo = await Repo.open(t.dir);
  const second = (await stash(repo)).state.stashed!.sha;
  assert.deepEqual(stashList(), [second, first]);

  let s = await stashes(repo.git);
  assert.deepEqual(s.entries.map((e) => [e.sha, e.legit, e.branch, e.files]), [[second, true, 'main', ['f']], [first, false, null, ['f']]]);

  // Dropping the older one (stash@{1}) leaves the newer one alone.
  await stashDrop(repo, { sha: first });
  assert.deepEqual(stashList(), [second]);
  await assert.rejects(stashDrop(repo, { sha: first }), /no longer in the stash list|no longer there/);
  await assert.rejects(stashPop(repo, { sha: first }), /no longer there/);
  await assert.rejects(stashApply(repo, { sha: git('rev-parse', 'HEAD') }), /no longer there/);

  s = await stashes(repo.git);
  assert.deepEqual(s.dropped.map((d) => [d.sha, d.label]), [[first, 'drop']]);
  await stashApply(repo, { sha: first });
  assert.equal(read('f'), 'first\n');
  // Applying keeps it where it was.
  assert.equal((await stashes(repo.git)).dropped.length, 1);
});

test("a stash's diff: staged and unstaged changes, then its untracked files", async () => {
  commit('base', { f: '1\n', g: '1\n' });
  write('f', '2\n');
  write('g', '2\n');
  git('add', 'g');
  write('new', 'untracked\n');
  const repo = await Repo.open(t.dir);
  await stash(repo);
  const sha = stashList()[0];
  const d = await repo.diff(`s${sha}`);
  assert.equal(d.sha, `s${sha}`);
  assert.deepEqual(d.files.map((f) => [f.path, f.status, !!f.untracked, f.added, f.removed]), [
    ['f', 'M', false, 1, 1],
    ['g', 'M', false, 1, 1],
    ['new', 'A', true, 1, 0],
  ]);
  await assert.rejects(repo.diff(`s${git('rev-parse', 'HEAD')}`), /not a stash/);
});

test('the stash list follows stashes made, dropped and cleared from a terminal', async () => {
  commit('base', { f: '1\n' });
  const repo = await Repo.open(t.dir);
  const listed = async () => (await stashes(repo.git)).entries.map((e) => e.sha);
  assert.deepEqual(await listed(), []);
  for (const v of ['a', 'b', 'c']) {
    write('f', `${v}\n`);
    git('stash', 'push', '-q', '-m', v);
    assert.deepEqual(await listed(), stashList());
  }
  // The middle one: refs/stash stays the same, only its reflog is rewritten.
  git('stash', 'drop', '-q', 'stash@{1}');
  assert.deepEqual(await listed(), stashList());
  assert.equal(stashList().length, 2);
  git('stash', 'clear');
  assert.deepEqual(await listed(), []);
});

/** A stash left on main that conflicts with `other` in f, with an untracked file and folder, plus unrelated changes on other. */
async function conflicting() {
  commit('base', { f: '1\n2\n3\n', g: '1\n', h: '1\n', s: '1\n' });
  git('branch', 'other');
  write('f', '1\nmine\n3\n');
  write('g', '2\n');
  write('new', 'untracked\n');
  t.git('stash', 'push', '-q', '--include-untracked', '-m', 'legit: on main');
  git('switch', '-q', 'other');
  commit('theirs', { f: '1\ntheirs\n3\n' });
  // Unrelated: one unstaged change, one staged.
  write('h', 'unrelated\n');
  write('s', 'staged\n');
  git('add', 's');
  return { repo: await Repo.open(t.dir), sha: stashList()[0] };
}

test('a stash that conflicts is restored anyway when asked: resolve, then done', async () => {
  const { repo, sha } = await conflicting();
  let st = (await stashPop(repo, { sha, conflicts: true })).state;
  assert.match(read('f'), /^1\n<<<<<<< .*\ntheirs\n=======\nmine\n>>>>>>> .*\n3\n$/);
  assert.deepEqual([read('g'), read('new'), read('h')], ['2\n', 'untracked\n', 'unrelated\n']);
  assert.equal(git('ls-files', '-u', '--', 'f').split('\n').length, 3);
  const c = st.conflict!;
  assert.equal(c.kind, 'stash');
  assert.deepEqual(c.stash, { sha, pop: true });
  assert.equal(c.title, 'Restoring the changes left on main');
  assert.deepEqual(c.files.map((f) => [f.path, f.markers]), [['f', true]]);
  // Only the stash's own files, not the change staged before.
  assert.deepEqual(c.resolved, ['g']);
  assert.match(st.blocked!, /stash is being restored/);
  assert.deepEqual((await conflictDiff(repo)).files.map((f) => f.path), ['f', 'g', 'new']);
  // Popped, and kept.
  assert.deepEqual(stashList(), []);
  assert.deepEqual((await stashes(repo.git)).dropped.map((d) => [d.sha, d.label]), [[sha, 'pop']]);
  await assert.rejects(stash(repo), /stash is being restored/);

  await assert.rejects(continueOp(repo), /Still conflicted: f/);
  write('f', '1\nboth\n3\n');
  st = (await markResolved(repo, { path: 'f' })).state;
  assert.deepEqual(st.conflict?.files, []);
  const r = await continueOp(repo);
  assert.equal(r.state.conflict, null);
  assert.equal(r.state.blocked, null);
  assert.match(r.message, /Restored the changes left on main; the stash stays under "Dropped or restored"/);
  // Its changes unstaged, as a clean restore leaves them; the unrelated ones as they were.
  assert.equal(git('diff', '--name-only'), 'f\ng\nh');
  assert.equal(git('diff', '--cached', '--name-only'), 's');
  assert.deepEqual([read('f'), read('new')], ['1\nboth\n3\n', 'untracked\n']);
  assert.deepEqual((await stashes(repo.git)).dropped.map((d) => d.sha), [sha]);
});

test('aborting a stash restored with conflicts puts its files back, and it back in the list', async () => {
  const { repo, sha } = await conflicting();
  await stashPop(repo, { sha, conflicts: true });
  write('f', 'half resolved\n');
  const r = await abortOp(repo);
  assert.equal(r.state.conflict, null);
  assert.equal(r.state.blocked, null);
  assert.match(r.message, /Undid restoring the changes left on main.*The stash is back in the list\. .*saved first, as refs\/legit\/aborted\/other\//);
  assert.deepEqual([read('f'), read('g'), exists('new')], ['1\ntheirs\n3\n', '1\n', false]);
  // Other uncommitted changes stay.
  assert.equal(git('status', '--porcelain'), 'M h\nM  s');
  assert.deepEqual(stashList(), [sha]);
  assert.equal(git('stash', 'list', '--format=%gs'), 'On main: legit: on main');
  assert.deepEqual((await stashes(repo.git)).dropped, []);
  const saved = git('for-each-ref', '--format=%(refname)', 'refs/legit/aborted/other/');
  assert.match(saved, /-stash$/);
  assert.equal(git('show', `${saved}:f`), 'half resolved');
  assert.equal(git('show', `${saved}:new`), 'untracked');

  // Applied (kept in the list): aborting leaves the list alone.
  const st = (await stashApply(repo, { sha, conflicts: true })).state;
  assert.equal(st.conflict?.title, 'Applying the changes left on main');
  assert.deepEqual(st.conflict?.stash, { sha, pop: false });
  assert.match((await abortOp(repo)).message, /The stash is still in the list\./);
  assert.deepEqual(stashList(), [sha]);
  assert.equal(git('status', '--porcelain'), 'M h\nM  s');
});

test('aborting removes the folders the stash created', async () => {
  commit('base', { f: '1\n' });
  write('f', 'mine\n');
  mkdirSync(`${t.dir}/d/e`, { recursive: true });
  write('d/e/n', 'new\n');
  git('stash', 'push', '-q', '--include-untracked', '-m', 'x');
  commit('theirs', { f: 'theirs\n' });
  const repo = await Repo.open(t.dir);
  await stashApply(repo, { sha: stashList()[0], conflicts: true });
  assert.equal(read('d/e/n'), 'new\n');
  assert.equal((await repo.state()).conflict?.title, 'Applying the stash "x"');
  await abortOp(repo);
  assert.equal(exists('d'), false);
  assert.equal(git('status', '--porcelain'), '');
});

test('aborting puts back a file the branch renamed, that the stash changed under its old name', async () => {
  const lines = (x: string) => ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((l) => (l === 'd' ? x : l)).join('\n') + '\n';
  commit('base', { old: lines('d') });
  write('old', lines('mine'));
  git('stash', 'push', '-q');
  git('mv', 'old', 'renamed');
  commit('rename', { renamed: lines('theirs') });
  const repo = await Repo.open(t.dir);
  const c = (await stashApply(repo, { sha: stashList()[0], conflicts: true })).state.conflict!;
  assert.deepEqual(c.files.map((f) => f.path), ['renamed']);
  await abortOp(repo);
  assert.equal(read('renamed'), lines('theirs'));
  assert.equal(git('status', '--porcelain'), '');
});

test('unmerged files left by a terminal `git stash pop` show as conflicts, without abort', async () => {
  commit('base', { f: '1\n' });
  write('f', 'mine\n');
  git('stash', 'push', '-q');
  commit('theirs', { f: 'theirs\n' });
  assert.throws(() => git('stash', 'pop'));
  const repo = await Repo.open(t.dir);
  const c = (await repo.state()).conflict!;
  assert.equal(c.kind, 'stash');
  assert.equal(c.stash, null);
  assert.deepEqual(c.files.map((f) => f.path), ['f']);
  await assert.rejects(abortOp(repo), /weren't left by legit/);
  write('f', 'both\n');
  const st = (await markResolved(repo, { path: 'f' })).state;
  assert.equal(st.conflict, null);
});
