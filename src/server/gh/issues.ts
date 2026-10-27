// Issues: creating one, and what `#123` references point at (resolved in batches, and searched
// for the message editors' suggestions).

import { GithubError, MOCK, cached, graphql, rest } from './client.ts';
import { needGhRepos } from './context.ts';
import { prState } from './pulls.ts';
import type { GetRoute, PostRoute } from './routes.ts';
import type { CreatedIssue, IssueMeta, IssueRef, NewIssue } from '../../shared/gh-issues.ts';

/** GraphQL fields that make an `IssueRef` (see `toIssueRef`). */
const REF_FIELDS = `__typename
  ... on Issue { number title url state stateReason author { login avatarUrl } repository { nameWithOwner } }
  ... on PullRequest { number title url state isDraft isInMergeQueue author { login avatarUrl } repository { nameWithOwner } }`;

export function toIssueRef(n: any): IssueRef | null {
  if (!n?.number) return null;
  const pr = n.__typename === 'PullRequest';
  const state = pr ? prState(n) : n.state === 'CLOSED' ? 'closed' : 'open';
  return {
    repo: n.repository.nameWithOwner,
    number: n.number,
    title: n.title,
    state,
    isPullRequest: pr,
    notPlanned: n.stateReason === 'NOT_PLANNED',
    author: n.author ? { login: n.author.login, avatar: n.author.avatarUrl } : null,
    url: n.url,
  };
}

/** A query whose missing parts (a number that's no issue, a repo out of reach) come back null, rather than failing it all. */
async function lenient<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  if (MOCK) return graphql<T>(query, variables);
  const res = await rest<{ data?: T | null; errors?: { message: string }[] }>('POST', '/graphql', { query, variables });
  if (!res.data) throw new GithubError(`GitHub: ${res.errors?.map((e) => e.message).join('; ') || 'no data'}`);
  return res.data;
}

/** `owner/repo#123`, as the UI asks for it. */
const REF = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
/** Aliases in one query. */
const BATCH = 50;

/** One query for `refs` (`owner/repo#123`, at most BATCH): `repository` per repo, an aliased `issueOrPullRequest` per number. */
export function refsQuery(refs: string[]): { query: string; variables: Record<string, string | number>; paths: [string, string, string][] } {
  const variables: Record<string, string | number> = {};
  const decl: string[] = [];
  const repos = new Map<string, { alias: string; fields: string[] }>();
  const paths: [string, string, string][] = [];
  for (const ref of refs) {
    const m = REF.exec(ref);
    if (!m) continue;
    const key = `${m[1]}/${m[2]}`.toLowerCase();
    let r = repos.get(key);
    if (!r) {
      const i = repos.size;
      r = { alias: `r${i}`, fields: [] };
      repos.set(key, r);
      [variables[`o${i}`], variables[`n${i}`]] = [m[1], m[2]];
      decl.push(`$o${i}: String!`, `$n${i}: String!`);
    }
    const v = `${r.alias}_${r.fields.length}`;
    variables[v] = Number(m[3]);
    decl.push(`$${v}: Int!`);
    r.fields.push(`i${r.fields.length}: issueOrPullRequest(number: $${v}) { ${REF_FIELDS} }`);
    paths.push([ref, r.alias, `i${r.fields.length - 1}`]);
  }
  const parts = [...repos.values()].map((r, i) => `${r.alias}: repository(owner: $o${i}, name: $n${i}) { ${r.fields.join(' ')} }`);
  return { query: `query ResolveRefs(${decl.join(', ')}) { ${parts.join(' ')} }`, variables, paths };
}

const refCache = new Map<string, { at: number; value: IssueRef | null }>();
const REF_TTL = 120_000;

/** What each of `refs` (`owner/repo#123`) is, null when it's nothing (or out of reach); cached a couple of
 *  minutes, or until `changedAt[ref]` (ms) says it changed since. */
