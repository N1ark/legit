// Opening files in an external editor (Zed).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { GitError } from './git.ts';

/** Zed's CLI: the one bundled in the app works even with the minimal PATH of a GUI app. */
function zedCli(): string {
  for (const app of ['/Applications/Zed.app', join(homedir(), 'Applications/Zed.app')]) {
    const cli = join(app, 'Contents/MacOS/cli');
    if (existsSync(cli)) return cli;
  }
  return 'zed';
}

/** Open `path` (relative to the repo root) in Zed, with the repo as the project. */
export function openInZed(root: string, path: string, line?: number): Promise<void> {
  const file = resolve(root, path);
  if (!file.startsWith(root + sep)) throw new GitError('That path is outside the repository.');
  if (!existsSync(file)) throw new GitError(`${path} doesn't exist in the working tree.`);
  const target = line && line > 0 ? `${file}:${line}` : file;
  return new Promise((done, fail) => {
    const p = spawn(zedCli(), [root, target], { stdio: 'ignore', detached: true });
    p.on('error', () => fail(new GitError("Couldn't start Zed. Is it installed?")));
    p.on('exit', (code) => (code === 0 ? done() : fail(new GitError(`Zed exited with code ${code}.`))));
    p.unref();
  });
}

/** Open a web link in the default browser. Only http(s) and mailto: links come from commit messages. */
export function openUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GitError('That link is malformed.');
  }
  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) throw new GitError(`Won't open a ${parsed.protocol} link.`);
  const [cmd, args] = process.platform === 'darwin' ? ['open', [parsed.href]] : ['xdg-open', [parsed.href]];
  return new Promise((done, fail) => {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', () => fail(new GitError("Couldn't open the link.")));
    p.on('exit', (code) => (code === 0 ? done() : fail(new GitError(`Opening the link failed (code ${code}).`))));
    p.unref();
  });
}
