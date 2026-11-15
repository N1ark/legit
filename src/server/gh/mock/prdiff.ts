// Fake GitHub for reading pull requests without checking them out: refs/pull/<n>/head in the
// demo's remote follows each pull request's branch, as GitHub's does; every commit, a page at a
// time; and #18, from monalisa's fork, whose first version (the one octocat reviewed) was
// force-pushed away after main moved on (scripts/gh-demo.ts builds its history in the remote).

import { execFileSync } from 'node:child_process';
import { db, onGraphql } from './registry.ts';
import { prCommits } from './prview.ts';
import { remoteDir, remoteSha } from './remote.ts';

const actor = (login: string) => ({ login, avatarUrl: `https://github.com/${login}.png` });
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const pull = (n: number) => db.pulls.find((p: any) => p.number === n);

/** Point each pull request's refs/pull/<n>/head at its branch, where the remote has it (a fork's stays as it was pushed). */
db.syncPulls = (gitDir: string) => {
  db.gitDir = gitDir;
  const dir = remoteDir();
  if (!dir) return;
  const lines = db.pulls.flatMap((p: any) => {
    const sha = p.fork ? null : remoteSha(`refs/heads/${p.headRefName}`);
    return sha ? [`update refs/pull/${p.number}/head ${sha}\n`] : [];
  });
  if (lines.length) execFileSync('git', ['-C', dir, 'update-ref', '--stdin'], { input: lines.join('') });
};

onGraphql('PrCommits', (v) => {
  const p = pull(v.number);
  if (!p) return { repository: { pullRequest: null } };
  const list = prCommits(p);
  const at = Number(v.after ?? 0);
  return {
    repository: {
      pullRequest: {
        commits: {
          pageInfo: { hasNextPage: at + 100 < list.length, endCursor: String(at + 100) },
          nodes: list.slice(at, at + 100).map((commit: unknown) => ({ commit })),
        },
      },
    },
  };
});

/** A commit node read from the remote when it's asked for (the demo's SHAs differ from run to run). */
const commitOf = (ref: string) => ({
  get oid() {
    return remoteSha(ref) ?? '0'.repeat(40);
  },
  get abbreviatedOid() {
    return (remoteSha(ref) ?? '0000000').slice(0, 7);
  },
});

if (!pull(18)) {
  db.pulls.push({
    number: 18, title: 'Rebuild specs when their files change', state: 'OPEN', isDraft: false, baseRefName: 'main',
    headRefName: 'watch-specs', headRefOid: '0'.repeat(40), author: actor('monalisa'), headRepositoryOwner: { login: 'monalisa' }, fork: true,
    body: '`widgets build --watch` rebuilds a spec as soon as its file is saved.',
  });
  db.prview[18] = {
    createdAt: ago(30), labels: ['enhancement'], assignees: [], requested: [], checks: 'SUCCESS',
    additions: 23, deletions: 0, changedFiles: 3, autoMerge: null,
    timeline: [
      {
        __typename: 'PullRequestReview', id: 'PRR_kwDO1801', author: actor('octocat'), state: 'COMMENTED', createdAt: ago(20), submittedAt: ago(20),
        body: 'Nice! Two things: debounce the rebuilds, and say which file changed.', comments: { totalCount: 0 }, commit: commitOf('refs/demo/18/reviewed'),
      },
      {
        __typename: 'HeadRefForcePushedEvent', id: 'EV_kwDO1803', actor: actor('monalisa'), createdAt: ago(3.5),
        beforeCommit: commitOf('refs/demo/18/before'), afterCommit: commitOf('refs/pull/18/head'),
      },
      {
        __typename: 'IssueComment', id: 'IC_kwDO1802', databaseId: 1802, author: actor('monalisa'), body: 'Both done, and rebased on main.',
        createdAt: ago(3), lastEditedAt: null,
      },
    ],
  };
}

const api = (path: string) => `https://api.github.com/repos/acme/widgets/${path}`;
db.notifications?.unshift({
  id: '918', unread: true, reason: 'comment', updated_at: ago(3), repository: { full_name: 'acme/widgets' },
  subject: { title: 'Rebuild specs when their files change', type: 'PullRequest', url: api('pulls/18'), latest_comment_url: api('issues/comments/1802') },
});

// #13's force-push: its old tip is long gone from GitHub.
for (const t of db.prview[13]?.timeline ?? []) {
  if (t.__typename !== 'HeadRefForcePushedEvent') continue;
  t.beforeCommit = { oid: 'a71c0de'.padEnd(40, '9'), abbreviatedOid: 'a71c0de' };
  t.afterCommit = {
    get oid() {
      return db.tips['feature/parser-errors'] ?? '0'.repeat(40);
    },
    get abbreviatedOid() {
      return (db.tips['feature/parser-errors'] ?? '0000000').slice(0, 7);
    },
  };
}
