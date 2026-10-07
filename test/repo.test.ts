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

test('the diff of what squashing would make: consecutive runs, and commits with others between', async () => {
  commit('base', { f: '1\n' });
  const a = commit('a', { a: '1\n' });
  const b = commit('b', { a: '1\n2\n', b: 'b\n' });
  commit('mid', { m: '1\n' });
  const c = commit('c', { a: '1\n2\n3\n' });
  const head = git('rev-parse', 'HEAD');
  const repo = await Repo.open(dir);
  const files = (d: { files: { path: string; added: number; removed: number }[] }) =>
    d.files.map((f) => `${f.path} +${f.added} -${f.removed}`);
  assert.deepEqual(files(await repo.diff(`q${b}-${a}`)), ['a +2 -0', 'b +1 -0']);
  const key = `q${c}.${b}-${a}`;
  const d = await repo.diff(key);
  assert.equal(d.sha, key);
  assert.deepEqual(files(d), ['a +3 -0', 'b +1 -0']);
  await repo.squash({ shas: [c, b, a], subject: 'abc', body: '', coauthors: [] });
  assert.notEqual(git('rev-parse', 'HEAD'), head);
  assert.deepEqual(files(await repo.diff(git('rev-parse', 'HEAD~1'))), files(d));
});

test('the combined diff of merges below the editable history: each brings in its first-parent changes', async () => {
  commit('base', { f: '1\n' });
  git('checkout', '-qb', 'one');
  commit('pr one', { a: 'a\n' });
  git('checkout', '-q', '-');
  git('merge', '-q', '--no-ff', '-m', 'merge one', 'one');
  const m1 = git('rev-parse', 'HEAD');
  commit('direct', { d: 'd\n' });
  git('checkout', '-qb', 'two');
  commit('pr two', { b: 'b\n' });
  git('checkout', '-q', '-');
  git('merge', '-q', '--no-ff', '-m', 'merge two', 'two');
  const m2 = git('rev-parse', 'HEAD');
  commit('top', { t: 't\n' });
  const repo = await Repo.open(dir);
  const files = (d: { files: { path: string }[] }) => d.files.map((f) => f.path);
  // Both merges as one run, then just the two merges with the commit between them left out.
  assert.deepEqual(files(await repo.diff(`q${m2}-${m1}`)), ['a', 'b', 'd']);
  assert.deepEqual(files(await repo.diff(`q${m2}.${m1}`)), ['a', 'b']);
});

