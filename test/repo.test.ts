import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
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
const write = (f: string, s: string) => writeFileSync(join(dir, f), s);
const read = (f: string) => readFileSync(join(dir, f), 'utf8');
const commit = (msg: string, files: Record<string, string>) => {
  for (const [f, s] of Object.entries(files)) write(f, s);
  git('add', '-A');
  git('commit', '-qm', msg);
  return git('rev-parse', 'HEAD');
};
const log = () => git('log', '--format=%s').split('\n');
const show = (rev: string, f: string) => git('show', `${rev}:${f}`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'legit-test-'));
  dirs.push(dir);
  git('init', '-q', '-b', 'main');
});

test('edit message, author and co-authors of an old commit', async () => {
  const a = commit('one', { f: '1\n' });
  commit('two', { f: '1\n2\n' });
  const repo = await Repo.open(dir);
  const r = await repo.edit({
    sha: a, subject: 'first', body: 'details\n\nSigned-off-by: Ann <ann@x.org>',
    author: { name: 'Bob', email: 'bob@x.org' }, coauthors: [{ name: 'Cy', email: 'cy@x.org' }],
  });
  assert.deepEqual(log(), ['two', 'first']);
  assert.equal(git('log', '-1', '--format=%B', 'HEAD~1'), 'first\n\ndetails\n\nSigned-off-by: Ann <ann@x.org>\nCo-authored-by: Cy <cy@x.org>');
  assert.equal(git('log', '-1', '--format=%an <%ae>', 'HEAD~1'), 'Bob <bob@x.org>');
  assert.equal(r.renamed[a], git('rev-parse', 'HEAD~1'));
  const c = r.state.commits[1];
  assert.equal(c.subject, 'first');
  assert.equal(c.body, 'details\n\nSigned-off-by: Ann <ann@x.org>');
  assert.deepEqual(c.coauthors, [{ name: 'Cy', email: 'cy@x.org' }]);
});

test('split lines of a commit into a following commit', async () => {
  const lines = (edit: (l: string[]) => void) => {
    const l = 'abcdefghijklmnopqrst'.split('');
    edit(l);
    return l.join('\n') + '\n';
  };
  commit('base', { f: lines(() => {}), keep: 'k\n' });
  const c = commit('change', { f: lines((l) => { l[1] = 'B'; l[15] = 'P'; l.push('u'); }), g: 'new\n', keep: 'K\n' });
  commit('later', { f: lines((l) => { l[1] = 'B'; l[15] = 'P'; l.push('u', 'v'); }) });
  const repo = await Repo.open(dir);
  const f = (await repo.diff(c)).files.find((x) => x.path === 'f')!;
  assert.equal(f.hunks.length, 2);
  // Lines of the second hunk ("-p", "+P", "+u").
  const second = f.hunks[1].lines.filter((l) => l.i !== undefined).map((l) => l.i!);
  await repo.split({ sha: c, selection: { f: second, g: 'all' }, message: 'moved', before: false });
  assert.deepEqual(log(), ['later', 'moved', 'change', 'base']);
  assert.equal(show('HEAD~2', 'f') + '\n', lines((l) => { l[1] = 'B'; }));
  assert.equal(show('HEAD~2', 'keep'), 'K');
  assert.throws(() => show('HEAD~2', 'g'));
  assert.equal(show('HEAD~1', 'f') + '\n', lines((l) => { l[1] = 'B'; l[15] = 'P'; l.push('u'); }));
  assert.equal(show('HEAD~1', 'g'), 'new');
  assert.equal(git('rev-parse', 'HEAD^{tree}'), git('rev-parse', 'HEAD@{1}^{tree}'));
});

test('split into a preceding commit, with deletions and a missing final newline', async () => {
  commit('base', { f: 'x\ny\nz' });
  const c = commit('change', { f: 'x\nz\nw' });
  const repo = await Repo.open(dir);
  const f = (await repo.diff(c)).files[0];
  const minusY = f.hunks[0].lines.find((l) => l.t === '-' && l.s === 'y')!.i!;
  await repo.split({ sha: c, selection: { f: [minusY] }, message: 'drop y', before: true });
  assert.deepEqual(log(), ['change', 'drop y', 'base']);
  assert.equal(git('cat-file', '-p', 'HEAD~1:f'), 'x\nz');
  assert.equal(git('cat-file', '-p', 'HEAD:f'), 'x\nz\nw');
});

