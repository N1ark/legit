import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toReview, withSuggestion } from '../src/server/gh/review.ts';
import type { ReviewThread } from '../src/shared/gh-review.ts';
import {
  commentTarget,
  heightAbove,
  layOut,
  commentedLines,
  hunkLines,
  linesLabel,
  newText,
  placeThreads,
  splitSuggestions,
  suggestionBlock,
  threadOrder,
} from '../src/ui/lib/gh-threads.ts';
import { buildRows } from '../src/ui/lib/rows.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const GONE = 'f'.repeat(40);

/** Rows of one hunk from a unified diff's body. */
function rows(oldStart: number, newStart: number, body: string[]) {
  return buildRows([{ header: `@@ -${oldStart} +${newStart} @@`, oldStart, newStart, types: body.map((l) => l[0]).join(''), text: body.map((l) => l.slice(1)), eof: [] }]);
}

function thread(over: Partial<ReviewThread> & { hunk?: string; commit?: string | null } = {}): ReviewThread {
  const { hunk = '', commit = A, ...rest } = over;
  return {
    id: 'T',
    path: 'src/x.ts',
    resolved: false,
    outdated: false,
    line: null,
    startLine: null,
    originalLine: null,
    originalStartLine: null,
    side: 'RIGHT',
    startSide: null,
    subject: 'LINE',
    resolvedBy: null,
    canResolve: true,
    canUnresolve: false,
    canReply: true,
    comments: [
      {
        id: 'C', databaseId: 1, body: 'hi', author: null, createdAt: '', lastEditedAt: null, url: '', diffHunk: hunk,
        originalCommit: commit, commit: null, canEdit: false, canDelete: false, pending: false, reactions: [],
      },
    ],
    ...rest,
  };
}

// The commit A's diff of src/x.ts: one hunk changing line 11.
const DIFF = rows(10, 10, [' function f() {', '-  return 1;', '+  return 2;', '+  // two', ' }']);
const HUNK = '@@ -10,4 +10,5 @@\n function f() {\n-  return 1;\n+  return 2;';
const at = (ts: ReviewThread[], ctx = { sha: A, head: false, base: false }) => placeThreads(ts, DIFF, ctx);

test('hunk lines keep their kinds and drop headers', () => {
  assert.deepEqual(hunkLines(HUNK), [
    { kind: ' ', text: 'function f() {' },
    { kind: '-', text: '  return 1;' },
    { kind: '+', text: '  return 2;' },
  ]);
  assert.deepEqual(hunkLines('@@ -1 +1 @@\n+a\n\\ No newline at end of file\n'), [{ kind: '+', text: 'a' }]);
});

test('a thread on the commit shown goes on its line, on either side', () => {
  const right = thread({ originalLine: 11, hunk: HUNK });
  const left = thread({ side: 'LEFT', originalLine: 11, hunk: '@@ -10,4 +10,5 @@\n function f() {\n-  return 1;' });
  const { placed } = at([right, left]);
  assert.deepEqual(placed.map((p) => [p.thread, p.row, p.moved]), [[left, 2, false], [right, 3, false]]);
});

test('a thread from a rewritten commit is found by its text near where it was', () => {
  const t = thread({ commit: GONE, originalLine: 14, hunk: '@@ -1 +1 @@\n function f() {\n-  return 1;\n+  return 2;' });
  const { placed, elsewhere } = at([t]);
  assert.deepEqual(placed.map((p) => [p.row, p.moved]), [[3, true]]);
  assert.deepEqual(elsewhere, []);
  // Text that isn't in the diff (or only as context) places nothing, and it isn't this commit's.
  const other = thread({ commit: GONE, originalLine: 11, hunk: '@@ -1 +1 @@\n+  return 3;' });
  const ctx = thread({ commit: GONE, originalLine: 10, hunk: '@@ -1 +1 @@\n function f() {' });
  assert.deepEqual(at([other, ctx]), { placed: [], elsewhere: [] });
});

test('short lines need their context to agree, long ones only need to be near', () => {
  const short = rows(1, 1, [' a', '+}', ' b', ' c', ' d', '+}']);
  const hunk = (before: string) => `@@ -1 +1 @@\n ${before}\n+}`;
  const ctx = { sha: A, head: false, base: false };
  assert.equal(placeThreads([thread({ commit: GONE, originalLine: 2, hunk: hunk('d') })], short, ctx).placed[0].row, 6);
  assert.equal(placeThreads([thread({ commit: GONE, originalLine: 2, hunk: hunk('zzz') })], short, ctx).placed.length, 0);
  const far = rows(500, 500, ['+  return 2;']);
  assert.equal(placeThreads([thread({ commit: GONE, originalLine: 11, hunk: HUNK })], far, ctx).placed.length, 0);
  assert.equal(placeThreads([thread({ commit: GONE, originalLine: 450, hunk: HUNK })], far, ctx).placed.length, 1);
});

