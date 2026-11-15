import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversation } from '../src/ui/lib/gh-conversation.ts';
import type { PrCommit, PrItem } from '../src/shared/gh-prview.ts';

const at = (h: number) => new Date(Date.UTC(2026, 9, 1, h)).toISOString();
const me = { login: 'octocat', avatar: '' };
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
const commits = ['c1', 'c2', 'c3', 'c4', 'c5'].map((s, i) => commit(s, i ? 'octocat' : 'hubot'));
const input = { timeline, commits };

test('the conversation interleaves everything by time, commits the timeline lacks first', () => {
  const all = conversation(input);
  assert.deepEqual(all.map((e) => e.key), ['earlier:c1', 'earlier:c2', 'p1', 'i1', 'R1', 'p2', 'R2', 'e1']);
  const earlier = all[0];
  assert.deepEqual(earlier.kind === 'commits' && [earlier.at, earlier.actor?.login, earlier.commits.map((x) => x.sha)], [null, 'hubot', ['c1']]);
});

test('newest first is the same conversation reversed, each push keeping its own order', () => {
  const all = conversation(input, true);
  assert.deepEqual(all.map((e) => e.key), conversation(input).map((e) => e.key).reverse());
  const p2 = all.find((e) => e.key === 'p2');
  assert.deepEqual(p2?.kind === 'commits' && p2.commits.map((x) => x.sha), ['c4', 'c5']);
});