test('reorder commits, updating the working tree only when needed', async () => {
  const a = commit('a', { a: '1\n' });
  const b = commit('b', { b: '1\n' });
  const c = commit('c', { c: '1\n' });
  const repo = await Repo.open(dir);
  await repo.reorder({ order: [b, c, a] });
  assert.deepEqual(log(), ['b', 'c', 'a']);
  assert.equal(git('status', '--porcelain'), '');
});

test('reorder conflict leaves history untouched', async () => {
  commit('base', { f: '1\n' });
  const a = commit('a', { f: '2\n' });
  const b = commit('b', { f: '3\n' });
  const head = git('rev-parse', 'HEAD');
  const repo = await Repo.open(dir);
  await assert.rejects(repo.reorder({ order: [a, b, git('rev-parse', 'HEAD~2')] }), /Conflict/);
  assert.equal(git('rev-parse', 'HEAD'), head);
});

test('squash non-adjacent commits, then undo and redo', async () => {
  commit('base', { f: '1\n' });
  const a = commit('a', { a: '1\n' });
  commit('mid', { m: '1\n' });
  const b = commit('b', { a: '1\n2\n' });
  const head = git('rev-parse', 'HEAD');
  const repo = await Repo.open(dir);
  await repo.squash({ shas: [b, a], subject: 'a+b', body: 'both', coauthors: [{ name: 'Cy', email: 'cy@x.org' }] });
  assert.equal(git('log', '-1', '--format=%B', 'HEAD~1'), 'a+b\n\nboth\n\nCo-authored-by: Cy <cy@x.org>');
  assert.deepEqual(log(), ['mid', 'a+b', 'base']);
  assert.equal(show('HEAD~1', 'a'), '1\n2');
  const undone = await repo.undo();
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.ok(undone.state.canRedo);
  await repo.redo();
  assert.deepEqual(log(), ['mid', 'a+b', 'base']);
});

test('reordering updates a clean working tree and refuses to clobber changes', async () => {
  commit('base', { f: '1\n' });
  const a = commit('a', { f: '1\n2\n' });
  const b = commit('b', { g: 'g\n' });
  const repo = await Repo.open(dir);
  await repo.drop({ shas: [a] });
  assert.equal(read('f'), '1\n');
  await repo.undo();
  assert.equal(read('f'), '1\n2\n');
  write('f', 'dirty\n');
  await assert.rejects(repo.drop({ shas: [git('rev-parse', 'HEAD~1')] }), /uncommitted/);
  assert.equal(read('f'), 'dirty\n');
  assert.deepEqual(log(), ['b', 'a', 'base']);
  void b;
});

test('edit the root commit', async () => {
  const a = commit('root', { f: '1\n' });
  commit('next', { f: '2\n' });
  const repo = await Repo.open(dir);
  await repo.edit({ sha: a, subject: 'Root', body: '', author: { name: 'Ann', email: 'ann@x.org' }, coauthors: [] });
  assert.deepEqual(log(), ['next', 'Root']);
  assert.equal(git('rev-list', '--max-parents=0', 'HEAD').split('\n').length, 1);
});

test('metadata edits and splits leave uncommitted work alone', async () => {
  commit('base', { f: '1\n', g: '1\n' });
  const a = commit('a', { f: '1\n2\n', g: '1\n2\n' });
  write('f', 'wip\n');
  write('new', 'untracked\n');
  git('add', 'g');
  const repo = await Repo.open(dir);
  await repo.edit({ sha: a, subject: 'A', body: '', author: { name: 'Ann', email: 'ann@x.org' }, coauthors: [] });
  await repo.split({ sha: git('rev-parse', 'HEAD'), selection: { g: 'all' }, message: 'g', before: false });
  assert.deepEqual(log(), ['g', 'A', 'base']);
  assert.equal(read('f'), 'wip\n');
  assert.equal(read('new'), 'untracked\n');
  assert.equal(git('status', '--porcelain'), 'M f\n?? new'); // (leading space trimmed by the helper)
});

test('never overwrites an untracked file', async () => {
  commit('base', { f: '1\n', x: 'tracked\n' });
  git('rm', '-q', 'x');
  git('commit', '-qm', 'remove x');
  write('x', 'precious\n');
  const repo = await Repo.open(dir);
  const head = git('rev-parse', 'HEAD');
  await assert.rejects(repo.drop({ shas: [head] }));
  assert.equal(read('x'), 'precious\n');
  assert.equal(git('rev-parse', 'HEAD'), head);
});

