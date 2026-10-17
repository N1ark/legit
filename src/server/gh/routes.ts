// /api/gh/<name>: GET routes read from GitHub, POST routes change something there. Each feature
// module exports its own tables, merged here.

import { checksGet, checksPost } from './checks.ts';
import { GithubError, MOCK, resetToken, viewerLogin } from './client.ts';
import { ghRepos } from './context.ts';
import { db } from './mock/registry.ts';
import { notificationsGet, notificationsPost } from './notifications.ts';
import { prForBranch } from './pulls.ts';
import { stackGet, stackPost } from './stack.ts';
import { issuesGet, issuesPost } from './issues.ts';
import { prviewGet, prviewPost } from './prview.ts';
import type { GithubStatus } from '../../shared/github.ts';
import type { Repo } from '../repo.ts';

export type GetRoute = (repo: Repo, query: URLSearchParams) => Promise<unknown>;
export type PostRoute = (repo: Repo, body: any) => Promise<unknown>;

const core: Record<string, GetRoute> = {
  status: async (repo, q) => {
    if (q.get('retry') === '1') resetToken();
    const r = await ghRepos(repo);
    const status: GithubStatus = { repo: r?.base ?? null, headOwner: r?.headOwner ?? null, login: null, error: null };
    if (!r) return status;
    try {
      status.login = await viewerLogin();
    } catch (e) {
      status.error = e instanceof Error ? e.message : String(e);
    }
    return status;
  },
  pr: (repo, q) => prForBranch(repo, q.get('branch') ?? '', q.get('fresh') === '1'),
};

export const getRoutes: Record<string, GetRoute> = {
  ...core,
  ...notificationsGet,
  ...stackGet,
  ...issuesGet,
  ...checksGet,
  ...prviewGet,
};
export const postRoutes: Record<string, PostRoute> = {
  ...notificationsPost,
  ...stackPost,
  ...issuesPost,
  ...checksPost,
  ...prviewPost,
};

if (MOCK) console.log('legit: GitHub calls go to the mock (LEGIT_GITHUB_MOCK)');

/** Answer `/api/gh/<name>`. */
export async function githubRoute(repo: Repo, method: string, name: string, input: any): Promise<unknown> {
  const route = method === 'POST' ? postRoutes[name] : getRoutes[name];
  if (!route) throw new GithubError(`No GitHub route ${method} ${name}.`, 404);
  if (MOCK) {
    const refs = await repo.git.text(['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads', 'refs/remotes/origin']);
    db.tips = Object.fromEntries(refs.split('\n').filter(Boolean).map((l) => l.split(' ')));
  }
  return route(repo, input);
}
