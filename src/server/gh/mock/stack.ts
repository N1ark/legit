// Fake GitHub for stacks and opening pull requests: the batched lookup, and the REST calls that
// open a pull request or change its base.

import { GithubError } from '../client.ts';
import { prNode } from './pulls.ts';
import { db, onGraphql, onRest } from './registry.ts';

/** A db pull in the REST API's shape. */
const restPull = (p: any) => {
  const n = prNode(p);
  return {
    number: n.number, title: n.title, body: n.body ?? '', html_url: n.url, state: n.state === 'OPEN' ? 'open' : 'closed', draft: n.isDraft,
    merged_at: n.state === 'MERGED' ? '2026-10-10T10:00:00Z' : null,
    base: { ref: n.baseRefName, repo: { full_name: 'acme/widgets' } },
    head: { ref: n.headRefName, sha: n.headRefOid, repo: { full_name: 'acme/widgets' } },
    user: n.author ? { login: n.author.login, avatar_url: n.author.avatarUrl } : null,
  };
};

const invalid = (why: string) => new GithubError(`GitHub: Validation Failed: ${why}`, 422);

// `hN`: the pull requests with that head; `cN`: the open ones with that base.
onGraphql('PrStack', (v) => {
  const repository: Record<string, unknown> = { defaultBranchRef: { name: 'main' } };
  for (const [k, name] of Object.entries(v)) {
    const pick =
      /^h\d+$/.test(k) ? (p: any) => p.headRefName === name
      : /^c\d+$/.test(k) ? (p: any) => p.baseRefName === name && p.state === 'OPEN'
      : null;
    if (pick) repository[k] = { nodes: db.pulls.filter(pick).reverse().map(prNode) };
  }
  return { repository };
});

onRest('POST /repos/:owner/:repo/pulls', (_, __, body) => {
  const head = String(body.head ?? '').replace(/^[^:]+:/, '');
  if (!db.tips[`origin/${head}`]) throw invalid(`head ${head} doesn't exist on acme/widgets (push it first).`);
  if (!db.tips[`origin/${body.base}`]) throw invalid(`base ${body.base} doesn't exist.`);
  if (db.pulls.some((p: any) => p.headRefName === head && p.baseRefName === body.base && p.state === 'OPEN')) {
    throw invalid(`A pull request already exists for acme:${head}.`);
  }
  const p = {
    number: db.nextNumber++, title: body.title, body: body.body ?? '', state: 'OPEN', isDraft: !!body.draft, baseRefName: body.base,
    headRefName: head, headRefOid: db.tips[`origin/${head}`], author: { login: db.viewer, avatarUrl: `https://github.com/${db.viewer}.png` },
  };
  db.pulls.push(p);
  return restPull(p);
});

onRest('PATCH /repos/:owner/:repo/pulls/:number', ({ number }, _, body) => {
  const p = db.pulls.find((x: any) => x.number === Number(number));
  if (!p) throw new GithubError('GitHub: Not Found', 404);
  if (body.base !== undefined) p.baseRefName = body.base;
  if (body.title !== undefined) p.title = body.title;
  if (body.body !== undefined) p.body = body.body;
  if (body.state === 'closed' || body.state === 'open') p.state = body.state === 'closed' ? 'CLOSED' : 'OPEN';
  return restPull(p);
});
