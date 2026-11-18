// Submodules following what legit does: when an operation changes a submodule's commit in the
// index (a switch, a rewrite, a pull, an undo...), a submodule still checked out at the commit it
// had is checked out at the new one, as `--recurse-submodules` would. One the user moved, or with
// changes in the way, is left as it is, with a note. Nested submodules follow the same way.
//
// Repos without .gitmodules (and no submodule ever initialized) pay a stat or two, no process.

import { existsSync } from 'node:fs';
import { lstat, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Git, run, toUtf8 } from './git.ts';
import { subDir, submoduleGitDir, submoduleHead, submodulePaths } from './submodules.ts';

/** A submodule as an operation found it. */
interface Sub {
  name: string;
  /** Its stage-0 gitlink in the index (absent: none, or conflicted). */
  index?: string;
  /** Conflicted: the commit our side has (stage 2). */
  ours?: string;
  conflicted: boolean;
  /** The commit checked out in it; null when it isn't checked out. */
  head: string | null;
}

export interface SubmoduleSnapshot {
  git: Git;
  subs: Map<string, Sub>;
}

const short = (sha: string) => sha.slice(0, 7);
/** Most a missing commit's fetch (`git submodule update`) may take. */
const FETCH_MS = 120_000;

/** Whether `git`'s repo has or had submodules: a .gitmodules, or submodules' git dirs. Stats only. */
async function hasSubmodules(git: Git): Promise<boolean> {
  const [a, b] = await Promise.all([
    stat(join(git.root, '.gitmodules')).then((s) => s.isFile(), () => false),
    stat(join(git.commonDir, 'modules')).then((s) => s.isDirectory(), () => false),
  ]);
  return a || b;
}

