import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { PrLines, PrReview, SuggestionsApplied } from '../src/shared/gh-review.ts';
import type { OpResult } from '../src/shared/types.ts';

// The demo repo (scripts/gh-demo.ts) against the fake GitHub, as `LEGIT_GITHUB_MOCK=1` runs it.
process.env.LEGIT_GITHUB_MOCK = '1';
const { githubRoute } = await import('../src/server/gh/routes.ts');
const { db } = await import('../src/server/gh/mock/registry.ts');
await import('../src/server/gh/mock/index.ts');
const { Repo } = await import('../src/server/repo.ts');

const tmp = mkdtempSync(join(tmpdir(), 'legit-ghflow-'));
const dir = join(tmp, 'demo');
let repo: InstanceType<typeof Repo>;
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const post = <T = PrReview>(name: string, body: unknown) => githubRoute(repo, 'POST', name, body) as Promise<T>;
const get = <T = PrReview>(name: string, q: Record<string, string>) => githubRoute(repo, 'GET', name, new URLSearchParams(q)) as Promise<T>;

before(async () => {
  execFileSync(process.execPath, ['scripts/gh-demo.ts', dir], { stdio: 'ignore' });
  repo = await Repo.open(dir);
  await get('reviewThreads', { number: '13' });
});
after(() => rmSync(tmp, { recursive: true, force: true }));

test('a comment on a whole file, alone or in the pending review; refused for a file the pull request leaves alone', async () => {
  const head = git('rev-parse', 'HEAD');
  const first = git('rev-parse', 'HEAD~1');
  let r = await post('reviewComment', { number: 13, commitId: head, path: 'src/parser.ts', subject: 'FILE', line: 0, side: 'RIGHT', body: 'On the parser' });
  const t = r.threads.find((x) => x.comments[0].body === 'On the parser');
  assert.equal(t?.subject, 'FILE');
  assert.equal(t?.line, null);
  assert.ok(!t?.comments[0].pending);
  r = await post('reviewComment', { number: 13, commitId: first, path: 'src/errors.ts', subject: 'FILE', line: 0, side: 'RIGHT', body: 'Pending one', pending: true });
  assert.equal(r.threads.find((x) => x.comments[0].body === 'Pending one')?.subject, 'FILE');
  assert.equal(r.pending?.comments, 1);
  await assert.rejects(
    post('reviewComment', { number: 13, commitId: head, path: 'README.md', subject: 'FILE', line: 0, side: 'RIGHT', body: 'Nope' }),
    /files the pull request changes/,
  );
  db.threads = db.threads.filter((x: { comments: { body: string }[] }) => !['On the parser', 'Pending one'].includes(x.comments[0]?.body));
  delete db.pending[13];
  assert.equal((await get('reviewThreads', { number: '13', fresh: '1' })).pending, null);
});

