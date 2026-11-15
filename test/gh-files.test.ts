import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Annotation } from '../src/shared/gh-files.ts';
import { countNotes, describeNotes, noteLines, placeNotes, viewedCount } from '../src/ui/lib/gh-files.ts';
import { buildRows } from '../src/ui/lib/rows.ts';

// Against the fake GitHub, on the demo repo (scripts/gh-demo.ts), as gh-cache.test.ts does.
process.env.LEGIT_GITHUB_MOCK = '1';
const { Repo } = await import('../src/server/repo.ts');
await import('../src/server/gh/mock/index.ts');
const { db, mockCalls } = await import('../src/server/gh/mock/registry.ts');
const { githubRoute } = await import('../src/server/gh/routes.ts');
const { codeownersOf } = await import('../src/server/gh/prfiles.ts');
const { toAnnotation } = await import('../src/server/gh/annotations.ts');

const dir = mkdtempSync(join(tmpdir(), 'legit-gh-files-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const demo = join(dir, 'demo');
execFileSync('node', ['scripts/gh-demo.ts', demo], { stdio: 'ignore' });
const git = (...args: string[]) => execFileSync('git', args, { cwd: demo, encoding: 'utf8' }).trim();

const note = (startLine: number, endLine = startLine, level: Annotation['level'] = 'warning', key = `${startLine}`): Annotation => ({
  key, path: 'src/x.ts', startLine, endLine, level, title: null, message: 'm', details: null, check: 'lint', url: null,
});

/** One hunk: lines 10–11 unchanged, 12 removed, 12–13 added, 14 unchanged (new side). */
const ROWS = buildRows([
  { header: '@@ -10,4 +10,5 @@', oldStart: 10, newStart: 10, types: '  -++ ', text: ['a', 'b', 'old', 'new', 'newer', 'c'], eof: [] },
]);

test('annotations go under the last of their lines shown, from the first; others have no row', () => {
  const { placed, elsewhere } = placeNotes([note(13), note(10, 12, 'notice'), note(3), note(14, 40, 'failure'), note(12)], ROWS);
  const at = (k: string) => placed.find((p) => p.note.key === k);
  const row = (n: number) => [...ROWS.n].findIndex((x, r) => x === n && ROWS.kind[r] !== 0 && ROWS.kind[r] !== 3);
  assert.deepEqual({ row: at('13')!.row, start: at('13')!.start }, { row: row(13), start: row(13) });
  // Lines 10–12: the removed row in between isn't one of them.
  assert.deepEqual({ row: at('10')!.row, start: at('10')!.start }, { row: row(12), start: row(10) });
  // Partly past the hunk: on what's shown of it.
  assert.deepEqual({ row: at('14')!.row, start: at('14')!.start }, { row: row(14), start: row(14) });
  assert.deepEqual(elsewhere.map((a) => a.key), ['3']);
  // In row order; a failure before a notice on the same row.
  assert.deepEqual(placed.map((p) => p.row), [...placed.map((p) => p.row)].sort((a, b) => a - b));
  const same = placeNotes([note(12, 12, 'notice', 'n'), note(12, 12, 'failure', 'f')], ROWS).placed.map((p) => p.note.key);
  assert.deepEqual(same, ['f', 'n']);
});

test('how a file’s annotations add up', () => {
  assert.equal(countNotes([]), null);
  const c = countNotes([note(1, 1, 'notice'), note(2, 2, 'warning'), note(3, 3, 'warning')])!;
  assert.deepEqual(c, { count: 3, level: 'warning', failure: 0, warning: 2, notice: 1 });
  assert.equal(describeNotes(c), '2 warnings, 1 notice');
  assert.equal(describeNotes(countNotes([note(1, 1, 'failure')])!), '1 failure');
  assert.equal(noteLines(note(4)), 'line 4');
  assert.equal(noteLines(note(4, 9)), 'lines 4–9');
});

test("viewed counts the pull request's files shown; a dismissed mark isn't viewed", () => {
  const viewed = { 'a.ts': 'VIEWED', 'b.ts': 'DISMISSED', 'c.ts': 'UNVIEWED', 'd.ts': 'VIEWED' } as const;
  assert.deepEqual(viewedCount(['a.ts', 'b.ts', 'c.ts', 'local.ts'], viewed), { viewed: 1, total: 3 });
  assert.deepEqual(viewedCount([], viewed), { viewed: 0, total: 0 });
});

test('REST annotations: levels, lines, and ones not on a file’s lines left out', () => {
  const run = { id: 7, name: 'lint', url: 'https://x/7' };
  const a = toAnnotation({ path: 'a.ts', start_line: 3, end_line: 5, annotation_level: 'warning', title: 'T', message: 'M', raw_details: '' }, run, 0)!;
  assert.deepEqual(a, { key: '7:0', path: 'a.ts', startLine: 3, endLine: 5, level: 'warning', title: 'T', message: 'M', details: null, check: 'lint', url: 'https://x/7' });
  assert.equal(toAnnotation({ path: 'a.ts', start_line: 3, end_line: 1, annotation_level: 'odd', message: 'M' }, run, 1)!.endLine, 3);
  assert.equal(toAnnotation({ path: 'a.ts', start_line: 3, annotation_level: 'odd', message: 'M' }, run, 1)!.level, 'notice');
  assert.equal(toAnnotation({ path: '', start_line: 3 }, run, 2), null);
  assert.equal(toAnnotation({ path: 'a.ts', start_line: 0 }, run, 2), null);
});

test('CODEOWNERS is the first of the three places the base has one', () => {
  assert.equal(codeownersOf(null), null);
  assert.deepEqual(codeownersOf({ o0: null, o1: { object: { text: 'x @a' } }, o2: { object: { text: 'y @b' } } }), { path: 'CODEOWNERS', text: 'x @a' });
  assert.deepEqual(codeownersOf({ o0: { object: { text: '' } } }), { path: '.github/CODEOWNERS', text: '' });
});

/** The GitHub calls `fn` makes. */
async function calls(fn: () => Promise<unknown>): Promise<string[]> {
  const from = mockCalls.length;
  await fn();
  return mockCalls.slice(from);
}

test("a pull request's files: viewed marks (dismissed by a later change) and CODEOWNERS in one query, more pages for more files", async () => {
  const repo = await Repo.open(demo);
  // Which repo it's on, looked up once.
  await githubRoute(repo, 'GET', 'prFiles', new URLSearchParams({ number: '13' }));
  let files: any;
  assert.deepEqual(await calls(async () => (files = await githubRoute(repo, 'GET', 'prFiles', new URLSearchParams({ number: '13', fresh: '1' })))), ['GraphQL PrFiles']);
  assert.deepEqual(files.viewed, { 'src/errors.ts': 'VIEWED', 'src/parser.ts': 'DISMISSED' });
  assert.equal(files.viewer, 'octocat');
  assert.equal(files.headSha, git('rev-parse', 'origin/feature/parser-errors'));
  assert.equal(files.codeowners.path, '.github/CODEOWNERS');
  assert.match(files.codeowners.text, /src\/parser\.ts @octocat @hubot/);

  db.filesPage = 1;
  try {
    const pages = await calls(async () => (files = await githubRoute(repo, 'GET', 'prFiles', new URLSearchParams({ number: '12', fresh: '1' }))));
    assert.deepEqual(pages, ['GraphQL PrFiles', 'GraphQL PrFiles', 'GraphQL PrFiles']);
    assert.deepEqual(Object.keys(files.viewed).sort(), ['src/build.ts', 'src/parser.ts', 'src/tokenizer.ts']);
    assert.ok(files.codeowners);
  } finally {
    db.filesPage = 100;
  }
});

test('marking a file viewed and not, kept for the next read; GitHub refusing it says why', async () => {
  const repo = await Repo.open(demo);
  const read = async () => ((await githubRoute(repo, 'GET', 'prFiles', new URLSearchParams({ number: '12' }))) as any).viewed;
  await githubRoute(repo, 'GET', 'prFiles', new URLSearchParams({ number: '12', fresh: '1' }));
  assert.deepEqual(await calls(() => githubRoute(repo, 'POST', 'prFileViewed', { number: 12, path: 'src/build.ts', viewed: true })), ['GraphQL MarkFileViewed']);
  assert.deepEqual(await calls(read), []);
  assert.equal((await read())['src/build.ts'], 'VIEWED');
  await githubRoute(repo, 'POST', 'prFileViewed', { number: 12, path: 'src/build.ts', viewed: false });
  assert.equal((await read())['src/build.ts'], 'UNVIEWED');
  await assert.rejects(githubRoute(repo, 'POST', 'prFileViewed', { number: 12, path: 'nope.ts', viewed: true }), /not part of the pull request/);
  await assert.rejects(githubRoute(repo, 'POST', 'prFileViewed', { number: 0, path: 'a', viewed: true }), /Bad pull request number/);
});

test("a commit's annotations: its check runs, then only the runs that have any", async () => {
  const repo = await Repo.open(demo);
  const sha = git('rev-parse', 'origin/feature/parser-errors');
  let got: any;
  const asked = await calls(async () => (got = await githubRoute(repo, 'GET', 'annotations', new URLSearchParams({ sha }))));
  // Lint is still running (it finishes a minute in): build's and test's only.
  assert.equal(asked[0], 'GET /repos/acme/widgets/commits/' + sha + '/check-runs');
  assert.deepEqual(asked.slice(1).map((c) => c.replace(/\d+/, 'N')).sort(), ['GET /repos/acme/widgets/check-runs/N/annotations', 'GET /repos/acme/widgets/check-runs/N/annotations']);
  const failure = got.annotations.find((a: Annotation) => a.path === 'src/parser.ts');
  assert.equal(failure.level, 'failure');
  assert.equal(failure.startLine, 16);
  assert.equal(failure.check, 'test');
  assert.ok(got.annotations.some((a: Annotation) => a.path === '.github'));
  // Finished runs' annotations are kept: asking again only lists the runs.
  assert.equal((await calls(() => githubRoute(repo, 'GET', 'annotations', new URLSearchParams({ sha })))).length, 1);
  await assert.rejects(githubRoute(repo, 'GET', 'annotations', new URLSearchParams({ sha: 'abc' })), /Not a full commit SHA/);
});
