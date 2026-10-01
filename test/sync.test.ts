import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { Repo } from '../src/server/repo.ts';
import { abortOp, conflictDiff, continueOp, fetchRemote, markResolved, mergeBranch, pull, rebaseBranch } from '../src/server/sync.ts';

// The engine's own git processes see this too.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Ann', GIT_AUTHOR_EMAIL: 'ann@x.org', GIT_COMMITTER_NAME: 'Ann', GIT_COMMITTER_EMAIL: 'ann@x.org',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
});

let dir = '';
let remote = '';
let other = '';
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (...args: string[]) => run(dir, ...args);
const og = (...args: string[]) => run(other, ...args);
const write = (f: string, s: string, root = dir) => writeFileSync(join(root, f), s);
const read = (f: string) => readFileSync(join(dir, f), 'utf8');
const commit = (msg: string, files: Record<string, string>, root = dir) => {
  for (const [f, s] of Object.entries(files)) write(f, s, root);
  run(root, 'add', '-A');
  run(root, 'commit', '-qm', msg);
  return run(root, 'rev-parse', 'HEAD');
};
const log = (rev = 'HEAD') => git('log', '--format=%s', rev).split('\n');
const tmp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `legit-${name}-`));
  dirs.push(d);
  return d;
};
/** Someone else pushes `files` to the remote's main. */
const theyPush = (msg: string, files: Record<string, string>) => {
  og('pull', '-q', '--ff-only');
  const sha = commit(msg, files, other);
  og('push', '-q', 'origin', 'main');
  return sha;
};

beforeEach(() => {
  dir = tmp('test');
  remote = tmp('remote');
  other = tmp('other');
  git('init', '-q', '-b', 'main');
  run(remote, 'init', '-q', '--bare', '-b', 'main');
  commit('base', { f: '1\n2\n3\n', g: 'g\n' });
  git('remote', 'add', 'origin', remote);
  git('push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', remote, other]);
});

