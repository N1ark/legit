// Fake notifications: the demo repo's pull requests and issues, and a few from other repos.

import { db, onRest } from './registry.ts';

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const api = (repo: string, path: string) => `https://api.github.com/repos/${repo}/${path}`;
const thread = (id: number, repo: string, reason: string, type: string, title: string, subject: string | null, comment: string | null, min: number, unread = true) => ({
  id: String(id),
  unread,
  reason,
  updated_at: ago(min),
  repository: { full_name: repo },
  subject: { title, type, url: subject && api(repo, subject), latest_comment_url: comment && api(repo, comment) },
});

db.notifications = [
  thread(901, 'acme/widgets', 'review_requested', 'PullRequest', 'Pretty-print parse errors', 'pulls/14', null, 4),
  thread(902, 'acme/widgets', 'comment', 'PullRequest', 'Report parse errors with line numbers', 'pulls/13', 'pulls/comments/5551', 18),
  thread(903, 'acme/widgets', 'mention', 'Issue', 'Specs with nested blocks fail to parse', 'issues/7', 'issues/comments/7781', 55),
  thread(904, 'acme/widgets', 'ci_activity', 'CheckSuite', 'CI workflow run failed for feature/parser-errors branch', null, null, 70),
  thread(905, 'acme/widgets', 'author', 'PullRequest', 'Add a parser for widget specs', 'pulls/12', 'issues/comments/7790', 140, false),
  thread(906, 'acme/gadgets', 'assign', 'Issue', 'Crash when the config file is empty', 'issues/41', null, 300),
  thread(909, 'acme/widgets', 'state_change', 'PullRequest', 'Fix a typo in the README', 'pulls/9', null, 600, false),
  thread(910, 'acme/widgets', 'comment', 'Issue', 'Build fails on Windows paths', 'issues/3', 'issues/comments/7702', 900, false),
  thread(907, 'acme/gadgets', 'subscribed', 'Release', 'v2.3.0', 'releases/123', null, 1500, false),
  thread(908, 'octocat/dotfiles', 'team_mention', 'Discussion', 'Sharing a zsh prompt across machines', null, null, 2900, false),
];

const find = (id: string) => db.notifications.find((n: any) => n.id === id);

onRest('GET /notifications', (_, q) => (q.get('all') === 'true' ? db.notifications : db.notifications.filter((n: any) => n.unread)));
onRest('PATCH /notifications/threads/:id', ({ id }) => {
  const n = find(id);
  if (n) n.unread = false;
});
onRest('DELETE /notifications/threads/:id', ({ id }) => {
  db.notifications = db.notifications.filter((n: any) => n.id !== id);
});
onRest('PUT /notifications/threads/:id/subscription', () => ({ ignored: true }));
onRest('PUT /notifications', (_, __, b) => {
  for (const n of db.notifications) if (n.updated_at <= b.last_read_at) n.unread = false;
});
onRest('PUT /repos/:owner/:repo/notifications', ({ owner, repo }, __, b) => {
  for (const n of db.notifications) if (n.repository.full_name === `${owner}/${repo}` && n.updated_at <= b.last_read_at) n.unread = false;
});
