// A pull request's files as a review keeps track of them: which the viewer marked viewed (GitHub's
// per-file mark), and the base branch's CODEOWNERS, in one GraphQL query per refresh (more pages
// of files for a pull request with more than 100); marking a file viewed or not.

import { GithubError, MOCK, cached, graphql } from './client.ts';
import { needGhRepos } from './context.ts';
import { db } from './mock/registry.ts';
import type { GetRoute, PostRoute } from './routes.ts';
import type { PrFiles, ViewedState } from '../../shared/gh-files.ts';
import type { Repo } from '../repo.ts';

/** Where GitHub looks for CODEOWNERS, in order; the first found is the one used. */
export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

const owners = CODEOWNERS_PATHS.map((p, i) => `o${i}: file(path: ${JSON.stringify(p)}) { object { ... on Blob { text } } }`).join('\n');

const FILES_QUERY = `query PrFiles($owner: String!, $name: String!, $number: Int!, $after: String, $first: Boolean!) {
  viewer @include(if: $first) { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id headRefOid
      baseRef @include(if: $first) { target { ... on Commit { ${owners} } } }
      files(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { path viewerViewedState } }
    }
  }
}`;

/** GitHub allows 3000 files in a pull request's diff. */
const PAGES = 30;

const VIEWED: ViewedState[] = ['VIEWED', 'UNVIEWED', 'DISMISSED'];

/** The first CODEOWNERS of the base's three places that has one. */
export function codeownersOf(commit: any): PrFiles['codeowners'] {
  for (let i = 0; i < CODEOWNERS_PATHS.length; i++) {
    const text = commit?.[`o${i}`]?.object?.text;
    if (typeof text === 'string') return { path: CODEOWNERS_PATHS[i], text };
  }
  return null;
}

interface Loaded {
  files: PrFiles;
  /** The pull request's node id, for the mutations. */
  prId: string;
}

const loads = new Map<string, { at: number; value: Promise<Loaded> }>();

async function load(repo: Repo, number: number, fresh = false): Promise<Loaded> {
  const r = await needGhRepos(repo);
  if (MOCK) db.reviewGit = repo.git;
  const key = `${r.base}#${number}`;
  if (fresh) loads.delete(key);
  return cached(loads, key, 10_000, async () => {
    const out: PrFiles = { number, headSha: '', viewer: '', viewed: {}, codeowners: null };
    let prId = '';
    let after: string | null = null;
    for (let page = 0; page < PAGES; page++) {
      const d: any = await graphql(FILES_QUERY, { owner: r.owner, name: r.name, number, after, first: page === 0 });
      const pr = d.repository?.pullRequest;
      if (!pr) throw new GithubError(`Pull request #${number} isn't on GitHub.`, 404);
      if (page === 0) {
        prId = pr.id;
        out.headSha = pr.headRefOid;
        out.viewer = d.viewer?.login ?? '';
        out.codeowners = codeownersOf(pr.baseRef?.target);
      }
      for (const f of pr.files?.nodes ?? []) out.viewed[f.path] = VIEWED.includes(f.viewerViewedState) ? f.viewerViewedState : 'UNVIEWED';
      if (!pr.files?.pageInfo?.hasNextPage) break;
      after = pr.files.pageInfo.endCursor;
    }
    return { files: out, prId };
  });
}

const num = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new GithubError('Bad pull request number.', 400);
  return n;
};

async function setViewed(repo: Repo, b: { number: number; path: string; viewed: boolean }): Promise<null> {
  const number = num(b.number);
  if (typeof b.path !== 'string' || !b.path) throw new GithubError('Bad path.', 400);
  const loaded = await load(repo, number);
  const name = b.viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
  await graphql(
    `mutation ${b.viewed ? 'MarkFileViewed' : 'UnmarkFileViewed'}($pr: ID!, $path: String!) {
      ${name}(input: { pullRequestId: $pr, path: $path }) { pullRequest { id } }
    }`,
    { pr: loaded.prId, path: b.path },
  );
  // What's kept says so too, so a refresh in the next few seconds doesn't undo it on the page.
  loaded.files.viewed[b.path] = b.viewed ? 'VIEWED' : 'UNVIEWED';
  return null;
}

export const prfilesGet: Record<string, GetRoute> = {
  prFiles: async (repo, q) => (await load(repo, num(q.get('number')), q.get('fresh') === '1')).files,
};

export const prfilesPost: Record<string, PostRoute> = {
  prFileViewed: (repo, b) => setViewed(repo, b),
};