test("on the commit it was made on, a change thread isn't put on a line that's only context here", () => {
  // Made on the PR's full diff at A, on a line an earlier commit added: here it's context.
  const t = thread({ originalLine: 10, hunk: '@@ -1 +1 @@\n+function f() {' });
  const { placed, elsewhere } = at([t]);
  assert.equal(placed.length, 0);
  assert.deepEqual(elsewhere, [t]);
});

test("on the pull request's head, threads go by their current line", () => {
  const t = thread({ commit: GONE, line: 12, startLine: 11, originalLine: 40, hunk: '@@ -1 +1 @@\n+unrelated' });
  const left = thread({ commit: GONE, side: 'LEFT', line: 11, hunk: '@@ -1 +1 @@\n-  return 1;' });
  const head = { sha: null, head: true, base: false };
  const r = placeThreads([t, left], DIFF, head);
  // Removed lines are the base's: by number only when the diff starts there, else by their text.
  assert.deepEqual(r.placed.map((p) => [p.row, p.start, p.moved]), [[2, 2, true], [4, 3, false]]);
  assert.deepEqual(placeThreads([left], DIFF, { ...head, base: true }).placed.map((p) => p.moved), [false]);
  const gone = thread({ commit: GONE, side: 'LEFT', line: 11, hunk: '@@ -1 +1 @@\n-  return 0;' });
  assert.deepEqual(placeThreads([gone], DIFF, head), { placed: [], elsewhere: [gone] });
  const outdated = thread({ commit: GONE, outdated: true, originalLine: 11, hunk: HUNK });
  assert.deepEqual(placeThreads([outdated], DIFF, head), { placed: [], elsewhere: [outdated] });
});

test('multi-line threads span their rows; file threads are elsewhere', () => {
  const t = thread({ originalStartLine: 10, originalLine: 12, hunk: HUNK + '\n+  // two' });
  const file = thread({ subject: 'FILE', hunk: '' });
  const r = at([file, t]);
  assert.deepEqual(r.placed.map((p) => [p.row, p.start]), [[4, 1]]);
  assert.deepEqual(r.elsewhere, [file]);
  assert.equal(linesLabel(t), 'lines 10–12');
  assert.equal(linesLabel(file), 'the file');
  assert.equal(linesLabel(thread({ line: 3, originalLine: 9 })), 'line 3');
});

test("a range starting in folded lines marks what's shown of it", () => {
  const t = thread({ originalStartLine: 5, originalLine: 12, hunk: HUNK + '\n+  // two' });
  assert.deepEqual(at([t]).placed.map((p) => [p.row, p.start]), [[4, 1]]);
});

test('where a new comment goes', () => {
  assert.deepEqual(commentTarget(DIFF, 3, 3, { base: false }), { side: 'RIGHT', line: 11 });
  assert.deepEqual(commentTarget(DIFF, 4, 1, { base: false }), { side: 'RIGHT', line: 12, startLine: 10, startSide: 'RIGHT' });
  assert.deepEqual(commentTarget(DIFF, 1, 2, { base: true }), { side: 'LEFT', line: 11, startLine: 10, startSide: 'RIGHT' });
  assert.ok('error' in commentTarget(DIFF, 2, 2, { base: false }));
  assert.ok('error' in commentTarget(DIFF, 0, 2, { base: true }));
  assert.deepEqual(newText(DIFF, 1, 4), ['function f() {', '  return 2;', '  // two']);
});

test('suggestions come out of a comment, in order', () => {
  const body = 'Try:\n\n```suggestion\n  return 3;\n  // three\n```\n\nor nothing:\n```suggestion\n```\nthanks';
  assert.deepEqual(splitSuggestions(body), [
    { md: 'Try:\n\n' },
    { suggestion: ['  return 3;', '  // three'] },
    { md: '\nor nothing:\n' },
    { suggestion: [] },
    { md: 'thanks' },
  ]);
  assert.deepEqual(splitSuggestions('```ts\ncode\n```'), [{ md: '```ts\ncode\n```' }]);
  assert.equal(suggestionBlock(['a', 'b']), '```suggestion\na\nb\n```');
  assert.equal(suggestionBlock(['```']), '````suggestion\n```\n````');
});

