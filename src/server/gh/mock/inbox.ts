// Fake pull request lists (the inbox's searches, and one by number), with a few more pull requests
// for them: a fork's, someone else's assigned to the viewer, a closed one.

import { db, onGraphql } from './registry.ts';
import { prNode } from './pulls.ts';

const actor = (login: string) => ({ login, avatarUrl: `https://github.com/${login}.png` });
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
let ids = 5000;
const comment = (login: string, hours: number, body: string) => ({
  __typename: 'IssueComment', id: `IC_kwDO${++ids}`, databaseId: ++ids, author: actor(login), body, createdAt: ago(hours), lastEditedAt: null,
});
const review = (login: string, hours: number, state: string, body: string) => ({
  __typename: 'PullRequestReview', id: `PRR_kwDO${++ids}`, author: actor(login), state, body, createdAt: ago(hours), submittedAt: ago(hours),
  comments: { totalCount: 0 },
});
const event = (type: string, login: string, hours: number) => ({ __typename: type, id: `EV_kwDO${++ids}`, actor: actor(login), createdAt: ago(hours) });

db.pulls.push(
  {
    number: 10, title: 'Read specs from YAML too', state: 'CLOSED', isDraft: false, baseRefName: 'main', headRefName: 'try/yaml',
    headRefOid: '0'.repeat(40), author: actor('mojombo'), body: 'An experiment: `.widget.yaml` files.',
  },
  {
    number: 15, title: 'Handle CRLF line endings when building', state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: 'fix-crlf',
    headRefOid: '0'.repeat(40), author: actor('defunkt'), body: 'Specs written on Windows counted every line twice.',
    headRepositoryOwner: { login: 'defunkt' }, headRepository: { nameWithOwner: 'defunkt/widgets' }, isCrossRepository: true, maintainerCanModify: true,
  },
  {
    number: 16, title: 'Document the widget spec format', state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: 'docs/format',
    headRefOid: '0'.repeat(40), author: actor('hubot'), body: 'Writes down what the parser accepts, with an example.',
  },
);

Object.assign(db.prview, {
  10: {
    createdAt: ago(24 * 6), labels: ['enhancement'], assignees: [], requested: [], checks: 'SUCCESS', additions: 40, deletions: 2, changedFiles: 2,
    autoMerge: null, timeline: [comment('octocat', 24 * 5.5, "Let's keep one format for now."), event('ClosedEvent', 'mojombo', 24 * 5)],
  },
  15: {
    createdAt: ago(9), labels: ['bug', 'parser'], assignees: [], requested: ['octocat'], checks: 'FAILURE', additions: 6, deletions: 2, changedFiles: 1,
    autoMerge: null, timeline: [comment('defunkt', 8.5, 'Found this writing specs on my Windows laptop. Tests fail on Linux though, looking.')],
  },
  16: {
    createdAt: ago(30), labels: ['documentation'], assignees: ['octocat'], requested: [], checks: 'SUCCESS', additions: 24, deletions: 0, changedFiles: 1,
    autoMerge: null, timeline: [review('monalisa', 3, 'APPROVED', 'Clear, thanks!'), comment('hubot', 2, '@octocat can you merge this once #12 is in?')],
  },
});

/** The viewer's teams, for `review-requested:@me`. */
const TEAMS = ['acme/core'];

const extra = (p: any) => db.prview[p.number] ?? { createdAt: ago(1), assignees: [], requested: [], checks: null, timeline: [] };

function decision(e: any) {
  const by = new Map<string, string>();
  for (const t of e.timeline) if (t.__typename === 'PullRequestReview' && (t.state === 'APPROVED' || t.state === 'CHANGES_REQUESTED')) by.set(t.author.login, t.state);
  const states = [...by.values()];
  return states.includes('CHANGES_REQUESTED') ? 'CHANGES_REQUESTED' : states.includes('APPROVED') ? 'APPROVED' : 'REVIEW_REQUIRED';
}

/** A db pull with what the inbox asks for. */
function inboxNode(p: any) {
  const e = extra(p);
  const times = [e.createdAt, ...e.timeline.map((t: any) => t.createdAt)].sort();
  const node = prNode(p);
  return {
    ...node,
    headRefOid: db.tips[p.headRefName] ?? db.tips[`origin/${p.headRefName}`] ?? node.headRefOid,
    updatedAt: times.at(-1),
    reviewDecision: decision(e),
    isCrossRepository: !!p.isCrossRepository,
    headRepository: p.headRepository ?? { nameWithOwner: 'acme/widgets' },
    comments: { totalCount: e.timeline.filter((t: any) => t.__typename === 'IssueComment').length },
    commits: { nodes: [{ commit: { statusCheckRollup: e.checks ? { state: e.checks } : null } }] },
    reviewRequests: { nodes: e.requested.map((r: string) => ({ requestedReviewer: r.includes('/') ? { combinedSlug: r } : { login: r } })) },
    assignees: { nodes: e.assignees.map((login: string) => ({ login })) },
  };
}

/** The pull requests a search like `repo:acme/widgets is:pr is:open author:@me` finds. */
function search(q: string) {
  const has = (word: string) => q.split(/\s+/).includes(word);
  const me = db.viewer;
  const found = db.pulls.filter((p: any) => {
    const e = extra(p);
    if (has('is:open') && p.state !== 'OPEN') return false;
    if (has('author:@me') && p.author?.login !== me) return false;
    if (has('assignee:@me') && !e.assignees.includes(me)) return false;
    if (has('review-requested:@me') && !e.requested.some((r: string) => r === me || TEAMS.includes(r))) return false;
    return true;
  });
  const nodes = found.map(inboxNode).sort((a: any, b: any) => b.updatedAt.localeCompare(a.updatedAt));
  return { issueCount: nodes.length, nodes };
}

onGraphql('PrInbox', (v) => ({
  viewer: { login: db.viewer },
  review: search(v.review), mine: search(v.mine), assigned: search(v.assigned), open: search(v.open),
}));

const pull = (n: number) => db.pulls.find((p: any) => p.number === n);

onGraphql('PrLookup', (v) => ({ viewer: { login: db.viewer }, repository: { pullRequest: pull(v.number) ? inboxNode(pull(v.number)) : null } }));
