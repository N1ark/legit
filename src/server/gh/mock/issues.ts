// Fake issues in acme/widgets, their labels and who they can be assigned to; the pull requests
// of pulls.ts resolve as references too.

import { db, onGraphql, onRest } from './registry.ts';
import { prNode } from './pulls.ts';

const user = (login: string) => ({ login, avatarUrl: `https://github.com/${login}.png` });

db.labels = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'docs', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
  { name: 'parser', color: 'fbca04', description: 'The .widget parser' },
  { name: 'wontfix', color: 'ffffff', description: 'This will not be worked on' },
];
db.assignable = ['octocat', 'hubot', 'monalisa'];

const issue = (number: number, title: string, author: string, labels: string[], state = 'OPEN', stateReason: string | null = null) => ({
  number, title, author: user(author), labels, assignees: [] as string[], state, stateReason, body: '',
});

db.issues = [
  issue(1, 'Document the .widget file format', 'monalisa', ['docs'], 'CLOSED', 'COMPLETED'),
  issue(2, 'Support comments in widget specs', 'hubot', ['enhancement', 'parser']),
  issue(3, 'Build fails on Windows paths', 'monalisa', ['bug'], 'CLOSED', 'NOT_PLANNED'),
  issue(4, 'Add a --watch flag to widgets build', 'octocat', ['enhancement', 'help wanted']),
  issue(5, 'Typo in the usage section', 'hubot', ['docs', 'good first issue'], 'CLOSED', 'COMPLETED'),
  issue(6, 'Nested widgets lose their names', 'monalisa', ['bug', 'parser']),
  issue(7, 'Parse errors should say which line they are on', 'hubot', ['enhancement', 'parser']),
  issue(8, 'Crash on an empty spec file', 'octocat', ['bug', 'parser']),
  issue(15, 'Cache built specs between runs', 'octocat', ['enhancement']),
  issue(16, 'Colours in error output', 'monalisa', ['enhancement', 'good first issue']),
  issue(17, 'Unicode identifiers are rejected', 'hubot', ['bug', 'parser']),
  issue(18, 'Publish the package to npm', 'octocat', ['help wanted']),
  issue(19, 'Spec files with CRLF line endings', 'monalisa', ['bug'], 'CLOSED', 'COMPLETED'),
];

const issueNode = (i: any) => ({
  __typename: 'Issue',
  ...i,
  url: `https://github.com/acme/widgets/issues/${i.number}`,
  repository: { nameWithOwner: 'acme/widgets' },
});
const pullNode = (p: any) => ({ __typename: 'PullRequest', ...prNode(p) });

const isOurs = (owner: string, name: string) => `${owner}/${name}`.toLowerCase() === 'acme/widgets';
/** Issue or pull request `number` of acme/widgets. */
function lookup(number: number) {
  const i = db.issues.find((x: any) => x.number === number);
  if (i) return issueNode(i);
  const p = db.pulls.find((x: any) => x.number === number);
  return p ? pullNode(p) : null;
}
/** Every issue and pull request, newest first (standing in for most recently updated). */
const everything = () =>
  [...db.issues.map(issueNode), ...db.pulls.map(pullNode)].sort((a: any, b: any) => b.number - a.number);

onGraphql('IssueMeta', () => ({
  repository: {
    labels: { nodes: db.labels },
    assignableUsers: { nodes: db.assignable.map(user) },
  },
}));

// Variables o0/n0 name each repository, r0_1 the numbers asked of it (see issues.ts's refsQuery).
onGraphql('ResolveRefs', (v) => {
  const out: Record<string, Record<string, unknown> | null> = {};
  for (const k of Object.keys(v)) {
    const m = /^o(\d+)$/.exec(k);
    if (!m) continue;
    const ours = isOurs(v[k], v[`n${m[1]}`]);
    const fields: Record<string, unknown> = {};
    for (const [name, number] of Object.entries(v)) {
      const f = new RegExp(`^r${m[1]}_(\\d+)$`).exec(name);
      if (f) fields[`i${f[1]}`] = ours ? lookup(number) : null;
    }
    out[`r${m[1]}`] = ours ? fields : null;
  }
  return out;
});

onGraphql('RefSearch', (v) => {
  const words = String(v.q).split(/\s+/).filter((w) => w && !w.includes(':')).map((w) => w.toLowerCase());
  const nodes = everything().filter((n: any) => words.every((w) => n.title.toLowerCase().includes(w)));
  return {
    search: { nodes: nodes.slice(0, v.first) },
    ...(v.exact ? { repository: { issueOrPullRequest: lookup(v.number) } } : {}),
  };
});

onRest('POST /repos/:owner/:repo/issues', (_p, _q, body) => {
  const number = db.nextNumber++;
  const labels = (body.labels ?? []).filter((l: string) => db.labels.some((x: any) => x.name === l));
  db.issues.push({ ...issue(number, body.title, db.viewer, labels), body: body.body ?? '', assignees: body.assignees ?? [] });
  return { number, title: body.title, html_url: `https://github.com/acme/widgets/issues/${number}`, state: 'open' };
});
