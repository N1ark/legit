// Fake conversations for the demo's pull requests: descriptions, comments, reviews, labels,
// events and merge states, changed by the overview's mutations. Commits come from the local repo.

import { execFileSync } from 'node:child_process';
import { GithubError } from '../client.ts';
import { db, onGraphql, onRest } from './registry.ts';
import { restPull } from './stack.ts';
import { prNode } from './pulls.ts';

const avatar = (login: string) => `https://github.com/${login}.png`;
const actor = (login: string) => ({ login, avatarUrl: avatar(login) });
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

const LABELS: Record<string, string> = {
  bug: 'd73a4a', documentation: '0075ca', enhancement: 'a2eeef', parser: '5319e7', ux: 'fbca04', 'good first issue': '7057ff',
};
const DESCRIPTIONS: Record<string, string> = {
  bug: "Something isn't working", documentation: 'Improvements or additions to documentation', enhancement: 'New feature or request',
  'good first issue': 'Good for newcomers',
};
const USERS = ['octocat', 'hubot', 'monalisa', 'defunkt', 'mojombo'];

let ids = 100;
const nextId = (prefix: string) => `${prefix}_kwDO${++ids}`;

const comment = (login: string, hours: number, body: string) => ({
  __typename: 'IssueComment', id: nextId('IC'), databaseId: ++ids, author: actor(login), body, createdAt: ago(hours), lastEditedAt: null,
});
const review = (login: string, hours: number, state: string, body: string, comments = 0) => ({
  __typename: 'PullRequestReview', id: nextId('PRR'), author: actor(login), state, body, createdAt: ago(hours), submittedAt: ago(hours),
  comments: { totalCount: comments },
});
const event = (type: string, login: string, hours: number, more: Record<string, unknown> = {}) => ({
  __typename: type, id: nextId('EV'), actor: actor(login), createdAt: ago(hours), ...more,
});

interface Extra {
  createdAt: string;
  labels: string[];
  assignees: string[];
  /** Logins, or `org/team` for a team. */
  requested: string[];
  checks: 'SUCCESS' | 'FAILURE' | 'PENDING' | null;
  conflicts?: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  autoMerge: { method: string; by: string } | null;
  mergedAt?: string;
  mergedBy?: string;
  /** Timeline nodes after the commits, oldest first. */
  timeline: any[];
}

const pull = (n: number) => db.pulls.find((p: any) => p.number === n);

// #14 comes from someone else, so the viewer can review it.
if (pull(14)) pull(14).author = actor('monalisa');
if (pull(12)) {
  pull(12).body = [
    'Parses `.widget` files into specs, so the renderer no longer reads them by hand.',
    '',
    '## What changes',
    '',
    '- a **tokenizer** for the spec syntax (strings, numbers, nested blocks)',
    '- a recursive-descent **parser** producing `WidgetSpec`',
    '- `loadSpec()` now goes through the parser',
    '',
    'Closes #7',
  ].join('\n');
}
if (pull(13)) pull(13).body = 'Stacked on #12.\n\nParse errors now say where they happened:\n\n```\nspec.widget:12:4: expected `}`\n```';
if (pull(14)) pull(14).body = 'Stacked on #13.\n\nColours the location and points a caret at the column.';