test('refuses to change files while tracked changes are staged, even unrelated ones', async () => {
  commit('base', { f: '1\n', g: '1\n' });
  const a = commit('a', { f: '2\n' });
  write('g', 'staged\n');
  git('add', 'g');
  const repo = await Repo.open(dir);
  await assert.rejects(repo.drop({ shas: [a] }), /uncommitted changes/);
  assert.equal(git('rev-parse', 'HEAD'), a);
  assert.equal(git('diff', '--cached', '--name-only'), 'g');
});

test('every operation leaves a backup ref that can be restored', async () => {
  commit('base', { f: '1\n' });
  const a = commit('a', { f: '2\n' });
  const b = commit('b', { g: '1\n' });
  const repo = await Repo.open(dir);
  await repo.edit({ sha: a, subject: 'A', body: '', author: { name: 'Ann', email: 'ann@x.org' }, coauthors: [] });
  await repo.drop({ shas: [git('rev-parse', 'HEAD')] });
  const backups = await repo.backups();
  assert.deepEqual(backups.map((x) => [x.label, x.sha]), [['drop', git('rev-parse', 'HEAD@{1}')], ['edit', b]]);
  // A fresh process (no in-memory undo) can still get the original history back.
  const fresh = await Repo.open(dir);
  await fresh.restore({ ref: backups[1].ref });
  assert.equal(git('rev-parse', 'HEAD'), b);
  assert.equal(read('g'), '1\n');
  assert.equal((await fresh.backups())[0].label, 'restore');
  await assert.rejects(fresh.restore({ ref: 'refs/heads/main' }), /Not a legit backup/);
});

test('refuses to rewrite past a merge and keeps the merge intact', async () => {
  commit('base', { f: '1\n' });
  git('checkout', '-q', '-b', 'side');
  commit('side', { s: '1\n' });
  git('checkout', '-q', 'main');
  commit('main', { m: '1\n' });
  git('merge', '-q', '--no-edit', 'side');
  const c = commit('after merge', { m: '2\n' });
  const repo = await Repo.open(dir);
  const st = await repo.state();
  assert.deepEqual(st.commits.map((x) => [x.subject, x.editable]), [
    ['after merge', true], ["Merge branch 'side'", false], ['main', false], ['base', false],
  ]);
  await assert.rejects(repo.edit({ sha: git('rev-parse', 'HEAD~2'), subject: 'x', body: '', author: { name: 'a', email: 'b' }, coauthors: [] }), /not editable/);
  await repo.edit({ sha: c, subject: 'After', body: '', author: { name: 'Ann', email: 'ann@x.org' }, coauthors: [] });
  assert.equal(git('rev-list', '--merges', '--count', 'HEAD'), '1');
});