test("what GitHub takes comments on in a file at a commit: the pull request's diff's hunks, and the diff's old side against its base", async () => {
  const [head, first, base] = [git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD~1'), git('rev-parse', 'origin/feature/parser')];
  const lines = (commit: string, oldest: string, path: string) => get<PrLines | null>('reviewLines', { base, commit, oldest, path });
  // parser.ts gains an import at the top and changes lines 15 and 23: two hunks with three lines around.
  assert.deepEqual(await lines(head, head, 'src/parser.ts'), { hunks: [{ left: [1, 3], right: [1, 4] }, { left: [12, 23], right: [13, 26] }], moved: [] });
  assert.deepEqual((await lines(head, head, 'README.md'))?.hunks, []);
  // From the pull request's first commit, whose parent is the base, nothing moves; from further back, what changed since does.
  assert.deepEqual((await lines(first, first, 'src/errors.ts'))?.moved, []);
  assert.deepEqual((await lines(head, git('rev-parse', 'HEAD~2'), 'src/parser.ts'))?.moved, [[1, 25, 0, 0]]);
  // A removed line goes by the base's number.
  const r = await post('reviewComment', { number: 13, commitId: head, path: 'src/parser.ts', line: 15, side: 'LEFT', body: 'Removed' });
  const t = r.threads.find((x) => x.comments[0].body === 'Removed');
  assert.deepEqual([t?.side, t?.line], ['LEFT', 15]);
  db.threads = db.threads.filter((x: { id: string }) => x.id !== t?.id);
});

test('a line shown by expanding the diff takes a comment, beyond the three lines around a change', async () => {
  const head = git('rev-parse', 'HEAD');
  // parser.ts's hunks end at line 4 and start at 13: line 8 is only seen by expanding.
  const r = await post('reviewComment', { number: 13, commitId: head, path: 'src/parser.ts', line: 8, side: 'RIGHT', body: 'Expanded' });
  const t = r.threads.find((x) => x.comments[0].body === 'Expanded');
  assert.deepEqual([t?.side, t?.line], ['RIGHT', 8]);
  db.threads = db.threads.filter((x: { id: string }) => x.id !== t?.id);
  await assert.rejects(post('reviewComment', { number: 13, commitId: head, path: 'README.md', line: 1, side: 'RIGHT', body: 'Nope' }), /could not be resolved/);
});

test('discarding the pending review deletes its comments, and its replies in threads that stay', async () => {
  // #12's fixture review holds two comments, each a thread of its own.
  let r = await get('reviewThreads', { number: '12', fresh: '1' });
  assert.equal(r.pending?.comments, 2);
  assert.equal(r.threads.filter((t) => t.comments.some((c) => c.pending)).length, 2);
  const other = r.threads.find((t) => !t.comments.some((c) => c.pending))!;
  r = await post('reviewReply', { number: 12, threadId: other.id, commentDatabaseId: other.comments[0].databaseId, body: 'Pending reply', pending: true });
  assert.equal(r.pending?.comments, 3);
  r = await post('reviewDiscard', { number: 12 });
  assert.equal(r.pending, null);
  assert.ok(r.threads.every((t) => t.comments.every((c) => !c.pending)));
  assert.equal(r.threads.find((t) => t.id === other.id)?.comments.length, other.comments.length);
  await assert.rejects(post('reviewDiscard', { number: 12 }), /no review in progress/);
});

test('suggestions applied together: one commit with their authors, refusing those that overlap, changed or are on uncommitted files; undone like a commit', async () => {
  const head = git('rev-parse', 'HEAD');
  const hubot = { login: 'hubot', avatar: 'https://avatars.githubusercontent.com/u/123?v=4' };
  const mona = { login: 'monalisa', avatar: 'https://github.com/monalisa.png' };
  const me = { login: 'octocat', avatar: '' };
  const s = (threadId: string, path: string, startLine: number, lines: string[], replacement: string[], author: typeof me) => ({ threadId, path, startLine, lines, replacement, author });
  const suggestions = [
    s('A', 'src/parser.ts', 11, ['  const specs: Spec[] = [];'], ['  const specs: Spec[] = []; // parsed'], hubot),
    s('B', 'src/parser.ts', 12, ['  let i = 0;'], ['  let i = 0; // next token'], mona),
    s('C', 'src/parser.ts', 11, ['  const specs: Spec[] = [];', '  let i = 0;'], ['  const specs: Spec[] = [], i = 0;'], mona),
    s('D', 'src/parser.ts', 5, ['  nom: string;'], ['  name: string;'], hubot),
    s('E', 'src/errors.ts', 3, ['    super(`line ${line}: ${message}`);'], ['    super(`${line}: ${message}`);'], hubot),
    s('F', 'src/parser.ts', 5, ['  name: string;'], ['  name: string; // the widget'], me),
  ];
  const errors = `${dir}/src/errors.ts`;
  writeFileSync(errors, readFileSync(errors, 'utf8') + '// mine\n');
  await assert.rejects(post('reviewApplyBatch', { branch: 'main', head, suggestions }), /Check out main first/);
  await assert.rejects(post('reviewApplyBatch', { branch: 'feature/parser-errors', head: 'f'.repeat(40), suggestions }), /has moved/);
  const r = await post<OpResult & SuggestionsApplied>('reviewApplyBatch', { branch: 'feature/parser-errors', head, suggestions });
  assert.deepEqual(r.applied.map((i) => suggestions[i].threadId), ['A', 'B', 'F']);
  assert.deepEqual(r.refused.map((x) => [suggestions[x.index].threadId, x.why.match(/another suggestion|no longer has|uncommitted/)?.[0]]), [
    ['C', 'another suggestion'],
    ['D', 'no longer has'],
    ['E', 'uncommitted'],
  ]);
  assert.match(r.note ?? '', /Committed 3 suggestions\. Not applied: src\/parser\.ts:11/);
  assert.equal(git('rev-parse', 'HEAD~1'), head);
  assert.equal(
    git('log', '-1', '--format=%B'),
    'Apply suggestions from code review\n\nCo-authored-by: hubot <123+hubot@users.noreply.github.com>\nCo-authored-by: monalisa <monalisa@users.noreply.github.com>',
  );
  assert.deepEqual(git('show', '--format=', '--name-only', 'HEAD').split('\n'), ['src/parser.ts']);
  assert.match(git('show', 'HEAD:src/parser.ts'), /name: string; \/\/ the widget\n[\s\S]*specs: Spec\[\] = \[\]; \/\/ parsed\n {2}let i = 0; \/\/ next token\n/);
  assert.equal(git('status', '--porcelain'), 'M src/errors.ts');
  // Undo: HEAD goes back, the suggestions stay in the file, staged.
  await repo.undo();
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.match(readFileSync(`${dir}/src/parser.ts`, 'utf8'), /\/\/ parsed/);
  assert.match(git('status', '--porcelain', 'src/parser.ts'), /^M {2}src\/parser\.ts$/);
});