db.prview = {
  9: {
    createdAt: ago(24 * 9), labels: ['documentation'], assignees: [], requested: [], checks: 'SUCCESS', additions: 1, deletions: 1, changedFiles: 1,
    autoMerge: null, mergedAt: ago(24 * 8), mergedBy: 'octocat',
    timeline: [
      comment('octocat', 24 * 8.5, 'Thanks!'),
      review('octocat', 24 * 8.2, 'APPROVED', ''),
      event('MergedEvent', 'octocat', 24 * 8, { commit: { abbreviatedOid: '3f2a9c1' }, mergeRefName: 'main' }),
      event('HeadRefDeletedEvent', 'octocat', 24 * 8, { headRefName: 'fix/typo' }),
    ],
  },
  12: {
    createdAt: ago(52), labels: ['enhancement', 'parser'], assignees: ['octocat'], requested: ['hubot'], checks: 'SUCCESS',
    additions: 214, deletions: 37, changedFiles: 6, autoMerge: null,
    timeline: [
      event('ReviewRequestedEvent', 'octocat', 51, { requestedReviewer: { login: 'monalisa' } }),
      event('ReviewRequestedEvent', 'octocat', 51, { requestedReviewer: { login: 'hubot' } }),
      event('LabeledEvent', 'octocat', 51, { label: { name: 'enhancement', color: LABELS.enhancement } }),
      event('LabeledEvent', 'octocat', 51, { label: { name: 'parser', color: LABELS.parser } }),
      comment('defunkt', 30, 'Does this handle nested specs? The `dashboard.widget` fixture has three levels of `panel { … }`.'),
      comment('octocat', 28, 'Yes: blocks recurse, and I added that fixture to the tests (`parser.test.ts`).'),
      review('monalisa', 20, 'APPROVED', 'Looks good. The tokenizer is much easier to follow than the old regex soup. 🎉'),
      comment('hubot', 6, 'CI passed on macOS, Linux and Windows.'),
    ],
  },
  13: {
    createdAt: ago(40), labels: ['parser'], assignees: ['octocat'], requested: [], checks: 'PENDING',
    additions: 58, deletions: 9, changedFiles: 3, autoMerge: null,
    timeline: [
      event('ConvertToDraftEvent', 'octocat', 39),
      review('hubot', 26, 'CHANGES_REQUESTED', 'Line numbers are off by one for files with CRLF line endings, see the two comments.', 2),
      event('HeadRefForcePushedEvent', 'octocat', 8, { beforeCommit: { abbreviatedOid: 'a71c0de' }, afterCommit: null }),
      comment('octocat', 7.5, "Fixed CRLF. Still working on columns for tabs, so it stays a draft for now."),
    ],
  },
  14: {
    createdAt: ago(5), labels: ['enhancement', 'ux'], assignees: [], requested: ['octocat', 'acme/core'], checks: 'PENDING',
    additions: 41, deletions: 4, changedFiles: 2, autoMerge: null,
    timeline: [
      event('ReviewRequestedEvent', 'monalisa', 4.9, { requestedReviewer: { login: 'octocat' } }),
      event('ReviewRequestedEvent', 'monalisa', 4.9, { requestedReviewer: { combinedSlug: 'acme/core' } }),
      comment('monalisa', 4.5, 'Before → after:\n\n```\nspec.widget:12:4: expected `}`\n      panel {\n         ^\n```\n\n@octocat could you take a look?'),
    ],
  },
} satisfies Record<number, Extra>;

/** The viewer's reviews in progress, by pull request; diff comments add to them. */
db.pending ??= {};
db.pending[12] ??= {
  id: nextId('PRR'),
  comments: [
    { path: 'src/parser.ts', line: 42, body: 'Nit: `expect()` could name the token it wanted.' },
    { path: 'src/tokenizer.ts', line: 17, body: 'Is `\\r` handled here?' },
  ],
};

const extra = (n: number): Extra => {
  const e = db.prview[n];
  if (!e) throw new GithubError('GitHub: Could not resolve to a PullRequest.', 404);
  return e;
};

/** The pull request's commits, from the local repo: `base..head`, as origin has them when it does. */
function commits(p: any, e: Extra) {
  const ref = (b: string) => (db.tips[`origin/${b}`] ? `origin/${b}` : db.tips[b] ? b : null);
  const [base, head] = [ref(p.baseRefName), ref(p.headRefName)];
  let rows: string[][] = [];
  if (db.gitDir && base && head) {
    try {
      const out = execFileSync('git', ['-C', db.gitDir, 'log', '--reverse', '--format=%H%x1f%h%x1f%s%x1f%an', `${base}..${head}`], { encoding: 'utf8' });
      rows = out.split('\n').filter(Boolean).map((l) => l.split('\x1f'));
    } catch {}
  }
  if (!rows.length) rows = [['3f2a9c1'.padEnd(40, '0'), '3f2a9c1', p.title, p.author.login]];
  return rows.map(([oid, short, headline, name], i) => ({
    oid, abbreviatedOid: short.slice(0, 7), messageHeadline: headline, committedDate: e.createdAt,
    author: { name, user: USERS.includes(name) ? actor(name) : p.author },
    statusCheckRollup: e.checks ? { state: i === rows.length - 1 ? e.checks : 'SUCCESS' } : null,
  }));
}

const reviewsOf = (e: Extra) => e.timeline.filter((t) => t.__typename === 'PullRequestReview');

