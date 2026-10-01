// legit's own settings, edited on its settings page. Each list has a part for this repo (in its
// git dir: not committed, shared by its worktrees) and one for all repos (in legit's config
// dir). Both apply, the repo's after the global ones, so its rules win where order matters.
//
// Collapsed-file patterns used to be `git config legit.hide`: a scope's file is created the
// first time it's read, with that scope's legit.hide values copied in. Git config isn't read
// after that (nor changed).

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Scope, ScopeSettings, Settings } from '../shared/types.ts';
import type { Git } from './git.ts';
import { GitError } from './git.ts';

export const globalSettingsFile = () =>
  process.platform === 'darwin'
    ? join(homedir(), 'Library/Application Support/legit/settings.json')
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'legit/settings.json');

export const repoSettingsFile = (git: Git) => join(git.commonDir, 'legit/settings.json');

const empty = (): ScopeSettings => ({ collapse: [], syntax: [] });

/** Settings as given (by the page, or a file), keeping only well-formed, non-empty entries. */
export function clean(s: unknown): ScopeSettings {
  const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '');
  return {
    collapse: (Array.isArray(o.collapse) ? o.collapse : []).map(str).filter(Boolean),
    syntax: (Array.isArray(o.syntax) ? o.syntax : [])
      .map((r) => ({ pattern: str(r?.pattern), grammar: str(r?.grammar) }))
      .filter((r) => r.pattern && r.grammar),
  };
}

async function save(file: string, s: ScopeSettings) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(s, null, 2) + '\n');
  await rename(tmp, file);
}

/** legit.hide values from git config, by where they're set: this repo (local, worktree) or all (global, system). */
async function oldHide(git: Git, scope: Scope): Promise<string[]> {
  const out = await git.text(['config', '--show-scope', '--get-all', 'legit.hide'], { allowFail: true });
  const mine = scope === 'repo' ? ['local', 'worktree'] : ['global', 'system'];
  return out.split('\n').flatMap((l) => {
    const tab = l.indexOf('\t');
    return tab > 0 && mine.includes(l.slice(0, tab)) && l.slice(tab + 1).trim() ? [l.slice(tab + 1).trim()] : [];
  });
}

async function readScope(git: Git, scope: Scope): Promise<ScopeSettings> {
  const file = scope === 'repo' ? repoSettingsFile(git) : globalSettingsFile();
  if (!existsSync(file)) {
    const s = { ...empty(), collapse: await oldHide(git, scope) };
    await save(file, s).catch(() => {});
    return s;
  }
  try {
    return clean(JSON.parse(await readFile(file, 'utf8')));
  } catch (e) {
    throw new GitError(`Couldn't read the settings in ${file}: ${e instanceof Error ? e.message : e}`);
  }
}

export async function readSettings(git: Git): Promise<Settings> {
  const [repo, global] = await Promise.all([readScope(git, 'repo'), readScope(git, 'global')]);
  return { repo, global };
}

/** Both scopes' lists as they apply: the global entries, then the repo's. */
export async function effectiveSettings(git: Git): Promise<ScopeSettings> {
  const s = await readSettings(git);
  return { collapse: [...s.global.collapse, ...s.repo.collapse], syntax: [...s.global.syntax, ...s.repo.syntax] };
}

/** Replace one scope's settings. */
export async function saveSettings(git: Git, req: { scope: Scope; settings: unknown }): Promise<Settings> {
  if (req.scope !== 'repo' && req.scope !== 'global') throw new GitError('Unknown settings scope.');
  await save(req.scope === 'repo' ? repoSettingsFile(git) : globalSettingsFile(), clean(req.settings));
  return readSettings(git);
}
