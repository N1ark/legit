// /api/gh/<name>: GET routes read from GitHub, POST routes change something there. Each feature
// module exports its own tables, merged here.

import { checksGet, checksPost, warmChecks } from './checks.ts';
import { GithubError, MOCK, githubToken, resetToken, viewerLogin } from './client.ts';
import { ghRepos } from './context.ts';
import { db } from './mock/registry.ts';
import { notificationsGet, notificationsPost, warmNotifications } from './notifications.ts';
import { knownPr, prForBranch } from './pulls.ts';
import { stackGet, stackPost } from './stack.ts';
import { issuesGet, issuesPost } from './issues.ts';
import { prviewGet, prviewPost } from './prview.ts';
import { reviewGet, reviewPost } from './review.ts';
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
    const branch = q.get('branch');
    if (status.login && branch) status.pr = await knownPr(repo, branch);
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
  ...reviewGet,
};
export const postRoutes: Record<string, PostRoute> = {
  ...notificationsPost,
  ...stackPost,
  ...issuesPost,
  ...checksPost,
  ...prviewPost,
  ...reviewPost,
};

if (MOCK) console.log('legit: GitHub calls go to the mock (LEGIT_GITHUB_MOCK)');

/** The mock answers about the repo's branches as they are now. */
async function mockTips(repo: Repo) {
  const refs = await repo.git.text(['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads', 'refs/remotes/origin']);
  db.tips = Object.fromEntries(refs.split('\n').filter(Boolean).map((l) => l.split(' ')));
}

/** Answer `/api/gh/<name>`. */
export async function githubRoute(repo: Repo, method: string, name: string, input: any): Promise<unknown> {
  const route = method === 'POST' ? postRoutes[name] : getRoutes[name];
  if (!route) throw new GithubError(`No GitHub route ${method} ${name}.`, 404);
  if (MOCK) await mockTips(repo);
  return route(repo, input);
}

/**
 * Ask GitHub what the page asks first while it loads, so the answers are there when it does: the
 * token and who it is (with no repo yet, for a spare server), and the repo's branch's pull
 * request, its checks, and the notifications. Nothing for a repo that isn't on GitHub. Called as
 * the server starts and as it serves the page.
 */
export async function warmGithub(repo?: Repo) {
  try {
    if (repo && !(await ghRepos(repo))) return;
    if (MOCK && repo) await mockTips(repo);
    if (!MOCK && !(await githubToken())) return;
    const viewer = viewerLogin();
    if (!repo) return void (await viewer);
    const notifs = warmNotifications();
    const branch = await repo.currentBranch();
    if (!branch) return void (await Promise.all([viewer, notifs]));
    // The pull request it had last time is most likely still the one: its checks needn't wait for it.
    const last = await knownPr(repo, branch, true);
    const checks = warmChecks(repo, last ?? null).catch(() => {});
    await Promise.all([viewer, notifs, checks, warmChecks(repo, await prForBranch(repo, branch))]);
  } catch {
    // The page's own requests say what went wrong.
  }
}