/** Each reviewer's latest review, and the latest that approved or asked for changes. */
function latest(e: Extra, opinionated: boolean) {
  const by = new Map<string, any>();
  for (const r of reviewsOf(e)) {
    if (opinionated && r.state !== 'APPROVED' && r.state !== 'CHANGES_REQUESTED') continue;
    by.set(r.author.login, { author: r.author, state: r.state });
  }
  return [...by.values()];
}

function decision(e: Extra) {
  const states = latest(e, true).map((r) => r.state);
  return states.includes('CHANGES_REQUESTED') ? 'CHANGES_REQUESTED' : states.includes('APPROVED') ? 'APPROVED' : 'REVIEW_REQUIRED';
}

function mergeState(p: any, e: Extra) {
  if (p.state !== 'OPEN') return 'UNKNOWN';
  if (p.isDraft) return 'DRAFT';
  if (e.conflicts) return 'DIRTY';
  if (decision(e) !== 'APPROVED' || e.checks === 'PENDING') return 'BLOCKED';
  if (e.checks === 'FAILURE') return 'UNSTABLE';
  return 'CLEAN';
}

onGraphql('PrViewOverview', (v) => {
  const p = pull(v.number);
  if (!p) return { viewer: { login: db.viewer }, repository: { pullRequest: null } };
  const e = extra(p.number);
  const node = prNode(p);
  const list = commits(p, e);
  const pending = db.pending[p.number];
  return {
    viewer: { login: db.viewer },
    repository: {
      mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, autoMergeAllowed: true, deleteBranchOnMerge: false,
      viewerDefaultMergeMethod: 'SQUASH', squashMergeCommitTitle: 'PR_TITLE', squashMergeCommitMessage: 'COMMIT_MESSAGES',
      pullRequest: {
        ...node,
        id: `PR_kwDO${p.number}`,
        createdAt: e.createdAt,
        mergedAt: e.mergedAt ?? null,
        mergedBy: e.mergedBy ? actor(e.mergedBy) : null,
        headRefOid: node.headRefOid,
        mergeable: p.state !== 'OPEN' ? 'UNKNOWN' : e.conflicts ? 'CONFLICTING' : 'MERGEABLE',
        mergeStateStatus: mergeState(p, e),
        reviewDecision: decision(e),
        additions: e.additions,
        deletions: e.deletions,
        changedFiles: e.changedFiles,
        viewerCanUpdate: true,
        viewerDidAuthor: p.author?.login === db.viewer,
        viewerCanEnableAutoMerge: p.state === 'OPEN' && !e.autoMerge,
        viewerCanDisableAutoMerge: !!e.autoMerge,
        labels: { nodes: e.labels.map((name) => ({ name, color: LABELS[name] ?? 'ededed' })) },
        assignees: { nodes: e.assignees.map(actor) },
        reviewRequests: {
          nodes: e.requested.map((r) => ({ requestedReviewer: r.includes('/') ? { combinedSlug: r, avatarUrl: avatar(r.split('/')[0]) } : actor(r) })),
        },
        latestOpinionatedReviews: { nodes: latest(e, true) },
        latestReviews: { nodes: latest(e, false) },
        suggestedReviewers: ['defunkt', 'mojombo'].filter((u) => u !== p.author?.login).map((u) => ({ reviewer: actor(u) })),
        reviews: { nodes: pending ? [{ id: pending.id, author: { login: db.viewer }, comments: { totalCount: count(pending) } }] : [] },
        autoMergeRequest: e.autoMerge ? { mergeMethod: e.autoMerge.method, enabledBy: { login: e.autoMerge.by } } : null,
        commits: { totalCount: list.length, nodes: list.map((commit) => ({ commit })) },
        timelineItems: {
          nodes: [
            ...list.map((commit) => ({ __typename: 'PullRequestCommit', id: `PRC_${commit.oid}`, commit })),
            ...e.timeline.map((t) =>
              t.__typename === 'IssueComment' ? { ...t, viewerCanUpdate: t.author.login === db.viewer, viewerCanDelete: t.author.login === db.viewer }
              : t.__typename === 'HeadRefForcePushedEvent' ? { ...t, afterCommit: t.afterCommit ?? { abbreviatedOid: list.at(-1)?.abbreviatedOid } }
              : t,
            ),
          ].slice(-100),
        },
      },
    },
  };
});