test('fetch: updates remote-tracking refs and the fetch time, and fails cleanly', async () => {
  const repo = await Repo.open(dir);
  const theirs = theyPush('theirs', { t: '1\n' });
  const head = git('rev-parse', 'HEAD');
  const r = await fetchRemote(repo);
  assert.equal(git('rev-parse', 'origin/main'), theirs);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(r.state.push?.behind, 1);
  assert.ok(r.state.fetchedAt && Date.now() - r.state.fetchedAt < 60_000);
  // A fetch that brings nothing new still counts as a fetch.
  const first = r.state.fetchedAt;
  await new Promise((done) => setTimeout(done, 20));
  assert.ok((await fetchRemote(repo)).state.fetchedAt! >= first);

  // Unreachable remotes fail (quickly, without prompting); no remote at all is refused.
  git('remote', 'set-url', 'origin', 'ssh://git@nonexistent.invalid/x.git');
  await assert.rejects(fetchRemote(repo), /Couldn't fetch from origin; nothing was changed/);
  git('remote', 'remove', 'origin');
  await assert.rejects(fetchRemote(repo), /no remote/);
});

test('pull fast-forwards, carrying local changes along, and can be undone', async () => {
  const repo = await Repo.open(dir);
  const base = git('rev-parse', 'HEAD');
  const theirs = theyPush('theirs', { t: '1\n', f: '1\n2\n3\n4\n' });
  write('g', 'local\n');
  write('new', 'untracked\n');
  const r = await pull(repo, {});
  assert.match(r.message, /Fast-forwarded main to origin\/main \(1 new commit\)/);
  assert.equal(git('rev-parse', 'HEAD'), theirs);
  assert.equal(read('t'), '1\n');
  assert.equal(read('g'), 'local\n');
  assert.equal(read('new'), 'untracked\n');
  assert.ok((await repo.backups()).some((b) => b.label === 'pull' && b.sha === base));
  assert.match((await pull(repo, {})).message, /Already up to date/);

  // Undo needs a clean tree, and puts the branch back.
  await assert.rejects(repo.undo(), /uncommitted changes/);
  git('checkout', '-q', '--', 'g');
  await repo.undo();
  assert.equal(git('rev-parse', 'HEAD'), base);
  assert.equal(existsSync(join(dir, 't')), false);
});

test("pull refuses, changing nothing, when local changes or untracked files would be overwritten", async () => {
  const repo = await Repo.open(dir);
  const base = git('rev-parse', 'HEAD');
  theyPush('theirs', { f: 'theirs\n', t: 'theirs\n' });
  write('f', 'mine\n');
  await assert.rejects(pull(repo, {}), /in the way, so nothing was changed/);
  assert.equal(git('rev-parse', 'HEAD'), base);
  assert.equal(read('f'), 'mine\n');

  git('checkout', '-q', '--', 'f');
  write('t', 'precious\n');
  await assert.rejects(pull(repo, {}), /in the way/);
  assert.equal(read('t'), 'precious\n');
  assert.equal(git('rev-parse', 'HEAD'), base);
  assert.equal(git('status', '--porcelain'), '?? t');
  assert.deepEqual((await repo.backups()).length, 0);
});

test('diverged: pull refuses to guess; rebase replays in memory, dropping commits already upstream', async () => {
  const repo = await Repo.open(dir);
  theyPush('theirs', { t: '1\n' });
  theyPush('same fix', { g: 'fixed\n' });
  const a = commit('mine', { m: '1\n' });
  commit('same fix', { g: 'fixed\n' });
  const b = commit('mine too', { m: '1\n2\n' });
  const before = git('rev-parse', 'HEAD');
  write('f', 'wip\n');

  await assert.rejects(pull(repo, {}), /diverged \(3 commits only here, 2 only there\).*Nothing was changed/s);
  assert.equal(git('rev-parse', 'HEAD'), before);

  const r = await pull(repo, { how: 'rebase' });
  assert.match(r.message, /Rebased 2 commits of main onto origin\/main \(1 commit already there was dropped\)/);
  assert.deepEqual(log(), ['mine too', 'mine', 'same fix', 'theirs', 'base']);
  assert.equal(git('rev-parse', 'HEAD~2'), git('rev-parse', 'origin/main'));
  assert.equal(r.renamed[a], git('rev-parse', 'HEAD~1'));
  assert.equal(r.renamed[b], git('rev-parse', 'HEAD'));
  assert.equal(git('log', '-1', '--format=%an %ae', 'HEAD'), 'Ann ann@x.org');
  assert.equal(read('f'), 'wip\n');
  assert.equal(read('t'), '1\n');
  assert.ok((await repo.backups()).some((x) => x.label === 'pull' && x.sha === before));
  git('checkout', '-q', '--', 'f');
  await repo.undo();
  assert.equal(git('rev-parse', 'HEAD'), before);
});

test('rebase refuses on a conflict or a merge among the local commits, changing nothing', async () => {
  const repo = await Repo.open(dir);
  theyPush('theirs', { f: 'theirs\n' });
  commit('mine', { f: 'mine\n' });
  const head = git('rev-parse', 'HEAD');
  await assert.rejects(pull(repo, { how: 'rebase' }), /would conflict\. Conflict replaying .* "mine" in: f\. .*Merge instead/s);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(read('f'), 'mine\n');
  assert.equal(git('status', '--porcelain'), '');

  git('reset', '-q', '--hard', 'HEAD~1');
  git('checkout', '-q', '-b', 'side');
  commit('side', { s: '1\n' });
  git('checkout', '-q', 'main');
  commit('main', { m: '1\n' });
  git('merge', '-q', '--no-edit', 'side');
  const merged = git('rev-parse', 'HEAD');
  await assert.rejects(pull(repo, { how: 'rebase' }), /include a merge .*Merge origin\/main instead\. Nothing was changed/);
  assert.equal(git('rev-parse', 'HEAD'), merged);
});

test('pull with merge: a clean merge is one undoable step; a dirty tree is refused', async () => {
  const repo = await Repo.open(dir);
  theyPush('theirs', { t: '1\n' });
  commit('mine', { m: '1\n' });
  const head = git('rev-parse', 'HEAD');
  write('g', 'dirty\n');
  await assert.rejects(pull(repo, { how: 'merge' }), /without uncommitted changes.*Nothing was changed/s);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(read('g'), 'dirty\n');
  git('checkout', '-q', '--', 'g');

  write('untracked', 'u\n');
  const r = await pull(repo, { how: 'merge' });
  assert.match(r.message, /Merged origin\/main into main/);
  assert.equal(git('rev-list', '--parents', '-1', 'HEAD').split(' ').length, 3);
  assert.equal(git('log', '-1', '--format=%s'), "Merge remote-tracking branch 'origin/main'");
  assert.equal(read('t'), '1\n');
  assert.equal(read('untracked'), 'u\n');
  assert.equal(r.state.conflict, null);
  await repo.undo();
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(existsSync(join(dir, 't')), false);
});

test('merge conflicts: listed, marked resolved only without markers, then continued', async () => {
  const repo = await Repo.open(dir);
  theyPush('theirs', { f: '1\nTHEIRS\n3\n', g: 'theirs\n', t: '1\n' });
  commit('mine', { f: '1\nMINE\n3\n', g: 'mine\n' });
  const head = git('rev-parse', 'HEAD');
  const r = await pull(repo, { how: 'merge' });
  assert.match(r.message, /stopped with conflicts in 2 files/);
  const c = r.state.conflict!;
  assert.equal(c.kind, 'merge');
  assert.equal(c.title, "Merge remote-tracking branch 'origin/main'");
  assert.deepEqual(c.files.map((f) => [f.path, f.status, f.markers]).sort(), [['f', 'both modified', true], ['g', 'both modified', true]]);
  assert.equal(c.files.find((f) => f.path === 'f')!.line, 2);
  assert.deepEqual(c.resolved, ['t']);
  assert.match(r.state.blocked!, /merge is in progress/);
  assert.ok((await repo.backups()).some((b) => b.label === 'pull' && b.sha === head));

  // History rewriting stays blocked.
  await assert.rejects(repo.edit({ sha: head, subject: 'x', body: '', author: { name: 'a', email: 'b' }, coauthors: [] }), /merge is in progress/);

  // The diff shows what finishing would change, markers included.
  const d = await conflictDiff(repo);
  assert.deepEqual(d.files.map((f) => f.path).sort(), ['f', 'g', 't']);
  assert.ok(d.files.find((f) => f.path === 'f')!.hunks.some((h) => h.lines.some((l) => l.s.startsWith('<<<<<<<'))));

  await assert.rejects(continueOp(repo), /Still conflicted: .*Nothing was changed/);
  await assert.rejects(markResolved(repo, { path: 'f' }), /still has conflict markers.*Nothing was changed/);
  assert.equal((await repo.state()).conflict!.files.length, 2);
  await markResolved(repo, { path: 'g', force: true });
  write('f', '1\nBOTH\n3\n');
  const s = (await markResolved(repo, { path: 'f' })).state.conflict!;
  assert.deepEqual([s.files, s.resolved.sort()], [[], ['f', 'g', 't']]);
  await assert.rejects(markResolved(repo, { path: 'f' }), /isn't conflicted/);

  const done = await continueOp(repo);
  assert.match(done.message, /Finished the merge/);
  assert.equal(done.state.conflict, null);
  assert.equal(done.state.blocked, null);
  assert.equal(git('log', '-1', '--format=%B'), "Merge remote-tracking branch 'origin/main'");
  assert.equal(git('show', 'HEAD:f'), '1\nBOTH\n3');
  assert.ok(git('show', 'HEAD:g').startsWith('<<<<<<<'));
  await repo.undo();
  assert.equal(git('rev-parse', 'HEAD'), head);
});

test('abort saves what was resolved under refs/legit/aborted first', async () => {
  const repo = await Repo.open(dir);
  theyPush('theirs', { f: '1\nTHEIRS\n3\n', g: 'theirs\n', t: '1\n' });
  const head = commit('mine', { f: '1\nMINE\n3\n', g: 'mine\n' });
  await pull(repo, { how: 'merge' });
  write('f', '1\nRESOLVED\n3\n');
  await markResolved(repo, { path: 'f' });
  write('g', 'half done\n');
  const r = await abortOp(repo);
  assert.equal(r.state.conflict, null);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(read('f'), '1\nMINE\n3\n');

  const ref = /were saved first, as (refs\/legit\/aborted\/main\/\d+-merge);/.exec(r.message)?.[1];
  assert.ok(ref, r.message);
  assert.equal(git('rev-parse', `${ref}^`), head);
  assert.equal(git('show', `${ref}:f`), '1\nRESOLVED\n3');
  assert.equal(git('show', `${ref}:g`), 'half done');
  assert.equal(git('show', `${ref}:t`), '1');
  // The way back that the message suggests.
  git('restore', '-s', ref, '--', 'f');
  assert.equal(read('f'), '1\nRESOLVED\n3\n');

  await assert.rejects(abortOp(repo), /no merge, rebase, cherry-pick or revert to abort/);
  await assert.rejects(continueOp(repo), /no merge, rebase, cherry-pick or revert to continue/);
});

test('a conflicted rebase started from a terminal can be continued, or aborted keeping its progress', async () => {
  commit('two', { f: '1\n2\n3\nfour\n' });
  git('checkout', '-q', '-b', 'topic', 'HEAD~1');
  const a = commit('a', { a: '1\n' });
  commit('b', { f: '1\n2\n3\nFOUR\n' });
  const tip = git('rev-parse', 'HEAD');
  const repo = await Repo.open(dir);
  assert.throws(() => git('rebase', '-q', 'main'));
  let st = await repo.state();
  assert.equal(st.conflict?.kind, 'rebase');
  assert.match(st.conflict!.title, /^Rebasing topic onto [0-9a-f]{7} \(2 of 2\)$/);
  assert.deepEqual(st.conflict!.files.map((f) => f.path), ['f']);

  // Abort: the replayed commit and the resolution are kept under the branch's name.
  write('f', '1\n2\n3\nboth\n');
  const r = await abortOp(repo);
  assert.equal(git('rev-parse', 'HEAD'), tip);
  assert.equal(git('branch', '--show-current'), 'topic');
  const ref = /as (refs\/legit\/aborted\/topic\/\d+-rebase);/.exec(r.message)?.[1];
  assert.ok(ref, r.message);
  assert.equal(git('show', `${ref}:f`), '1\n2\n3\nboth');
  assert.equal(git('log', '-1', '--format=%s', `${ref}^`), 'a');
  assert.notEqual(git('rev-parse', `${ref}^`), a);

  // Again, this time resolved and continued: the old tip is backed up, and it can be undone.
  assert.throws(() => git('rebase', '-q', 'main'));
  write('f', '1\n2\n3\nboth\n');
  await markResolved(repo, { path: 'f' });
  st = (await continueOp(repo)).state;
  assert.equal(st.conflict, null);
  assert.equal(st.branch, 'topic');
  assert.deepEqual(log(), ['b', 'a', 'two', 'base']);
  assert.ok((await repo.backups()).some((b) => b.label === 'rebase' && b.sha === tip));
  await repo.undo();
  assert.equal(git('rev-parse', 'HEAD'), tip);
});

test('a conflicted cherry-pick from a terminal: continue commits it', async () => {
  git('checkout', '-q', '-b', 'side');
  const pick = commit('fix', { f: '1\nfix\n3\n' });
  git('checkout', '-q', 'main');
  const head = commit('other', { f: '1\nother\n3\n' });
  const repo = await Repo.open(dir);
  assert.throws(() => git('cherry-pick', pick));
  const st = await repo.state();
  assert.equal(st.conflict?.kind, 'cherry-pick');
  assert.equal(st.conflict?.title, `Cherry-picking ${pick.slice(0, 7)} "fix"`);
  write('f', '1\nboth\n3\n');
  await markResolved(repo, { path: 'f' });
  await continueOp(repo);
  assert.deepEqual(log(), ['fix', 'other', 'base']);
  assert.equal(git('rev-parse', 'HEAD~1'), head);
});

test('a file deleted on one side is resolved by deleting it too', async () => {
  git('checkout', '-q', '-b', 'side');
  git('rm', '-q', 'g');
  git('commit', '-qm', 'remove g');
  git('checkout', '-q', 'main');
  commit('change g', { g: 'changed\n' });
  const repo = await Repo.open(dir);
  const r = await mergeBranch(repo, { branch: 'side' });
  assert.deepEqual(r.state.conflict!.files.map((f) => [f.path, f.status, f.exists, f.markers]), [['g', 'deleted by them', true, false]]);
  unlinkSync(join(dir, 'g'));
  await markResolved(repo, { path: 'g' });
  await continueOp(repo);
  assert.equal(git('ls-files', 'g'), '');
  assert.equal(git('log', '-1', '--format=%s'), "Merge branch 'side'");
});

test('merge and rebase onto another local branch', async () => {
  git('checkout', '-q', '-b', 'feature');
  commit('feature', { x: '1\n' });
  git('checkout', '-q', 'main');
  const repo = await Repo.open(dir);
  await assert.rejects(mergeBranch(repo, { branch: 'nope' }), /No branch named nope/);
  await assert.rejects(mergeBranch(repo, { branch: '--help' }), /Pick a branch/);

  // Only behind: both fast-forward.
  let r = await rebaseBranch(repo, { branch: 'feature' });
  assert.match(r.message, /Fast-forwarded main to feature/);
  assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'feature'));
  assert.match((await mergeBranch(repo, { branch: 'feature' })).message, /already contains feature/);
  await repo.undo();

  commit('main', { m: '1\n' });
  const head = git('rev-parse', 'HEAD');
  r = await rebaseBranch(repo, { branch: 'feature' });
  assert.match(r.message, /Rebased 1 commit of main onto feature/);
  assert.deepEqual(log(), ['main', 'feature', 'base']);
  await repo.undo();
  assert.equal(git('rev-parse', 'HEAD'), head);

  r = await mergeBranch(repo, { branch: 'feature' });
  assert.equal(git('log', '-1', '--format=%s'), "Merge branch 'feature'");
  assert.ok((await repo.backups()).some((b) => b.label === 'merge' && b.sha === head));
  void r;
});

test('diverged by rewriting pushed commits asks for a force push; by new remote commits, a pull', async () => {
  const pushed = commit('pushed', { m: '1\n' });
  git('push', '-q', 'origin', 'main');
  const repo = await Repo.open(dir);
  await repo.edit({ sha: pushed, subject: 'reworded', body: '', author: { name: 'Ann', email: 'ann@x.org' }, coauthors: [] });
  let p = (await repo.state()).push!;
  assert.deepEqual([p.ahead, p.behind, p.rewritten], [1, 1, true]);

  // Someone else pushes on top of what we had: now it's their new commit we're missing.
  git('reset', '-q', '--hard', pushed);
  theyPush('theirs', { t: '1\n' });
  commit('mine', { n: '1\n' });
  await fetchRemote(repo);
  p = (await repo.state()).push!;
  assert.deepEqual([p.ahead, p.behind, p.rewritten], [1, 1, false]);
});