export async function resolveRefs(refs: string[], changedAt: Record<string, number> = {}): Promise<Record<string, IssueRef | null>> {
  const out: Record<string, IssueRef | null> = {};
  const missing: string[] = [];
  for (const ref of new Set(refs.map((r) => r.toLowerCase()).filter((r) => REF.test(r)))) {
    const hit = refCache.get(ref);
    if (hit && Date.now() - hit.at < REF_TTL && hit.at >= (changedAt[ref] ?? 0)) out[ref] = hit.value;
    else missing.push(ref);
  }
  const chunks = Array.from({ length: Math.ceil(missing.length / BATCH) }, (_, i) => missing.slice(i * BATCH, (i + 1) * BATCH));
  await Promise.all(
    chunks.map(async (chunk) => {
      const q = refsQuery(chunk);
      const data = await lenient<Record<string, Record<string, unknown> | null>>(q.query, q.variables);
      for (const [ref, repo, field] of q.paths) {
        out[ref] = toIssueRef(data[repo]?.[field]);
        refCache.set(ref, { at: Date.now(), value: out[ref] });
      }
    }),
  );
  return out;
}

const metas = new Map<string, { at: number; value: Promise<IssueMeta> }>();

export const issuesGet: Record<string, GetRoute> = {
  /** Labels and the people issues can be assigned to, for a new issue. */
  issuesMeta: async (repo) => {
    const r = await needGhRepos(repo);
    return cached(metas, r.base, 300_000, async () => {
      const d = await graphql(
        `query IssueMeta($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) {
            labels(first: 100, orderBy: { field: NAME, direction: ASC }) { nodes { name color description } }
            assignableUsers(first: 100) { nodes { login avatarUrl } }
          }
        }`,
        { owner: r.owner, name: r.name },
      );
      return {
        repo: r.base,
        labels: d.repository?.labels.nodes ?? [],
        assignees: (d.repository?.assignableUsers.nodes ?? []).map((u: any) => ({ login: u.login, avatar: u.avatarUrl })),
      } satisfies IssueMeta;
    });
  },
  /** `?refs=owner/repo#1,owner/repo#2`: what each is (keys lowercased). */
  issuesRefs: async (_repo, q) => resolveRefs((q.get('refs') ?? '').split(',').slice(0, 500)),
  /** `?q=text`: issues and pull requests to suggest after `#text` (by title; by number for digits). */
  issuesSearch: async (repo, q) => {
    const r = await needGhRepos(repo);
    const text = (q.get('q') ?? '').replace(/[^\w .-]/g, ' ').trim();
    const number = /^\d+$/.test(text) ? Number(text) : 0;
    const search = number || !text ? `repo:${r.base} sort:updated-desc` : `repo:${r.base} ${text} in:title sort:updated-desc`;
    const d = await lenient<any>(
      `query RefSearch($q: String!, $first: Int!, $owner: String!, $name: String!, $number: Int!, $exact: Boolean!) {
        search(query: $q, type: ISSUE, first: $first) { nodes { ${REF_FIELDS} } }
        repository(owner: $owner, name: $name) @include(if: $exact) { issueOrPullRequest(number: $number) { ${REF_FIELDS} } }
      }`,
      { q: search, first: number ? 50 : 10, owner: r.owner, name: r.name, number, exact: !!number },
    );
    const found = (d.search?.nodes ?? []).map(toIssueRef).filter((x: IssueRef | null): x is IssueRef => !!x);
    if (!number) return found;
    const exact = toIssueRef(d.repository?.issueOrPullRequest);
    const prefixed = found.filter((x: IssueRef) => x.number !== number && String(x.number).startsWith(text));
    return [...(exact ? [exact] : []), ...prefixed].slice(0, 10);
  },
};

export const issuesPost: Record<string, PostRoute> = {
  issuesCreate: async (repo, body: NewIssue): Promise<CreatedIssue> => {
    const r = await needGhRepos(repo);
    const title = String(body?.title ?? '').trim();
    if (!title) throw new GithubError('An issue needs a title.');
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const made = await rest<{ number: number; html_url: string }>('POST', `/repos/${r.base}/issues`, {
      title,
      body: String(body.body ?? ''),
      labels: strings(body.labels),
      assignees: strings(body.assignees),
    });
    return { number: made.number, url: made.html_url };
  },
};