const count = (pending: any) => (Array.isArray(pending.comments) ? pending.comments.length : Number(pending.comments) || 0);

onGraphql('PrViewOptions', () => ({
  repository: {
    assignableUsers: { nodes: USERS.map(actor) },
    labels: { nodes: Object.entries(LABELS).map(([name, color]) => ({ name, color, description: DESCRIPTIONS[name] ?? null })) },
    refs: { nodes: Object.keys(db.tips).filter((t) => !t.startsWith('origin/')).map((name) => ({ name })) },
  },
}));

onGraphql('PrViewPending', (v) => {
  const pending = db.pending[v.number];
  return { viewer: { login: db.viewer }, repository: { pullRequest: { reviews: { nodes: pending ? [{ id: pending.id, author: { login: db.viewer } }] : [] } } } };
});

const byId = (id: string) => db.pulls.find((p: any) => `PR_kwDO${p.number}` === id);

function draft(id: string, isDraft: boolean) {
  const p = byId(id);
  if (!p || p.state !== 'OPEN') throw new GithubError('GitHub: Pull request is not open.', 422);
  p.isDraft = isDraft;
  extra(p.number).timeline.push(event(isDraft ? 'ConvertToDraftEvent' : 'ReadyForReviewEvent', db.viewer, 0));
  return { clientMutationId: null };
}
onGraphql('PrViewToDraft', (v) => ({ convertPullRequestToDraft: draft(v.id, true) }));
onGraphql('PrViewReady', (v) => ({ markPullRequestReadyForReview: draft(v.id, false) }));

onGraphql('PrViewAutoMerge', (v) => {
  const p = byId(v.id);
  extra(p.number).autoMerge = { method: v.method, by: db.viewer };
  return { enablePullRequestAutoMerge: { clientMutationId: null } };
});
onGraphql('PrViewNoAutoMerge', (v) => {
  extra(byId(v.id).number).autoMerge = null;
  return { disablePullRequestAutoMerge: { clientMutationId: null } };
});

function addReview(number: number, event: string, body: string, comments: number) {
  const p = pull(number);
  if (event !== 'COMMENT' && p.author?.login === db.viewer) {
    throw new GithubError(`GitHub: Can not ${event === 'APPROVE' ? 'approve' : 'request changes on'} your own pull request`, 422);
  }
  const state = event === 'APPROVE' ? 'APPROVED' : event === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : 'COMMENTED';
  const e = extra(number);
  e.timeline.push(review(db.viewer, 0, state, body, comments));
  e.requested = e.requested.filter((r) => r !== db.viewer);
}

onGraphql('PrViewSubmitReview', (v) => {
  const number = Number(Object.keys(db.pending).find((k) => db.pending[k]?.id === v.id));
  if (!number) throw new GithubError('GitHub: Could not resolve to a PullRequestReview.', 404);
  addReview(number, v.event, v.body ?? '', count(db.pending[number]));
  delete db.pending[number];
  return { submitPullRequestReview: { clientMutationId: null } };
});
onGraphql('PrViewAddReview', (v) => {
  addReview(byId(v.id).number, v.event, v.body ?? '', 0);
  return { addPullRequestReview: { clientMutationId: null } };
});

const allComments = () => Object.values(db.prview as Record<string, Extra>).flatMap((e) => e.timeline.filter((t) => t.__typename === 'IssueComment'));

onRest('POST /repos/:owner/:repo/issues/:number/comments', (params, _, body) => {
  const c = comment(db.viewer, 0, body.body);
  extra(Number(params.number)).timeline.push(c);
  return { id: c.databaseId, node_id: c.id, body: c.body, user: { login: db.viewer } };
});

onRest('PATCH /repos/:owner/:repo/issues/comments/:id', (params, _, body) => {
  const c = allComments().find((t) => t.databaseId === Number(params.id));
  if (!c) throw new GithubError('GitHub: Not Found', 404);
  c.body = body.body;
  c.lastEditedAt = new Date().toISOString();
  return { id: c.databaseId, body: c.body };
});

onRest('DELETE /repos/:owner/:repo/issues/comments/:id', (params) => {
  for (const e of Object.values(db.prview as Record<string, Extra>)) e.timeline = e.timeline.filter((t) => t.databaseId !== Number(params.id));
  return null;
});

