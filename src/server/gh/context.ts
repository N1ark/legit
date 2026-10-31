// Which GitHub repositories a local repo maps to: the one pull requests go to, and the one its
// branches are pushed to (a fork, in a fork workflow).

import { githubRepo, pickGithubRepo } from '../github.ts';
import { GithubError, rest } from './client.ts';
import type { Repo } from '../repo.ts';

export interface GhRepos {
  /** `owner/repo` pull requests and issues are in. */
  base: string;
  owner: string;
  name: string;
  /** Owner of the repo branches are pushed to. */
  headOwner: string;
}

/** The config ghRepos reads (remotes' URLs, push remotes), keys as git canonicalizes them, last value winning. */
async function ghConfig(repo: Repo): Promise<Map<string, string>> {
  const out = await repo.git.text(['config', '--get-regexp', '^(remote\\..*\\.url|remote\\.pushdefault|branch\\..*\\.(pushremote|remote))$'], { allowFail: true });
  return new Map(
    out.split('\n').flatMap((l) => {
      const at = l.indexOf(' ');
      return at > 0 ? [[l.slice(0, at), l.slice(at + 1)] as const] : [];
    }),
  );
}

/** The repos for `branch` (default: the current one), or null when nothing is on GitHub. */
export async function ghRepos(repo: Repo, branch?: string | null): Promise<GhRepos | null> {
  const [config, current] = await Promise.all([ghConfig(repo), branch === undefined || branch === null ? repo.currentBranch() : branch]);
  branch = current;
  const remotes = new Map([...config].flatMap(([k, v]) => (k.startsWith('remote.') && k.endsWith('.url') ? [[k.slice(7, -4), v] as const] : [])));
  const pushRemote = branch
    ? config.get(`branch.${branch}.pushremote`) || config.get('remote.pushdefault') || config.get(`branch.${branch}.remote`) || ''
    : '';
  const on = (name: string | undefined) => (name ? githubRepo(remotes.get(name) ?? '') : null);
  const head = on(pushRemote) ?? on('origin') ?? [...remotes.keys()].map(on).find(Boolean) ?? null;
  const base = on('upstream') ?? (head && (await forkParent(head))) ?? head;
  if (!base || !head) return null;
  const [owner, name] = base.split('/');
  return { base, owner, name, headOwner: head.split('/')[0] };
}

const parents = new Map<string, { until: number; value: Promise<string | null> }>();

/**
 * The repository `repo` was forked from, as GitHub says (null when it isn't a fork, or GitHub
 * can't be asked: no token, offline). Kept a day; a failure is asked again after five minutes.
 */
export function forkParent(repo: string): Promise<string | null> {
  const hit = parents.get(repo);
  if (hit && Date.now() < hit.until) return hit.value;
  const asked = rest<{ parent?: { full_name?: string } } | null>('GET', `/repos/${repo}`);
  const entry = { until: Date.now() + 24 * 3600_000, value: asked.then((r) => r?.parent?.full_name ?? null, () => null) };
  asked.catch(() => (entry.until = Date.now() + 5 * 60_000));
  parents.set(repo, entry);
  return entry.value;
}

/**
 * Where `#123` in a message points: the `upstream` remote's repository, else the one the push
 * remote (or origin) is a fork of, else that one itself. GitHub is only waited on briefly; a
 * later state has the answer.
 */
export async function issueRepo(remotes: Map<string, string>, preferred?: string): Promise<string | null> {
  const own = pickGithubRepo(remotes, preferred);
  const upstream = githubRepo(remotes.get('upstream') ?? '');
  if (upstream || !own) return upstream ?? own;
  const late = new Promise<null>((done) => setTimeout(done, 300, null));
  return (await Promise.race([forkParent(own), late])) ?? own;
}

/** Like `ghRepos`, but refuses when the repo isn't on GitHub. */
export async function needGhRepos(repo: Repo, branch?: string | null): Promise<GhRepos> {
  const r = await ghRepos(repo, branch);
  if (!r) throw new GithubError('This repository has no GitHub remote.');
  return r;
}
