// Submodules, read side: which paths are submodules (.gitmodules), where their git dirs are, what
// they have checked out, and the commits between two of theirs. Repos without .gitmodules pay
// one stat. Paths are byte strings, as elsewhere.

import { lstat, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { SubmoduleCommit, SubmoduleLog } from '../shared/types.ts';
import { type Git, GitError, fromUtf8, run, toUtf8 } from './git.ts';

const HEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const isZero = (sha: string) => /^0+$/.test(sha);

/** A repo path (a byte string) under the root, as a filesystem path. */
export const subDir = (git: Git, path: string) => join(git.root, Buffer.from(path, 'latin1').toString('utf8'));

const parsed = new WeakMap<Git, { key: string; map: Map<string, { name: string; url?: string }> }>();

/** The submodules .gitmodules names (in the working tree), by path: their names and URLs. Read again only when the file changes. */
export async function submodulePaths(git: Git): Promise<Map<string, { name: string; url?: string }>> {
  const file = join(git.root, '.gitmodules');
  const st = await stat(file).catch(() => null);
  if (!st?.isFile()) return new Map();
  const key = `${st.ino} ${st.size} ${st.mtimeMs} ${st.ctimeMs}`;
  const known = parsed.get(git);
  if (known?.key === key) return known.map;
  const r = await git.run(['config', '-z', '-f', '.gitmodules', '--get-regexp', '^submodule\\.'], { allowFail: true });
  const byName = new Map<string, { path?: string; url?: string }>();
  for (const entry of r.out.toString('latin1').split('\0')) {
    const nl = entry.indexOf('\n');
    if (nl < 0) continue;
    const k = entry.slice(0, nl);
    const dot = k.lastIndexOf('.');
    const name = k.slice('submodule.'.length, dot);
    const field = k.slice(dot + 1);
    if (!name || (field !== 'path' && field !== 'url')) continue;
    const s = byName.get(name) ?? {};
    s[field] = entry.slice(nl + 1);
    byName.set(name, s);
  }
  const map = new Map<string, { name: string; url?: string }>();
  for (const [name, s] of byName) if (s.path) map.set(s.path.replace(/\/+$/, ''), { name, ...(s.url ? { url: toUtf8(s.url) } : {}) });
  parsed.set(git, { key, map });
  return map;
}

/** The git dir of the repository checked out at `path` (its `.git` folder, or where its `.git` file points); null when there's none. */
export async function submoduleGitDir(git: Git, path: string): Promise<string | null> {
  const dir = subDir(git, path);
  const dotGit = join(dir, '.git');
  try {
    const st = await lstat(dotGit);
    if (st.isDirectory()) return dotGit;
    if (!st.isFile()) return null;
    const m = /^gitdir: (.+?)\r?\n?$/.exec(await readFile(dotGit, 'utf8'));
    if (!m) return null;
    const to = isAbsolute(m[1]) ? m[1] : resolve(dir, m[1]);
    return (await stat(to).catch(() => null))?.isDirectory() ? to : null;
  } catch {
    return null;
  }
}

/** A ref's SHA from a git dir's files (loose, then packed-refs); undefined when only git can say. */
async function refIn(gitDir: string, ref: string): Promise<string | null | undefined> {
  try {
    const text = (await readFile(join(gitDir, ref), 'latin1')).trim();
    return HEX.test(text) ? text : undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
  }
  try {
    for (const line of (await readFile(join(gitDir, 'packed-refs'), 'latin1')).split('\n')) {
      if (line.endsWith(' ' + ref)) return line.slice(0, line.indexOf(' '));
    }
    return null;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
}

/** The commit checked out in the repository at `path` (a submodule, or a nested repo); null when there's none (not checked out, or no commit yet). */
export async function submoduleHead(git: Git, path: string): Promise<string | null> {
  const gitDir = await submoduleGitDir(git, path);
  if (!gitDir) return null;
  let fast: string | null | undefined;
  try {
    // A linked worktree's or a reftable's refs aren't plain files here.
    const plain = !(await stat(join(gitDir, 'commondir')).catch(() => null)) && !(await stat(join(gitDir, 'reftable')).catch(() => null));
    const text = plain ? (await readFile(join(gitDir, 'HEAD'), 'latin1')).trim() : '';
    if (HEX.test(text)) fast = text;
    else if (/^ref: refs\/[^\0-\x20~^:?*[\\]+$/.test(text) && !text.includes('..')) fast = await refIn(gitDir, text.slice(5));
  } catch {
    fast = undefined;
  }
  if (fast !== undefined) return fast;
  const r = await run(subDir(git, path), ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { allowFail: true }).catch(() => null);
  const sha = r?.code === 0 ? r.out.toString('latin1').trim() : '';
  return HEX.test(sha) ? sha : null;
}

/** The URL of a repository's `origin` remote (else its only remote), for an untracked nested repo; undefined when it has none. */
export async function nestedUrl(git: Git, path: string): Promise<string | undefined> {
  const r = await run(subDir(git, path), ['config', '-z', '--get-regexp', '^remote\\..*\\.url$'], { allowFail: true }).catch(() => null);
  const urls = new Map<string, string>();
  for (const entry of r?.out.toString('utf8').split('\0') ?? []) {
    const nl = entry.indexOf('\n');
    if (nl > 0) urls.set(entry.slice('remote.'.length, entry.lastIndexOf('.', nl)), entry.slice(nl + 1));
  }
  return urls.get('origin') ?? (urls.size === 1 ? [...urls.values()][0] : undefined);
}

/** Commits listed per side of a submodule log. */
const MAX = 50;

const logs = new WeakMap<Git, Map<string, SubmoduleLog>>();

/**
 * The commits between two of the submodule at `pathU`'s commits (a UTF-8 path; see `SubmoduleLog`),
 * read in its checkout. Kept once read: commits never change.
 */
export async function submoduleLog(git: Git, pathU: string, oldSha?: string | null, newSha?: string | null): Promise<SubmoduleLog> {
  const old = oldSha && !isZero(oldSha) ? oldSha : '';
  const neu = newSha && !isZero(newSha) ? newSha : '';
  if ((old && !HEX.test(old)) || (neu && !HEX.test(neu)) || (!old && !neu)) throw new GitError('Which commits of the submodule?');
  const path = fromUtf8(pathU);
  if (!path || path.startsWith('/') || path.split('/').some((p) => p === '..' || p === '.' || p === '.git' || p === '')) {
    throw new GitError(`${pathU} isn't a submodule here.`);
  }
  const key = `${path}\0${old}\0${neu}`;
  let memo = logs.get(git);
  const known = memo?.get(key);
  if (known) return known;
  // A submodule .gitmodules names, a gitlink in the index, or a nested repository.
  if (!(await submodulePaths(git)).has(path) && !(await submoduleGitDir(git, path))) {
    const r = await git.run(['--literal-pathspecs', 'ls-files', '-s', '-z', '--', pathU], { allowFail: true });
    if (!r.out.toString('latin1').startsWith('160000 ')) throw new GitError(`${pathU} isn't a submodule here.`);
  }
  const empty = (unavailable: SubmoduleLog['unavailable']): SubmoduleLog => ({ added: [], removed: [], more: { added: 0, removed: 0 }, unavailable });
  if (!(await submoduleGitDir(git, path))) return empty('not-checked-out');
  const cwd = subDir(git, path);
  const sub = (args: string[]) => run(cwd, args, { allowFail: true });
  const check = await run(cwd, ['cat-file', '--batch-check=%(objecttype)'], { input: [old, neu].filter(Boolean).join('\n') + '\n', allowFail: true });
  if (check.code !== 0 || check.out.toString('latin1').split('\n').filter(Boolean).some((t) => t !== 'commit')) return empty('missing-commit');
  const side = async (from: string, not: string) => {
    if (!from) return { list: [] as SubmoduleCommit[], more: 0 };
    const range = not ? [from, `^${not}`] : [from];
    const [log, count] = await Promise.all([
      sub(['log', '--no-color', '--format=%H%x00%s%x00%an%x00%ct', `-n${MAX}`, ...range, '--']),
      sub(['rev-list', '--count', ...range, '--']),
    ]);
    if (log.code !== 0 || count.code !== 0) throw new GitError(`git log failed in ${pathU}: ${log.err.trim() || count.err.trim()}`);
    const list = log.out
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha, subject, author, time] = l.split('\0');
        return { sha, subject, author, time: Number(time) };
      });
    return { list, more: Math.max(0, Number(count.out.toString('utf8').trim()) - list.length) };
  };
  // An added submodule lists its newest commits as added; a deleted one, as removed.
  const [a, r] = await Promise.all([side(neu, old), side(old, neu)]);
  const res: SubmoduleLog = { added: a.list, removed: r.list, more: { added: a.more, removed: r.more } };
  if (!memo) logs.set(git, (memo = new Map()));
  if (memo.size >= 200) memo.delete(memo.keys().next().value!);
  memo.set(key, res);
  return res;
}