test('switching branches refuses to clobber local changes; undo history is per branch', async () => {
  commit('base', { f: '1\n' });
  git('branch', 'other');
  const a = commit('a', { f: '2\n' });
  const repo = await Repo.open(dir);
  assert.deepEqual((await repo.branches()).map((b) => [b.name, b.current]).sort(), [['main', true], ['other', false]]);
  await repo.edit({ sha: a, subject: 'A', body: '', author: { name: 'Ann', email: 'ann@x.org' }, coauthors: [] });

  write('f', 'dirty\n');
  await assert.rejects(repo.switchBranch({ branch: 'other' }), /Couldn't switch/);
  assert.equal(read('f'), 'dirty\n');
  assert.equal(git('branch', '--show-current'), 'main');
  git('checkout', '-q', '--', 'f');

  let st = (await repo.switchBranch({ branch: 'other' })).state;
  assert.equal(st.branch, 'other');
  assert.equal(st.canUndo, false);
  await repo.edit({ sha: git('rev-parse', 'HEAD'), subject: 'Base', body: '', author: { name: 'Ann', email: 'ann@x.org' }, coauthors: [] });
  st = (await repo.switchBranch({ branch: 'main' })).state;
  assert.equal(st.canUndo, true);
  await repo.undo();
  assert.deepEqual(log(), ['a', 'base']);
  assert.equal(git('log', '-1', '--format=%s', 'other'), 'Base');
  await assert.rejects(repo.switchBranch({ branch: 'nope' }), /No local branch/);
});

test('generated files: built-in patterns, linguist-generated as of the commit, legit.hide', async () => {
  const { generatedPaths } = await import('../src/server/generated.ts');
  write('.gitattributes', 'gen/** linguist-generated\nyarn.lock -linguist-generated\n');
  git('config', '--add', 'legit.hide', 'docs/*.html');
  const sha = commit('files', { 'package-lock.json': '{}\n', 'yarn.lock': 'x\n', 'app.min.js': 'x\n', 'app.js': 'x\n' });
  execFileSync('mkdir', ['-p', join(dir, 'gen'), join(dir, 'docs'), join(dir, 'sub')]);
  const sha2 = commit('more', { 'gen/api.ts': 'x\n', 'docs/index.html': 'x\n', 'sub/Cargo.lock': 'x\n', 'src.ts': 'x\n' });
  const repo = await Repo.open(dir);
  const paths = ['package-lock.json', 'yarn.lock', 'app.min.js', 'app.js', 'gen/api.ts', 'docs/index.html', 'sub/Cargo.lock', 'src.ts'];
  const hidden = await generatedPaths(repo.git, sha2, paths);
  assert.deepEqual([...hidden].sort(), ['app.min.js', 'docs/index.html', 'gen/api.ts', 'package-lock.json', 'sub/Cargo.lock']);
  void sha;
});

test('push: publish, fast-forward, and force push only with consent and never over unseen work', async () => {
  const remote = mkdtempSync(join(tmpdir(), 'legit-remote-'));
  dirs.push(remote);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env });
  commit('base', { f: '1\n' });
  const a = commit('a', { f: '2\n' });
  git('remote', 'add', 'origin', remote);
  const repo = await Repo.open(dir);
  const remoteHead = () => execFileSync('git', ['rev-parse', 'main'], { cwd: remote, env, encoding: 'utf8' }).trim();

  // Publish a branch with no upstream.
  let st = await repo.state();
  assert.deepEqual(st.push, { remote: 'origin', branch: 'main', publish: true, ahead: 2, behind: 0 });
  st = (await repo.push({})).state;
  assert.equal(remoteHead(), a);
  assert.deepEqual(st.push, { remote: 'origin', branch: 'main', publish: false, ahead: 0, behind: 0 });
  await assert.rejects(repo.push({}), /up to date/);

  // Fast-forward.
  const b = commit('b', { g: '1\n' });
  assert.equal((await repo.state()).push?.ahead, 1);
  await repo.push({});
  assert.equal(remoteHead(), b);

  // Rewriting pushed history needs an explicit force.
  await repo.edit({ sha: a, subject: 'A', body: '', author: { name: 'Ann', email: 'ann@x.org' }, coauthors: [] });
  st = await repo.state();
  assert.deepEqual([st.push?.ahead, st.push?.behind], [2, 2]);
  await assert.rejects(repo.push({}), /needs a force push/);
  assert.equal(remoteHead(), b);
  await repo.push({ force: true });
  assert.equal(remoteHead(), git('rev-parse', 'HEAD'));

  // Someone else pushes; we rewrite without fetching: the lease refuses.
  const other = mkdtempSync(join(tmpdir(), 'legit-other-'));
  dirs.push(other);
  const og = (...args: string[]) => execFileSync('git', args, { cwd: other, env, encoding: 'utf8' }).trim();
  execFileSync('git', ['clone', '-q', remote, other], { env });
  writeFileSync(join(other, 'theirs'), 'precious\n');
  og('add', 'theirs');
  og('commit', '-qm', 'their work');
  og('push', '-q', 'origin', 'main');
  const theirs = og('rev-parse', 'HEAD');
  await repo.edit({ sha: git('rev-parse', 'HEAD'), subject: 'B2', body: '', author: { name: 'Ann', email: 'ann@x.org' }, coauthors: [] });
  await assert.rejects(repo.push({ force: true }), /haven't fetched/);
  assert.equal(remoteHead(), theirs);

  // Fetching (without integrating) isn't enough either: --force-if-includes refuses.
  git('fetch', '-q', 'origin');
  await assert.rejects(repo.push({ force: true }), /never integrated/);
  assert.equal(remoteHead(), theirs);
});