test('the diff of a squash that would conflict says so', async () => {
  commit('base', { f: '1\n' });
  const a = commit('a', { f: 'a\n' });
  commit('mid', { f: 'm\n' });
  const c = commit('c', { f: 'c\n' });
  const repo = await Repo.open(dir);
  await assert.rejects(repo.diff(`q${c}.${a}`), /can't be combined/);
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

test('older history loads in pages; a merge lists the commits it brought in', async () => {
  commit('base', { f: '1\n' });
  // 300 more commits, quickly.
  let stream = '';
  for (let i = 1; i <= 300; i++) stream += `commit refs/heads/main\ncommitter Ann <ann@x.org> ${1e9 + i} +0000\ndata ${`old ${i}`.length}\nold ${i}\n\n`;
  execFileSync('git', ['fast-import', '--quiet'], { cwd: dir, env, input: stream.replace('\n\n', '\nfrom main^0\n\n') });
  git('reset', '-q', '--hard');
  git('checkout', '-q', '-b', 'side');
  commit('side 1', { s: '1\n' });
  commit('side 2', { s: '2\n' });
  git('checkout', '-q', 'main');
  commit('main', { m: '1\n' });
  git('merge', '-q', '--no-edit', 'side');
  commit('after merge', { m: '2\n' });
  const repo = await Repo.open(dir);

  const st = await repo.state();
  const all = git('rev-list', '--first-parent', 'HEAD').split('\n');
  assert.deepEqual(st.commits.map((c) => c.sha), all.slice(0, st.commits.length));
  const p1 = await repo.older(st.commits.at(-1)!.sha);
  assert.equal(p1.commits.length, 200);
  assert.ok(p1.more);
  const p2 = await repo.older(p1.commits.at(-1)!.sha);
  assert.ok(!p2.more);
  assert.deepEqual([...st.commits, ...p1.commits, ...p2.commits].map((c) => c.sha), all);
  assert.equal(p2.commits.at(-1)!.subject, 'base');
  assert.ok(p2.commits.every((c) => !c.editable));
  assert.deepEqual(await repo.older(p2.commits.at(-1)!.sha), { commits: [], more: false });

  const merge = st.commits[1];
  assert.ok(merge.merge);
  const m = await repo.merged(merge.sha);
  assert.equal(m.total, 2);
  assert.deepEqual(m.commits.map((c) => [c.subject, c.side, c.editable]), [['side 2', merge.sha, false], ['side 1', merge.sha, false]]);
  assert.deepEqual(await repo.merged(st.commits[0].sha), { commits: [], total: 0 });
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

test("generated files: built-in patterns, linguist-generated as of the commit, the user's patterns", async () => {
  const { generatedPaths } = await import('../src/server/generated.ts');
  write('.gitattributes', 'gen/** linguist-generated\nyarn.lock -linguist-generated\n');
  const sha = commit('files', { 'package-lock.json': '{}\n', 'yarn.lock': 'x\n', 'app.min.js': 'x\n', 'app.js': 'x\n' });
  execFileSync('mkdir', ['-p', join(dir, 'gen'), join(dir, 'docs'), join(dir, 'sub')]);
  const sha2 = commit('more', { 'gen/api.ts': 'x\n', 'docs/index.html': 'x\n', 'sub/Cargo.lock': 'x\n', 'src.ts': 'x\n' });
  const repo = await Repo.open(dir);
  const paths = ['package-lock.json', 'yarn.lock', 'app.min.js', 'app.js', 'gen/api.ts', 'docs/index.html', 'sub/Cargo.lock', 'src.ts'];
  const hidden = await generatedPaths(repo.git, sha2, paths, ['docs/*.html']);
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
  assert.deepEqual(st.push, { remote: 'origin', branch: 'main', publish: true, ahead: 2, behind: 0, rewritten: false });
  st = (await repo.push({})).state;
  assert.equal(remoteHead(), a);
  assert.deepEqual(st.push, { remote: 'origin', branch: 'main', publish: false, ahead: 0, behind: 0, rewritten: false });
  await assert.rejects(repo.push({}), /up to date/);

  // Fast-forward.
  const b = commit('b', { g: '1\n' });
  assert.equal((await repo.state()).push?.ahead, 1);
  await repo.push({});
  assert.equal(remoteHead(), b);

  // Rewriting pushed history needs an explicit force.
  await repo.edit({ sha: a, subject: 'A', body: '', author: { name: 'Ann', email: 'ann@x.org' }, coauthors: [] });
  st = await repo.state();
  assert.deepEqual([st.push?.ahead, st.push?.behind, st.push?.rewritten], [2, 2, true]);
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

test('stage/unstage lines and files touch only the index; commit runs hooks', async () => {
  const lines = (edit: (l: string[]) => void) => {
    const l = 'abcdefghijklmnopqrst'.split('');
    edit(l);
    return l.join('\n') + '\n';
  };
  commit('base', { f: lines(() => {}), g: 'g\n', gone: 'x\n' });
  const worktreeF = lines((l) => { l[1] = 'B'; l[15] = 'P'; });
  write('f', worktreeF);
  write('g', 'G\n');
  execFileSync('rm', [join(dir, 'gone')]);
  write('new.txt', 'one\ntwo\nthree\n');
  const repo = await Repo.open(dir);
  const show = (spec: string) => git('show', spec);

  let st = await repo.state();
  assert.deepEqual(st.work, { staged: 0, unstaged: 3, untracked: 1 });
  let { unstaged } = await repo.work();
  const f = unstaged.files.find((x) => x.path === 'f')!;
  const secondHunk = f.hunks[1].lines.filter((l) => l.i !== undefined).map((l) => l.i!);
  const n = unstaged.files.find((x) => x.path === 'new.txt')!;
  assert.equal(n.untracked, true);
  // Stage: the second hunk of f, all of g and gone, and only "two" of the untracked file.
  await repo.stage({ key: unstaged.sha, selection: { f: secondHunk, g: 'all', gone: 'all', 'new.txt': [1] } });
  assert.equal(show(':f') + '\n', lines((l) => { l[15] = 'P'; }));
  assert.equal(show(':g'), 'G');
  assert.throws(() => show(':gone'));
  assert.equal(show(':new.txt'), 'two');
  // The working tree is untouched.
  assert.equal(read('f'), worktreeF);
  assert.equal(read('new.txt'), 'one\ntwo\nthree\n');

  // Unstage the P line change again, and all of g.
  let { staged } = await repo.work();
  const sf = staged.files.find((x) => x.path === 'f')!;
  await repo.unstage({ key: staged.sha, selection: { f: sf.hunks[0].lines.filter((l) => l.i !== undefined).map((l) => l.i!), g: 'all' } });
  assert.equal(show(':f') + '\n', lines(() => {}));
  assert.equal(show(':g'), 'g');
  assert.equal(read('g'), 'G\n');

  // A file that changes after it was shown is refused.
  ({ unstaged } = await repo.work());
  write('g', 'G2\n');
  await assert.rejects(repo.stage({ key: unstaged.sha, selection: { g: 'all' } }), /changed since it was shown/);
  assert.equal(show(':g'), 'g');

  // Commit what's staged; a failing hook refuses the commit.
  ({ staged } = await repo.work());
  assert.deepEqual(staged.files.map((x) => x.path).sort(), ['gone', 'new.txt']);
  write('.git/hooks/commit-msg', '#!/bin/sh\ngrep -q ok "$1" || { echo "needs ok" >&2; exit 1; }\n');
  execFileSync('chmod', ['+x', join(dir, '.git/hooks/commit-msg')]);
  await assert.rejects(repo.commit({ subject: 'nope', body: '', coauthors: [] }), /needs ok/);
  const r = await repo.commit({ subject: 'ok: partial', body: 'body', coauthors: [{ name: 'Cy', email: 'cy@x.org' }] });
  assert.equal(git('log', '-1', '--format=%B'), 'ok: partial\n\nbody\n\nCo-authored-by: Cy <cy@x.org>');
  assert.equal(r.focus[0], git('rev-parse', 'HEAD'));
  assert.equal(show('HEAD:new.txt'), 'two');
  await assert.rejects(repo.commit({ subject: 'ok', body: '', coauthors: [] }), /Nothing is staged/);
  st = r.state;
  assert.deepEqual(st.work, { staged: 0, unstaged: 3, untracked: 0 });
});

test('commit, amend and uncommit are undoable and never touch the index or working tree', async () => {
  commit('base', { f: '1\n' });
  const a = commit('a', { f: '2\n' });
  const repo = await Repo.open(dir);
  const staged = () => git('diff', '--cached', '--name-only');

  // Commit, then undo it: the change is staged again; redo brings the commit back.
  write('g', 'g\n');
  git('add', 'g');
  write('f', 'dirty\n');
  await repo.commit({ subject: 'add g', body: '', coauthors: [] });
  const c = git('rev-parse', 'HEAD');
  assert.equal(staged(), '');
  await repo.undo();
  assert.equal(git('rev-parse', 'HEAD'), a);
  assert.equal(staged(), 'g');
  assert.equal(read('f'), 'dirty\n');
  await repo.redo();
  assert.equal(git('rev-parse', 'HEAD'), c);

  // Amend: what's staged goes into HEAD with the new message; undo restores the old HEAD.
  write('h', 'h\n');
  git('add', 'h');
  await repo.commit({ subject: 'add g and h', body: '', coauthors: [], amend: true });
  assert.deepEqual(log(), ['add g and h', 'a', 'base']);
  assert.equal(git('show', 'HEAD:h'), 'h');
  assert.equal(git('rev-parse', 'HEAD~1'), a);
  await repo.undo();
  assert.equal(git('rev-parse', 'HEAD'), c);
  assert.equal(staged(), 'h');
  assert.equal(read('f'), 'dirty\n');
  assert.ok((await repo.backups()).some((b) => b.label === 'amend'));

  // Uncommit: the commit's changes (and what was already staged) end up staged.
  await repo.uncommit();
  assert.equal(git('rev-parse', 'HEAD'), a);
  assert.deepEqual(staged().split('\n').sort(), ['g', 'h']);
  assert.equal(read('f'), 'dirty\n');
  await repo.undo();
  assert.equal(git('rev-parse', 'HEAD'), c);

  // Refusals: the first commit, and merges.
  git('checkout', '-q', '--orphan', 'lonely');
  git('commit', '-qm', 'only');
  await assert.rejects(repo.uncommit(), /first commit/);
  assert.equal(git('log', '--format=%s'), 'only');
});

test('old safety refs are pruned, recent and unrelated ones are kept', async () => {
  const a = commit('one', { f: '1\n' });
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  git('update-ref', `refs/legit/backups/main/${now - 20 * day}-edit`, a);
  git('update-ref', `refs/legit/backups/gone/${now - 15 * day}-drop`, a);
  git('update-ref', `refs/legit/backups/main/${now - day}-edit`, a);
  git('update-ref', `refs/legit/discarded/${now - 30 * day}`, a);
  git('update-ref', 'refs/legit/backups/main/mine', a);
  await Repo.open(dir);
  assert.deepEqual(git('for-each-ref', '--format=%(refname)', 'refs/legit').split('\n').sort(), [
    `refs/legit/backups/main/${now - day}-edit`,
    'refs/legit/backups/main/mine',
  ]);
});
