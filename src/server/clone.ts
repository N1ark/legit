// Cloning a repository (from GitHub, or any URL git takes) into a new folder, next to this one's
// by default, to switch to it next. `owner/name` is GitHub's, over SSH when this repository's
// GitHub remote uses SSH, else HTTPS.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { cloneName, cloneUrl } from '../shared/clone.ts';
import type { CloneInfo, CloneRequest } from '../shared/types.ts';
import { GitError } from './git.ts';
import { runWithProgress } from './progress.ts';
import type { Repo } from './repo.ts';
import { networkEnv } from './sync.ts';
import { worktrees } from './worktrees.ts';

const short = (path: string) => {
  const home = homedir();
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
};

/** Where clones go by default (the folder this repository's main worktree is in), and how GitHub is reached. */
export async function cloneInfo(repo: Repo): Promise<CloneInfo> {
  const main = (await worktrees(repo))[0]?.path ?? repo.git.root;
  const urls = (await repo.git.text(['config', '--get-regexp', '^remote\\..*\\.url$'], { allowFail: true })).split('\n');
  const ssh = urls.some((l) => /\s(?:git@|ssh:\/\/git@)github\.com[:/]/.test(l));
  return { parent: short(dirname(main)), ssh };
}

/** A typed folder: `~` is the home directory, and a relative path is from `parent`. */
function typedPath(path: string, parent: string) {
  if (path === '~' || path.startsWith('~/')) path = join(homedir(), path.slice(1));
  return isAbsolute(path) ? resolve(path) : resolve(parent, path);
}

/** Clones made by this server: the only folders `openClone` switches to. */
export const cloned = new Set<string>();

/** Clone `req.url` into `req.path` (by default, a folder named after it next to this repository). */
export async function cloneRepo(repo: Repo, req: CloneRequest): Promise<{ path: string }> {
  const info = await cloneInfo(repo);
  const url = cloneUrl(String(req.url ?? ''), info.ssh);
  if (!url) throw new GitError('Clone what? Give a URL, or owner/name for a GitHub repository.');
  if (url.startsWith('-')) throw new GitError(`${url} isn't a repository URL.`);
  const name = cloneName(url);
  const parent = typedPath(info.parent, repo.git.root);
  const path = typedPath(String(req.path ?? '').trim() || name, parent);
  if (!name && !req.path) throw new GitError(`Can't tell what to name the folder for ${url}; give one.`);
  if (existsSync(path) && readdirSync(path).length) throw new GitError(`${short(path)} already exists and isn't empty; pick another folder.`);
  const r = await runWithProgress(repo.git, 'clone', basename(path), ['clone', '--', url, path], {
    allowFail: true,
    timeout: 30 * 60_000,
    env: await networkEnv(repo.git),
  });
  if (r.code !== 0) {
    const err = r.err.trim();
    const auth = /terminal prompts disabled|could not read Username|Authentication failed|Permission denied|Host key verification failed|Repository not found/i.test(err);
    throw new GitError(
      r.code < 0
        ? `Cloning ${url} timed out.`
        : `Couldn't clone ${url}.${auth ? " It may not exist, or git needs credentials it can't ask for here: clone once from a terminal, or set up a credential helper or ssh-agent." : ''}\n${err}`,
    );
  }
  cloned.add(path);
  return { path };
}
