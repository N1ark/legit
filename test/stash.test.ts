import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Repo } from '../src/server/repo.ts';
import { stash, stashApply, stashDrop, stashPop, stashes } from '../src/server/stash.ts';
import { setup } from './util.ts';

const t = setup();
const { git, commit, write, read } = t;
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
  await assert.rejects(stashPop(repo, { sha: entry.sha }), /conflicts with this branch in: f\. Nothing was changed; the stash is kept/);
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