onRest('PATCH /repos/:owner/:repo/pulls/:number', (params, _, body) => {
  const p = pull(Number(params.number));
  if (!p) throw new GithubError('GitHub: Not Found', 404);
  const e = db.prview[p.number] as Extra | undefined;
  const log = (type: string, more?: Record<string, unknown>) => e?.timeline.push(event(type, db.viewer, 0, more));
  if (body.title !== undefined && body.title !== p.title) {
    log('RenamedTitleEvent', { previousTitle: p.title, currentTitle: body.title });
    p.title = body.title;
  }
  if (body.body !== undefined) p.body = body.body;
  if (body.base !== undefined && body.base !== p.baseRefName) {
    log('BaseRefChangedEvent', { previousRefName: p.baseRefName, currentRefName: body.base });
    p.baseRefName = body.base;
  }
  if (body.state === 'closed' && p.state === 'OPEN') {
    p.state = 'CLOSED';
    log('ClosedEvent');
  } else if (body.state === 'open' && p.state === 'CLOSED') {
    p.state = 'OPEN';
    log('ReopenedEvent');
  }
  return restPull(p);
});

const reviewer = (r: string) => (r.includes('/') ? { combinedSlug: r } : { login: r });

onRest('POST /repos/:owner/:repo/pulls/:number/requested_reviewers', (params, _, body) => {
  const e = extra(Number(params.number));
  const add = [...body.reviewers, ...(body.team_reviewers ?? []).map((t: string) => `acme/${t}`)].filter((r) => !e.requested.includes(r));
  e.requested.push(...add);
  for (const r of add) e.timeline.push(event('ReviewRequestedEvent', db.viewer, 0, { requestedReviewer: reviewer(r) }));
  return { number: Number(params.number) };
});

onRest('DELETE /repos/:owner/:repo/pulls/:number/requested_reviewers', (params, _, body) => {
  const e = extra(Number(params.number));
  const gone = [...body.reviewers, ...(body.team_reviewers ?? []).map((t: string) => `acme/${t}`)];
  e.requested = e.requested.filter((r) => !gone.includes(r));
  for (const r of gone) e.timeline.push(event('ReviewRequestRemovedEvent', db.viewer, 0, { requestedReviewer: reviewer(r) }));
  return { number: Number(params.number) };
});

onRest('POST /repos/:owner/:repo/issues/:number/labels', (params, _, body) => {
  const e = extra(Number(params.number));
  for (const name of body.labels as string[]) {
    if (e.labels.includes(name)) continue;
    e.labels.push(name);
    e.timeline.push(event('LabeledEvent', db.viewer, 0, { label: { name, color: LABELS[name] ?? 'ededed' } }));
  }
  return e.labels.map((name) => ({ name, color: LABELS[name] ?? 'ededed' }));
});

onRest('DELETE /repos/:owner/:repo/issues/:number/labels/:name', (params) => {
  const e = extra(Number(params.number));
  if (!e.labels.includes(params.name)) throw new GithubError('GitHub: Label does not exist', 404);
  e.labels = e.labels.filter((l) => l !== params.name);
  e.timeline.push(event('UnlabeledEvent', db.viewer, 0, { label: { name: params.name, color: LABELS[params.name] ?? 'ededed' } }));
  return [];
});

onRest('PUT /repos/:owner/:repo/pulls/:number/merge', (params, _, body) => {
  const p = pull(Number(params.number));
  const e = extra(p.number);
  if (body.sha && body.sha !== prNode(p).headRefOid) throw new GithubError('GitHub: Head branch was modified. Review and try the merge again.', 409);
  const state = mergeState(p, e);
  if (state !== 'CLEAN' && state !== 'UNSTABLE') throw new GithubError('GitHub: Pull Request is not mergeable', 405);
  const sha = Math.random().toString(16).slice(2, 9).padEnd(40, '0');
  p.state = 'MERGED';
  e.mergedAt = new Date().toISOString();
  e.mergedBy = db.viewer;
  e.autoMerge = null;
  e.timeline.push(event('MergedEvent', db.viewer, 0, { commit: { abbreviatedOid: sha.slice(0, 7) }, mergeRefName: p.baseRefName }));
  return { sha, merged: true, message: 'Pull Request successfully merged' };
});