test("a suggestion replaces the commented lines, read from the thread's hunk", () => {
  const t = thread({ originalStartLine: 11, originalLine: 12, hunk: HUNK + '\n+  // two' });
  assert.deepEqual(commentedLines(t), ['  return 2;', '  // two']);
  assert.equal(commentedLines(thread({ side: 'LEFT', originalLine: 11, hunk: HUNK })), null);
});

test('applying a suggestion to a file', () => {
  const file = 'a\nb\nc\nd\n';
  assert.deepEqual(withSuggestion(file, { startLine: 2, lines: ['b', 'c'], replacement: ['B'] }), { text: 'a\nB\nd\n', at: 2 });
  // Moved: found where it is now, when that's the only place.
  assert.deepEqual(withSuggestion('x\n' + file, { startLine: 2, lines: ['b'], replacement: ['B', 'BB'] }), { text: 'x\na\nB\nBB\nc\nd\n', at: 3 });
  assert.match((withSuggestion(file, { startLine: 2, lines: ['q'], replacement: [] }) as { error: string }).error, /no longer has/);
  assert.match((withSuggestion('b\nb\n', { startLine: 5, lines: ['b'], replacement: [] }) as { error: string }).error, /more than once/);
  // Line endings stay the file's; a last line without a newline stays without one.
  assert.deepEqual(withSuggestion('a\r\nb\r\n', { startLine: 2, lines: ['b'], replacement: ['c'] }), { text: 'a\r\nc\r\n', at: 2 });
  assert.deepEqual(withSuggestion('a\nb', { startLine: 2, lines: ['b'], replacement: ['c'] }), { text: 'a\nc', at: 2 });
  assert.deepEqual(withSuggestion('a\nb\n', { startLine: 2, lines: ['b'], replacement: [] }), { text: 'a\n', at: 2 });
});

test("GitHub's payload becomes a review", () => {
  const node = (over: object) => ({
    id: 'T', isResolved: false, isOutdated: false, path: 'p', line: 3, startLine: null, originalLine: 3, originalStartLine: null,
    diffSide: 'RIGHT', startDiffSide: null, subjectType: 'LINE', viewerCanResolve: true, viewerCanUnresolve: false, viewerCanReply: true,
    resolvedBy: null, comments: { nodes: [] }, ...over,
  });
  const comment = {
    id: 'C', databaseId: 7, body: 'b', createdAt: 't', lastEditedAt: null, url: 'u', diffHunk: 'h', viewerCanUpdate: true, viewerCanDelete: false,
    author: { login: 'me', avatarUrl: 'av' }, originalCommit: { oid: A }, commit: null, pullRequestReview: { id: 'R', state: 'PENDING' },
    reactionGroups: [{ content: 'HEART', viewerHasReacted: true, reactors: { totalCount: 2 } }, { content: 'EYES', viewerHasReacted: false, reactors: { totalCount: 0 } }],
  };
  const r = toReview('me', {
    number: 5, headRefOid: B, baseRefOid: A,
    commits: { nodes: [{ commit: { oid: A } }, { commit: { oid: B } }] },
    reviews: { nodes: [{ id: 'R', viewerDidAuthor: true, comments: { totalCount: 1 } }] },
    reviewThreads: { nodes: [node({ comments: { nodes: [comment] }, isResolved: true, resolvedBy: { login: 'x' } }), node({ id: 'empty' })] },
  });
  assert.deepEqual(r.commits, [A, B]);
  assert.deepEqual(r.pending, { id: 'R', comments: 1 });
  assert.equal(r.threads.length, 1);
  const [t] = r.threads;
  assert.equal(t.resolved, true);
  assert.equal(t.resolvedBy, 'x');
  assert.deepEqual(t.comments[0].reactions, [{ content: 'HEART', count: 2, mine: true }]);
  assert.equal(t.comments[0].pending, true);
  assert.equal(t.comments[0].author?.avatar, 'av');
  assert.deepEqual([t, { ...t, id: 'U', resolved: false }].sort(threadOrder).map((x) => x.id), ['U', 'T']);
});

test('blocks under rows push the rows after them down', () => {
  const a = layOut([{ row: 2, start: 1, h: 10 }, { row: 2, start: 2, h: 5 }, { row: 7, start: 7, h: 20 }], (b) => b.h);
  assert.deepEqual([0, 2, 3, 7, 8, 100].map((r) => heightAbove(a, r)), [0, 0, 15, 15, 35, 35]);
  assert.deepEqual([...a.on].sort(), [1, 2, 7]);
  assert.equal(a.byRow.get(2)?.length, 2);
});
