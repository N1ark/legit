// Which GitHub repositories a local repo maps to: the one pull requests go to, and the one its
// branches are pushed to (a fork, in a fork workflow).

import { githubRepo } from '../github.ts';
import { GithubError } from './client.ts';
import type { Repo } from '../repo.ts';

export interface GhRepos {
  /** `owner/repo` pull requests and issues are in. */
  base: string;
  owner: string;
  name: string;
  /** Owner of the repo branches are pushed to. */
  headOwner: string;
}

async function remoteUrls(repo: Repo): Promise<Map<string, string>> {
  const out = await repo.git.text(['config', '--get-regexp', '^remote\\..*\\.url$'], { allowFail: true });
  return new Map(
    out.split('\n').flatMap((l) => {
      const m = /^remote\.(.+)\.url (.+)$/.exec(l);
      return m ? [[m[1], m[2]] as const] : [];
    }),
  );
}

/** The repos for `branch` (default: the current one), or null when nothing is on GitHub. */
export async function ghRepos(repo: Repo, branch?: string | null): Promise<GhRepos | null> {
  const remotes = await remoteUrls(repo);
  branch ??= (await repo.git.text(['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true })) || null;
  const pushRemote = branch
    ? (await repo.git.text(['config', `branch.${branch}.pushRemote`], { allowFail: true })) ||
      (await repo.git.text(['config', 'remote.pushDefault'], { allowFail: true })) ||
      (await repo.git.text(['config', `branch.${branch}.remote`], { allowFail: true }))
    : '';
  const on = (name: string | undefined) => (name ? githubRepo(remotes.get(name) ?? '') : null);
  const head = on(pushRemote) ?? on('origin') ?? [...remotes.keys()].map(on).find(Boolean) ?? null;
  const base = on('upstream') ?? head;
  if (!base || !head) return null;
  const [owner, name] = base.split('/');
  return { base, owner, name, headOwner: head.split('/')[0] };
}

/** Like `ghRepos`, but refuses when the repo isn't on GitHub. */
export async function needGhRepos(repo: Repo, branch?: string | null): Promise<GhRepos> {
  const r = await ghRepos(repo, branch);
  if (!r) throw new GithubError('This repository has no GitHub remote.');
  return r;
}
