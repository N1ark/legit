import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversation, unresolvedOf } from '../src/ui/lib/gh-conversation.ts';
import type { PrCommit, PrItem } from '../src/shared/gh-prview.ts';
import type { ReviewComment, ReviewThread } from '../src/shared/gh-review.ts';

const at = (h: number) => new Date(Date.UTC(2026, 9, 1, h)).toISOString();
const me = { login: 'octocat', avatar: '' };
const c = (id: string, h: number, reviewId: string | null): ReviewComment => ({
  id, databaseId: 1, body: id, author: me, createdAt: at(h), lastEditedAt: null, url: '', diffHunk: '', originalCommit: null, commit: null,
  canEdit: false, canDelete: false, pending: false, reviewId, reactions: [],
});
const thread = (id: string, comments: ReviewComment[], resolved = false): ReviewThread => ({
  id, path: 'a.ts', resolved, outdated: false, line: 1, startLine: null, originalLine: 1, originalStartLine: null, side: 'RIGHT', startSide: null,
  subject: 'LINE', resolvedBy: null, canResolve: true, canUnresolve: false, canReply: true, comments,
});
const commit = (sha: string, author = 'octocat'): PrCommit => ({ sha, short: sha, headline: sha, author, checks: 'success' });
const pushed = (id: string, h: number, shas: string[]): PrItem => ({ id, kind: 'commits', actor: me, at: at(h), commits: shas.map((s) => ({ sha: s, short: s, headline: s, checks: 'success' })) });
const timeline: PrItem[] = [
  pushed('p1', 1, ['c3']),
  { id: 'R1', kind: 'review', actor: me, at: at(4), state: 'commented', body: '', comments: 2 },
  { id: 'i1', kind: 'comment', actor: me, at: at(3), dbId: 1, body: 'hi', edited: false, canEdit: false, canDelete: false },
  { id: 'R2', kind: 'review', actor: me, at: at(8), state: 'approved', body: 'ok', comments: 1 },
  pushed('p2', 6, ['c4', 'c5']),
  { id: 'e1', kind: 'event', actor: me, at: at(9), type: 'force-pushed' },
];
const threads = [
  thread('T2', [c('b', 3.5, 'R1')], true),
  thread('T1', [c('a', 2, 'R1'), c('reply', 7, 'R2')]),
  thread('T3', [c('alone', 5, 'RX')]),
  thread('T4', [c('mine', 10, 'PEND')]),
];
const commits = ['c1', 'c2', 'c3', 'c4', 'c5'].map((s, i) => commit(s, i ? 'octocat' : 'hubot'));
const input = { timeline, threads, commits, pending: 'PEND' };

test('the conversation interleaves everything by time, reviews holding the threads started in them', () => {
  const all = conversation(input);
  assert.deepEqual(all.map((e) => e.key), ['earlier:c1', 'earlier:c2', 'p1', 'i1', 'R1', 'T3', 'p2', 'R2', 'e1', 'PEND']);
  const r1 = all.find((e) => e.key === 'R1');
  assert.deepEqual(r1?.kind === 'review' && r1.threads.map((t) => t.id), ['T1', 'T2'], 'by when each started');
  const r2 = all.find((e) => e.key === 'R2');
  assert.deepEqual(r2?.kind === 'review' && [r2.threads.length, r2.replies.map((t) => t.id)], [0, ['T1']], 'a reply points at its thread');
  const earlier = all[0];
  assert.deepEqual(earlier.kind === 'commits' && [earlier.at, earlier.actor?.login, earlier.commits.map((x) => x.sha)], [null, 'hubot', ['c1']]);
  const pending = all.at(-1);
  assert.deepEqual(pending?.kind === 'review' && [pending.review, pending.at, pending.threads.map((t) => t.id)], [null, at(10), ['T4']]);
  assert.deepEqual(unresolvedOf(all).map((t) => t.id), ['T1', 'T3', 'T4']);
});

test('newest first is the same conversation reversed, each review and push keeping its own order', () => {
  const all = conversation(input, true);
  assert.deepEqual(all.map((e) => e.key), conversation(input).map((e) => e.key).reverse());
  const p2 = all.find((e) => e.key === 'p2');
  assert.deepEqual(p2?.kind === 'commits' && p2.commits.map((x) => x.sha), ['c4', 'c5']);
  assert.deepEqual(unresolvedOf(all).map((t) => t.id), ['T4', 'T3', 'T1']);
});

test('without threads loaded, or the pending review, reviews stand alone and nothing is lost', () => {
  const all = conversation({ ...input, threads: [], pending: null });
  assert.equal(all.filter((e) => e.kind === 'review').length, 2);
  const lone = conversation({ ...input, pending: null }).find((e) => e.key === 'T4');
  assert.equal(lone?.kind, 'thread', "a thread of a review that isn't listed is shown at its own time");
});
