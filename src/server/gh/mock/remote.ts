// The demo's bare "remote" next to it (scripts/gh-demo.ts): what the fake GitHub has of pull
// requests whose branch isn't here (a fork's), read from it as GitHub would.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { db } from './registry.ts';

const dirs = new Map<string, string | null>();

/** The bare repo origin's URL leads to (through `insteadOf`), or null. */
export function remoteDir(): string | null {
  const local = db.gitDir as string | undefined;
  if (!local) return null;
  if (!dirs.has(local)) {
    let url: string | null = null;
    try {
      url = execFileSync('git', ['-C', local, 'ls-remote', '--get-url', 'origin'], { encoding: 'utf8' }).trim();
    } catch {}
    dirs.set(local, url && existsSync(url) ? url : null);
  }
  return dirs.get(local) ?? null;
}

/** `git <args>` in the remote; '' when there's none or it fails. */
export function remoteGit(...args: string[]): string {
  const dir = remoteDir();
  if (!dir) return '';
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

export const remoteSha = (ref: string): string | null => remoteGit('rev-parse', '-q', '--verify', `${ref}^{commit}`) || null;
