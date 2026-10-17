import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notificationUrl, toNotification } from '../src/server/gh/notifications.ts';

const api = 'https://api.github.com/repos/acme/widgets/';

test('a notification links to its pull request, issue or commit, at the latest comment', () => {
  assert.equal(notificationUrl('acme/widgets', `${api}pulls/13`, null, 'PullRequest'), 'https://github.com/acme/widgets/pull/13');
  assert.equal(
    notificationUrl('acme/widgets', `${api}pulls/13`, `${api}pulls/comments/5551`, 'PullRequest'),
    'https://github.com/acme/widgets/pull/13#discussion_r5551',
  );
  assert.equal(
    notificationUrl('acme/widgets', `${api}issues/7`, `${api}issues/comments/42`, 'Issue'),
    'https://github.com/acme/widgets/issues/7#issuecomment-42',
  );
  assert.equal(notificationUrl('acme/widgets', `${api}commits/abc123`, null, 'Commit'), 'https://github.com/acme/widgets/commit/abc123');
  assert.equal(notificationUrl('acme/widgets', `${api}releases/9`, null, 'Release'), 'https://github.com/acme/widgets/releases');
  assert.equal(notificationUrl('acme/widgets', null, null, 'CheckSuite'), 'https://github.com/acme/widgets/actions');
  // Another repo's URL is never trusted as this one's path.
  assert.equal(notificationUrl('acme/widgets', 'https://api.github.com/repos/evil/x/pulls/1', null, 'PullRequest'), 'https://github.com/acme/widgets');
});

test("GitHub's notification threads, as the panel shows them", () => {
  const n = toNotification({
    id: 901, unread: true, reason: 'review_requested', updated_at: '2026-10-17T10:00:00Z',
    repository: { full_name: 'acme/widgets' },
    subject: { title: 'Pretty-print parse errors', type: 'PullRequest', url: `${api}pulls/14`, latest_comment_url: null },
  });
  assert.deepEqual(n, {
    id: '901', unread: true, reason: 'Review requested', updatedAt: Date.parse('2026-10-17T10:00:00Z'), repo: 'acme/widgets',
    title: 'Pretty-print parse errors', type: 'PullRequest', number: 14, url: 'https://github.com/acme/widgets/pull/14',
  });
  const odd = toNotification({
    id: '5', unread: false, reason: 'some_new_reason', updated_at: '2026-10-17T10:00:00Z', repository: { full_name: 'a/b' },
    subject: { title: 'x', type: 'RepositoryVulnerabilityAlert', url: null, latest_comment_url: null },
  });
  assert.equal(odd.reason, 'Some new reason');
  assert.equal(odd.type, 'Other');
  assert.equal(odd.number, null);
});