/** Stage-0 gitlinks and conflicted submodules' stages of `paths`, from the index. */
async function indexLinks(git: Git, paths: string[]): Promise<Map<string, { index?: string; ours?: string; conflicted: boolean }>> {
  const out = new Map<string, { index?: string; ours?: string; conflicted: boolean }>();
  if (!paths.length) return out;
  for (let i = 0; i < paths.length; i += 500) {
    const chunk = paths.slice(i, i + 500).map(toUtf8);
    const r = await git.run(['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...chunk], { env: { GIT_OPTIONAL_LOCKS: '0' } });
    for (const rec of r.out.toString('latin1').split('\0')) {
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const [mode, sha, stage] = rec.slice(0, tab).split(' ');
      const path = rec.slice(tab + 1);
      const e = out.get(path) ?? { conflicted: false };
      if (stage === '0') {
        if (mode === '160000') e.index = sha;
      } else {
        e.conflicted = true;
        if (stage === '2' && mode === '160000') e.ours = sha;
      }
      out.set(path, e);
    }
  }
  return out;
}

/**
 * Each submodule's gitlink in the index and the commit checked out in it, before an operation;
 * null (without running git) when the repo has no submodules.
 */
export async function submoduleSnapshot(git: Git): Promise<SubmoduleSnapshot | null> {
  if (!(await hasSubmodules(git))) return null;
  return { git, subs: await readSubs(git, [...(await submodulePaths(git)).keys()]) };
}

async function readSubs(git: Git, extra: string[]): Promise<Map<string, Sub>> {
  const declared = await submodulePaths(git);
  const paths = [...new Set([...declared.keys(), ...extra])];
  const [links, heads] = await Promise.all([indexLinks(git, paths), Promise.all(paths.map((p) => submoduleHead(git, p)))]);
  const subs = new Map<string, Sub>();
  paths.forEach((p, k) => {
    const l = links.get(p);
    subs.set(p, { name: declared.get(p)?.name ?? p, index: l?.index, ours: l?.ours, conflicted: !!l?.conflicted, head: heads[k] });
  });
  return subs;
}

/**
 * After an operation: submodules whose gitlink it changed follow it if they were checked out at
 * the old one (see the top). Returns notes for the user, and whether any checkout moved. Never throws.
 */
export async function followSubmodules(before: SubmoduleSnapshot | null): Promise<{ notes: string[]; moved: boolean }> {
  if (!before) return { notes: [], moved: false };
  try {
    return await follow(before, '');
  } catch (e) {
    return { notes: [`Submodules weren't updated: ${(e as Error).message}`], moved: false };
  }
}

async function follow(before: SubmoduleSnapshot, prefix: string): Promise<{ notes: string[]; moved: boolean }> {
  const { git } = before;
  const after = await readSubs(git, [...before.subs.keys()]);
  const notes: string[] = [];
  let moved = false;
  await Promise.all(
    [...after].map(async ([path, a]) => {
      const b = before.subs.get(path);
      const name = prefix + toUtf8(path);
      const r = await followOne(git, path, name, b, a);
      if (r.note) notes.push(r.note);
      if (r.moved) moved = true;
      if (r.nested) {
        const n = await r.nested();
        notes.push(...n.notes);
        moved ||= n.moved;
      }
    }),
  );
  return { notes, moved };
}

interface Step {
  note?: string;
  moved?: boolean;
  /** Its own submodules, to follow once it moved. */
  nested?: () => Promise<{ notes: string[]; moved: boolean }>;
}

async function followOne(git: Git, path: string, name: string, b: Sub | undefined, a: Sub): Promise<Step> {
  if (a.conflicted) return {};
  const was = b ? (b.conflicted ? b.ours : b.index) : undefined;
  if (was === a.index) return {};
  // Taken out of the index: its folder goes when that loses nothing.
  if (!a.index) return b?.head ? removeIfClean(git, path, name, b.head) : {};
  const dir = subDir(git, path);
  // Not in the index before (another branch has it): its folder, if any, is as the operation found it.
  const head = b ? b.head : a.head;
  if (!head) {
    // Populated when it was initialized here before.
    if (was || existsSync(join(dir, '.git')) || !(await initialized(git, a.name))) return {};
    const r = await run(git.root, ['submodule', 'update', '--init', '--checkout', '--', toUtf8(path)], { allowFail: true, timeout: FETCH_MS });
    if (r.code !== 0) return { note: `Submodule ${name} couldn't be checked out: ${lastLine(r.err)}` };
    return { moved: true, nested: () => nestedFollow(dir, name, null) };
  }
  if (head !== was) {
    if (head === a.index) return {};
    return { note: `Submodule ${name} stays at ${short(head)}, which you checked out; this commit has ${short(a.index)}.` };
  }
  const sub = await Git.open(dir).catch(() => null);
  if (!sub) return { note: `Submodule ${name} couldn't be read, so it stays at ${short(head)}.` };
  const inner = await submoduleSnapshot(sub);
  const has = await run(dir, ['cat-file', '-e', `${a.index}^{commit}`], { allowFail: true });
  let r;
  if (has.code === 0) r = await run(dir, ['checkout', '-q', '--detach', a.index, '--'], { allowFail: true });
  else {
    r = await run(git.root, ['submodule', 'update', '--checkout', '--', toUtf8(path)], { allowFail: true, timeout: FETCH_MS });
    if (r.code !== 0) {
      return { note: `Submodule ${name} stays at ${short(head)}: it doesn't have ${short(a.index)} (fetch it in the submodule).` };
    }
  }
  if (r.code !== 0) {
    return { note: `Submodule ${name} stays at ${short(head)}: its own changes are in the way of ${short(a.index)}.` };
  }
  return { moved: true, nested: () => nestedFollow(dir, name, inner) };
}

async function nestedFollow(dir: string, name: string, inner: SubmoduleSnapshot | null): Promise<{ notes: string[]; moved: boolean }> {
  if (inner) return follow(inner, name + '/');
  // Just populated: its own submodules come as `git submodule update --init` makes them.
  if (!existsSync(join(dir, '.gitmodules'))) return { notes: [], moved: false };
  const r = await run(dir, ['submodule', 'update', '--init', '--recursive', '--checkout'], { allowFail: true, timeout: FETCH_MS });
  return { notes: r.code === 0 ? [] : [`Submodules of ${name} couldn't be checked out: ${lastLine(r.err)}`], moved: r.code === 0 };
}

const lastLine = (s: string) => s.trim().split('\n').at(-1) || 'git failed';

/** It was initialized here before: its git dir is in the modules folder, or it has a URL in the config. */
async function initialized(git: Git, name: string): Promise<boolean> {
  if (existsSync(join(git.commonDir, 'modules', toUtf8(name)))) return true;
  return !!(await git.text(['config', '--get', `submodule.${toUtf8(name)}.url`], { allowFail: true }));
}

/**
 * A submodule's folder, once it's out of the index: removed when its git dir is kept elsewhere
 * (absorbed into the modules folder) and nothing in it would be lost; else left, with a note.
 */
async function removeIfClean(git: Git, path: string, name: string, head: string): Promise<Step> {
  const dir = subDir(git, path);
  const keep = { note: `Submodule ${name} isn't in this commit, but its folder stays: it has changes or commits of its own.` };
  // Something else is at that path in the index now (files where the submodule was): git placed them.
  const there = await git.run(['--literal-pathspecs', 'ls-files', '-z', '--', toUtf8(path)], { allowFail: true });
  if (there.out.length) return {};
  try {
    if (!(await lstat(join(dir, '.git'))).isFile()) return keep;
  } catch {
    return {};
  }
  // Submodules of its own might keep their git dirs inside it.
  if (existsSync(join(dir, '.gitmodules'))) return keep;
  const gitDir = await submoduleGitDir(git, path);
  const modules = resolve(git.commonDir, 'modules');
  if (!gitDir || !(gitDir + '/').startsWith(modules + '/')) return keep;
  const [status, stash, reach] = await Promise.all([
    run(dir, ['status', '--porcelain', '--ignored', '--untracked-files=all'], { allowFail: true }),
    run(dir, ['rev-parse', '-q', '--verify', 'refs/stash'], { allowFail: true }),
    // Its checked-out commit stays reachable in its git dir only through a ref: detached, it needs one.
    run(dir, ['for-each-ref', '--count=1', '--contains', head, '--format=x'], { allowFail: true }),
  ]);
  if (status.code !== 0 || status.out.length || stash.code === 0) return keep;
  if (reach.code !== 0 || !reach.out.length) {
    const r = await run(dir, ['update-ref', '-m', 'legit: kept when its folder was removed', `refs/legit/removed/${Date.now()}`, head], { allowFail: true });
    if (r.code !== 0) return keep;
  }
  // The .git file first: what's left is plain files, all committed.
  await rm(join(dir, '.git'), { force: true });
  await rm(dir, { recursive: true, force: true });
  return { moved: true };
}
