// Uncommitted changes: each file's diff from HEAD to the working tree, untracked files
// included, with which of its lines are staged. Reading only; staging lives in repo.ts.

import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, readlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CommitDiff, FileDiff, Hunk } from '../shared/types.ts';
import { GITLINK, RENAME_ARGS, parseDiff, sortFiles } from './diff.ts';
import { type Git, fromUtf8, toUtf8 } from './git.ts';
import { type Position, type Staging, analyse, emit, positions } from './staging.ts';
import { nestedUrl, submoduleHead, submodulePaths } from './submodules.ts';

/** Status without taking the index lock, so it never gets in the way of the user's git. */
const NO_LOCKS = { GIT_OPTIONAL_LOCKS: '0' };

/** Untracked files beyond this many are listed without a preview. */
const MAX_UNTRACKED_PREVIEWS = 500;
/** Untracked files bigger than this aren't previewed (whole-file staging only). */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
/** A file changed more recently than this could change again without its stat showing it (timestamps are coarse). */
const SETTLED_MS = 2000;

/** Files with staged changes, unstaged changes, and untracked files. */
export async function workCounts(git: Git): Promise<{ staged: number; unstaged: number; untracked: number }> {
  const r = await git.run(['status', '--porcelain=v2', '-z', '--untracked-files=normal'], {
    env: NO_LOCKS,
    allowFail: true,
  });
  const counts = { staged: 0, unstaged: 0, untracked: 0 };
  if (r.code !== 0) return counts;
  for (const entry of r.out.toString('latin1').split('\0')) {
    if (entry.startsWith('? ')) counts.untracked++;
    else if (entry.startsWith('1 ') || entry.startsWith('2 ') || entry.startsWith('u ')) {
      const xy = entry.slice(2, 4);
      if (xy[0] !== '.') counts.staged++;
      if (xy[1] !== '.') counts.unstaged++;
    }
  }
  return counts;
}

/** An index entry that differs from HEAD's: `diff-index --cached --raw`. */
interface Staged {
  mode: string;
  sha: string;
  /** Not in the index (staged deletion). */
  gone: boolean;
}

/** A partly staged file's lines against its index entry, kept for staging more of it. */
export interface LineStaging {
  pos: Position[];
  index: string;
  staging: Staging;
  /** The index entry's mode. */
  mode: string;
}
const lineStaging = new WeakMap<FileDiff, LineStaging>();

/** What a listing made of a file, by its token (the same token is the same patch), for the next listing to reuse. */
interface Known {
  hunks: Hunk[];
  /** Its lines against its index entry, and that entry (`<sha> <mode>`). */
  staging?: { entry: string; line: LineStaging };
}

/** An untracked file as it was read; `stat` is empty when it changed too recently to be kept. */
interface Read {
  stat: string;
  f: FileDiff;
}

/**
 * The last listing's files: one that hasn't changed since isn't read or worked out again, and
 * the snapshots that have it share its lines.
 */
const listed = new WeakMap<Git, { files: Map<string, Known>; untracked: Map<string, Read>; patches: Patches }>();

/** Each file's part of the HEAD-to-working-tree diff (as parsed, before a listing adds to it) by its `stamp`, and what else it depends on. */
interface Patches {
  context: string;
  byStamp: Map<string, FileDiff>;
}

/** Files whose patch is asked for by name, the others' taken from the last listing; past this many, the whole diff is. */
const MAX_REDIFFED = 1000;

/** A `--raw -z` record: its metadata (modes, SHAs, status) and its path (a rename's old path, then its new one). */
interface Raw {
  meta: string;
  paths: string[];
}

function rawList(out: Buffer): Raw[] {
  const parts = out.toString('latin1').split('\0');
  const list: Raw[] = [];
  for (let k = 0; k + 1 < parts.length; k += 2) {
    const meta = parts[k].slice(1);
    const status = meta.split(' ')[4] ?? '';
    list.push({ meta, paths: status[0] === 'R' || status[0] === 'C' ? [parts[k + 1], parts[++k + 1]] : [parts[k + 1]] });
  }
  return list;
}

/**
 * What a file's patch follows from: its record, and the file's stat when that side is on disk. Null
 * when that can't tell (a submodule, or a file changed too recently for its stat to show the next change).
 */
async function stampOf(root: string, r: Raw): Promise<string | null> {
  const [oldMode, newMode, , newSha] = r.meta.split(' ');
  if (oldMode === '160000' || newMode === '160000') return null;
  let stat = '';
  if (isZero(newSha)) {
    try {
      const at = Date.now();
      const st = await lstat(join(root, Buffer.from(r.paths.at(-1)!, 'latin1').toString('utf8')), { bigint: true });
      if (Number(st.mtimeMs > st.ctimeMs ? st.mtimeMs : st.ctimeMs) > at - SETTLED_MS) return null;
      stat = `${st.ino} ${st.mode} ${st.size} ${st.mtimeNs} ${st.ctimeNs}`;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      stat = 'gone';
    }
  }
  return `${r.meta}\0${r.paths.join('\0')}\0${stat}`;
}

const statOf = (file: string) => stat(file, { bigint: true }).then((st) => `${st.ino} ${st.size} ${st.mtimeNs} ${st.ctimeNs}`, () => '-');

/**
 * What every file's patch also follows from: HEAD, git's config and attributes files, and the
 * working tree's .gitattributes that differ from HEAD's. Any change and the whole diff is asked for again.
 */
async function contextOf(git: Git, stamps: (string | null)[], records: Raw[], untracked: string[]): Promise<string> {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const files = [
    join(git.commonDir, 'config'), join(git.gitDir, 'config.worktree'), join(git.commonDir, 'info', 'attributes'),
    process.env.GIT_CONFIG_GLOBAL || join(homedir(), '.gitconfig'), join(xdg, 'git', 'config'), join(xdg, 'git', 'attributes'),
  ];
  const attrs = (p: string) => p === '.gitattributes' || p.endsWith('/.gitattributes');
  const [head, ...stats] = await Promise.all([
    git.headState().then((h) => h.head ?? ''),
    ...files.map(statOf),
    ...untracked.filter(attrs).map((p) => statOf(join(git.root, Buffer.from(p, 'latin1').toString('utf8'))).then((st) => `${p} ${st}`)),
  ]);
  const changed = records.flatMap((r, k) => (r.paths.some(attrs) ? [stamps[k] ?? randomBytes(8).toString('hex')] : []));
  return [head, ...stats, ...changed].join('\0');
}

/** `f` is the file record `r` lists, as `r` lists it. */
const sameFile = (f: FileDiff, r: Raw) => {
  const [oldMode, newMode, oldSha, , status] = r.meta.split(' ');
  return f.path === r.paths.at(-1) && f.oldPath === (r.paths.length > 1 ? r.paths[0] : undefined) && f.status === status[0] && f.oldMode === oldMode && f.newMode === newMode && f.oldSha === oldSha;
};

/**
 * The diff from HEAD to the working tree (`diff-index` with patches), asking git only for the
 * patches of files that changed since the last listing (`last`). What it was made from, for the next.
 */
async function headToFiles(git: Git, key: string, records: Raw[], untracked: string[], last?: Patches): Promise<{ d: CommitDiff; patches: Patches }> {
  const stamps = await Promise.all(records.map((r) => stampOf(git.root, r)));
  const context = await contextOf(git, stamps, records, untracked);
  const byStamp = new Map<string, FileDiff>();
  const kept: FileDiff[] = [];
  const want: number[] = [];
  records.forEach((r, k) => {
    const had = last?.context === context && stamps[k] !== null ? last.byStamp.get(stamps[k]) : undefined;
    if (had) {
      byStamp.set(stamps[k]!, had);
      kept.push({ ...had });
    } else want.push(k);
  });
  const paths = want.flatMap((k) => records[k].paths);
  // Arguments reach git as UTF-8: a path that isn't can't be named.
  const whole = want.length > MAX_REDIFFED || kept.length === 0 || paths.some((p) => fromUtf8(toUtf8(p)) !== p);
  // Unquoted paths, so each patch's header names its file (see parseDiff).
  const diff = async (paths: string[] | null) =>
    parseDiff(
      (await git.run(['-c', 'core.quotePath=false', ...(paths ? ['--literal-pathspecs'] : []), 'diff-index', ...RENAME_ARGS, 'HEAD', ...(paths ? ['--', ...paths] : [])], { env: NO_LOCKS })).out.toString('latin1'),
      key,
    );
  if (!whole && !want.length) return { d: { sha: key, files: sortFiles(kept) }, patches: { context, byStamp } };
  let d = await diff(whole ? null : paths.map(toUtf8));
  // Asked for by name, a file must come as it was listed (a rename paired the same way, say), or the whole diff is.
  if (!whole && (d.files.length !== want.length || !want.every((k) => d.files.some((f) => sameFile(f, records[k]))))) {
    d = await diff(null);
    byStamp.clear();
    kept.length = 0;
  }
  const at = new Map(records.map((r, k) => [r.paths.at(-1)!, k]));
  // Each kept as parsed: a listing adds to the copy it shows.
  for (const f of d.files) {
    const k = at.get(f.path);
    if (k !== undefined && stamps[k] !== null && sameFile(f, records[k])) byStamp.set(stamps[k]!, { ...f });
  }
  return { d: { sha: key, files: sortFiles([...kept, ...d.files]) }, patches: { context, byStamp } };
}

/** Paths in a `--raw -z` listing, with their records; a rename's under its new path, with its old one last. */
function rawRecords(out: Buffer): Map<string, string[]> {
  const parts = out.toString('latin1').split('\0');
  const map = new Map<string, string[]>();
  for (let k = 0; k + 1 < parts.length; k += 2) {
    const rec = parts[k].slice(1).split(' ');
    if (rec[4]?.[0] === 'R' || rec[4]?.[0] === 'C') map.set(parts[k + 2], [...rec, parts[++k]]);
    else map.set(parts[k + 1], rec);
  }
  return map;
}

/** Submodules' state as `status --porcelain=v2` says it (`S<c><m><u>`: commit changed, modified content, untracked content), by path. */
export function submoduleStates(out: Buffer): Map<string, { state: string; head: string }> {
  const states = new Map<string, { state: string; head: string }>();
  for (const entry of out.toString('latin1').split('\0')) {
    if (!entry.startsWith('1 ') || entry[5] !== 'S') continue;
    const parts = entry.split(' ');
    states.set(parts.slice(8).join(' '), { state: entry.slice(6, 9), head: parts[6] });
  }
  return states;
}

/**
 * Status of just the submodules, untracked files inside them included (status without untracked
 * files leaves those out); null without submodules, so other repos pay nothing.
 */
async function submoduleStatus(git: Git): Promise<Buffer | null> {
  const paths = [...(await submodulePaths(git)).keys()].filter((p) => fromUtf8(toUtf8(p)) === p);
  if (!paths.length) return null;
  const r = await git.run(['--literal-pathspecs', 'status', '--porcelain=v2', '-z', '--untracked-files=normal', '--no-renames', '--', ...paths.map(toUtf8)], {
    env: NO_LOCKS,
    allowFail: true,
  });
  return r.code === 0 ? r.out : null;
}

/** Paths whose working-tree file differs from the index (`status --porcelain=v2 -z --no-renames`), conflicted ones included. */
export function unstagedPaths(out: Buffer): Set<string> {
  const paths = new Set<string>();
  for (const entry of out.toString('latin1').split('\0')) {
    // `1 XY sub mH mI mW hH hI path`; `u XY sub m1 m2 m3 mW h1 h2 h3 path`.
    if (entry.startsWith('1 ') && entry[3] !== '.') paths.add(entry.split(' ').slice(8).join(' '));
    else if (entry.startsWith('u ')) paths.add(entry.split(' ').slice(10).join(' '));
  }
  return paths;
}

const changedLines = (f: FileDiff) => f.added + f.removed;
const allLines = (f: FileDiff) => Array.from({ length: Math.max(1, changedLines(f)) }, (_, k) => k);
const isZero = (sha: string) => /^0+$/.test(sha);

/**
 * Every uncommitted change as one diff per file, HEAD to the working tree, then untracked
 * files as all-added diffs. Each file says what of it is staged. `index` fingerprints the
 * index, so a snapshot of these changes is a new one when only what's staged changed.
 */
export async function workDiff(git: Git, key: string): Promise<{ diff: CommitDiff; index: string }> {
  const last = listed.get(git);
  const [raw, cached, files, status, others, subStatus] = await Promise.all([
    git.run(['diff-index', '-r', '-z', '-M', '--full-index', '--raw', 'HEAD'], { env: NO_LOCKS }),
    git.run(['diff-index', '--cached', '-r', '-z', '-M', '--raw', '--full-index', 'HEAD'], { env: NO_LOCKS }),
    git.run(['diff-files', '-r', '-z', '--no-renames', '--raw'], { env: NO_LOCKS }),
    git.run(['status', '--porcelain=v2', '-z', '--untracked-files=no', '--no-renames'], { env: NO_LOCKS }),
    git.run(['ls-files', '--others', '--exclude-standard', '-z'], { env: NO_LOCKS }),
    submoduleStatus(git),
  ]);
  // A folder listed with its slash is a git repository of its own, nested here.
  const nested = new Set<string>();
  const untrackedPaths = new Set(
    others.out
      .toString('latin1')
      .split('\0')
      .filter(Boolean)
      .map((p) => (p.endsWith('/') ? (nested.add(p.slice(0, -1)), p.slice(0, -1)) : p)),
  );
  const { d, patches } = await headToFiles(git, key, rawList(raw.out), [...untrackedPaths], last?.patches);
  d.files = d.files.filter((f) => f.hunks.length || f.binary || f.oldMode !== f.newMode || f.status !== 'M');
  const states = submoduleStates(subStatus ?? status.out);
  // A submodule with only untracked files inside: no diff lists it.
  for (const [path, { state, head }] of states) {
    if (state[2] !== 'U' || state[0] === 'C' || state[1] === 'M' || d.files.some((f) => f.path === path)) continue;
    d.files.push({
      path, status: 'M', oldMode: GITLINK, newMode: GITLINK, oldSha: head, newSha: head,
      binary: false, partial: false, hunks: [], added: 0, removed: 0, submodule: { old: head },
      token: createHash('sha1').update(`untracked inside ${head}`).digest('hex'),
    });
  }
  const known = new Map<string, Known>();
  for (const f of d.files) {
    const k = last?.files.get(f.token!) ?? { hunks: f.hunks };
    f.hunks = k.hunks;
    known.set(f.token!, k);
  }
  const records = rawRecords(cached.out);
  const staged = new Map<string, Staged>();
  for (const [path, [, mode, , sha, status, from]] of records) {
    staged.set(path, { mode, sha, gone: status === 'D' });
    // A staged rename's old path is a staged deletion.
    if (status[0] === 'R') staged.set(from, { mode: '000000', sha: '0'.repeat(sha.length), gone: true });
  }
  // What differs from the index by content, not just by stat (a touched file), without taking the index's lock.
  const unstaged = unstagedPaths(status.out);
  // Only files that were merely touched are refreshed, the one time: the lock would fail a git the user runs meanwhile.
  if ([...rawRecords(files.out).keys()].some((p) => !unstaged.has(p))) await git.run(['update-index', '-q', '--refresh'], { allowFail: true });
  const shown = new Set(d.files.map((f) => f.path));
  const renamed = new Set(d.files.flatMap((f) => (f.oldPath === undefined ? [] : [f.oldPath])));

  const partly: FileDiff[] = [];
  const subs: FileDiff[] = [];
  for (const f of d.files) {
    const s = staged.get(f.path);
    if (f.submodule && !(s?.gone && untrackedPaths.has(f.path))) subs.push(f);
    else if (!s) f.stage = 'none';
    else if (s.gone && untrackedPaths.has(f.path)) {
      // `git rm --cached`: HEAD and the file may agree, but the index has nothing.
      untrackedPaths.delete(f.path);
      Object.assign(f, { status: 'M', newMode: f.oldMode, binary: false, partial: false, hunks: [], added: 0, removed: 0 });
      f.stage = 'some';
      f.unshown = "Removed from the index (committing deletes it from the repo) but still in your files.";
    } else if (f.oldPath !== undefined && unstaged.has(f.oldPath)) {
      f.stage = 'some';
      f.unshown = 'Its new name is staged, but its old one is still in the index.';
    } else if (!unstaged.has(f.path)) {
      f.stage = 'all';
      f.staged = allLines(f);
    } else if (f.partial && !s.gone) partly.push(f);
    else {
      f.stage = 'some';
      f.unshown = 'Staged in a version that is neither HEAD\'s nor your file\'s.';
    }
  }

  if (subs.length) await submoduleFiles(git, subs, staged, states);

  // Staged changes the working tree has undone since: nothing to show but the file.
  for (const path of staged.keys()) {
    if (shown.has(path) || renamed.has(path) || untrackedPaths.has(path)) continue;
    const r = records.get(path)!;
    d.files.push({
      path,
      status: 'M',
      oldMode: r[0],
      newMode: r[0],
      oldSha: r[2],
      newSha: r[2],
      binary: false,
      partial: false,
      hunks: [],
      added: 0,
      removed: 0,
      token: createHash('sha1').update(`index-only ${r.join(' ')}`).digest('hex'),
      stage: 'some',
      ...(r[0] === GITLINK || r[1] === GITLINK
        ? { submodule: { old: r[2], new: r[2] }, unshown: `Staged at commit ${r[3].slice(0, 7)}, but it has ${r[2].slice(0, 7)} checked out, as HEAD has.` }
        : { unshown: 'Staged changes your file no longer has.' }),
    });
  }

  // A file's lines against its index entry follow from its patch and that entry: worked out again only when either changed.
  const entry = (f: FileDiff) => `${staged.get(f.path)!.sha} ${staged.get(f.path)!.mode}`;
  const unknown = partly.filter((f) => known.get(f.token!)!.staging?.entry !== entry(f));
  const blobs = await git.readObjects(unknown.flatMap((f) => [f.oldSha, staged.get(f.path)!.sha].filter((x) => !isZero(x))));
  const text = (sha: string) => (isZero(sha) ? '' : (blobs.get(sha)?.data.toString('latin1') ?? ''));
  for (const f of partly) {
    const s = staged.get(f.path)!;
    const k = known.get(f.token!)!;
    if (k.staging?.entry !== entry(f)) {
      const pos = positions(text(f.oldSha), f.hunks);
      const index = text(s.sha);
      k.staging = { entry: entry(f), line: { pos, index, staging: analyse(pos, index), mode: s.mode } };
    }
    const { staging } = k.staging.line;
    lineStaging.set(f, k.staging.line);
    f.stage = 'some';
    f.staged = [...staging.staged];
    const mixed = staging.regions.flatMap((r) => r.lines);
    if (mixed.length) f.mixed = mixed;
    if (staging.other || staging.regions.some((r) => !r.lines.length)) {
      f.unshown = 'Some of what is staged is in neither HEAD nor your file.';
    }
  }

  const paths = [...untrackedPaths];
  const reads = await Promise.all(
    paths.map((p, k) => (nested.has(p) ? nestedRepo(git, p) : untrackedFile(git.root, p, k < MAX_UNTRACKED_PREVIEWS, last?.untracked.get(p)))),
  );
  const untracked = new Map<string, Read>();
  reads.forEach((r, k) => r.stat && untracked.set(paths[k], r));
  listed.set(git, { files: known, untracked, patches });
  for (const { f } of reads) {
    f.stage = 'none';
    d.files.push(f);
  }
  sortFiles(d.files);
  return { diff: d, index: createHash('sha1').update(cached.out).digest('hex') };
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * Submodules in the listing: the commit each has checked out (the working-tree side, which git
 * leaves as zeros), what's going on inside it (`states`, from status), and what of it is staged:
 * a submodule is staged as a whole, at the commit it has checked out.
 */
async function submoduleFiles(git: Git, subs: FileDiff[], staged: Map<string, Staged>, states: Map<string, { state: string }>) {
  const known = await submodulePaths(git);
  await Promise.all(
    subs.map(async (f) => {
      const sub = (f.submodule ??= {});
      const url = known.get(f.path)?.url;
      if (url) sub.url = url;
      const s = staged.get(f.path);
      // The index's commit for it (HEAD's when nothing is staged); none when its deletion is staged.
      const index = s ? (s.gone || s.mode !== GITLINK ? null : s.sha) : f.oldMode === GITLINK ? f.oldSha : null;
      if (f.newMode !== GITLINK || f.status === 'D') {
        // Deleted, or turned into a file: staged as any file is.
        f.stage = !s ? 'none' : s.gone === (f.status === 'D') && s.mode === f.newMode ? 'all' : 'some';
        if (f.stage === 'all') f.staged = allLines(f);
        return;
      }
      const head = await submoduleHead(git, f.path);
      if (head) sub.new = head;
      else sub.missing = true;
      const state = states.get(f.path)?.state ?? '';
      if (state[1] === 'M' || state[2] === 'U') sub.dirty = { modified: state[1] === 'M', untracked: state[2] === 'U' };
      if (head && head === sub.old) {
        // Only its own files changed: nothing of it to stage here.
        Object.assign(f, { newSha: head, hunks: [], added: 0, removed: 0 });
        f.stage = index && index !== head ? 'some' : 'none';
        f.unshown =
          f.stage === 'some'
            ? `Staged at commit ${short(index!)}, but it has ${short(head)} checked out, as HEAD has.`
            : 'Its changes are inside the submodule: commit them there, then stage the commit it moves to.';
        return;
      }
      if (head) f.newSha = head;
      if (index === head) {
        f.stage = 'all';
        f.staged = allLines(f);
      } else if (index === (sub.old ?? null)) f.stage = 'none';
      else {
        f.stage = 'some';
        f.unshown = index ? `Staged at commit ${short(index)}, which isn't the one it has checked out.` : 'Its removal is staged, but it is still checked out.';
      }
    }),
  );
}

/** An untracked folder that is a repository of its own, as a submodule to add: its HEAD, and its remote's URL (what .gitmodules would say). */
async function nestedRepo(git: Git, path: string): Promise<Read> {
  const [head, url] = await Promise.all([submoduleHead(git, path), nestedUrl(git, path)]);
  const f: FileDiff = {
    path,
    status: 'A',
    oldMode: '000000',
    newMode: GITLINK,
    oldSha: '',
    newSha: head ?? '',
    binary: false,
    partial: false,
    untracked: true,
    hunks: [],
    added: 0,
    removed: 0,
    submodule: { nested: true, ...(head ? { new: head } : {}), ...(url ? { url } : {}) },
    token: createHash('sha1').update(`nested ${head} ${url}`).digest('hex'),
  };
  if (!head) f.unshown = 'A git repository of its own, with no commit yet: commit in it first, then it can be added as a submodule.';
  else if (!url) f.unshown = 'A git repository of its own, with no remote: give it one (its `origin`) so it can be added as a submodule others can clone.';
  else f.unshown = `A git repository of its own: staging it adds it as a submodule, cloned from ${url}.`;
  return { stat: '', f };
}

/**
 * File `f`'s lines against its index entry: worked out when it was listed if it was partly
 * staged, else from what's staged (nothing, or everything). `head` is HEAD's version.
 */
export function stagingOf(f: FileDiff, head: string): LineStaging {
  const known = lineStaging.get(f);
  if (known) return known;
  const pos = positions(head, f.hunks);
  const all = f.stage === 'all';
  const index = all ? emit(pos, () => true) : head;
  const staging = analyse(pos, index);
  return { pos, index, staging, mode: all ? f.newMode : f.untracked ? f.newMode : f.oldMode };
}

/**
 * An untracked file as a diff that adds all of its lines. `path` is a byte string. `last`: how
 * it was read before, taken again (a copy) while its stat is the same.
 */
async function untrackedFile(root: string, path: string, preview: boolean, last?: Read): Promise<Read> {
  const file = join(root, Buffer.from(path, 'latin1').toString('utf8'));
  const f: FileDiff = {
    path,
    status: 'A',
    oldMode: '000000',
    newMode: '100644',
    oldSha: '',
    newSha: '',
    binary: true,
    partial: false,
    untracked: true,
    hunks: [],
    added: 0,
    removed: 0,
  };
  const token = createHash('sha1');
  let stat = '';
  try {
    const at = Date.now();
    const st = await lstat(file, { bigint: true });
    if (st.isSymbolicLink()) {
      f.newMode = '120000';
      token.update('link:' + (await readlink(file)));
    } else {
      stat = `${preview} ${st.ino} ${st.mode} ${st.size} ${st.mtimeNs} ${st.ctimeNs}`;
      if (last?.stat === stat) return { stat, f: { ...last.f } };
      if (Number(st.mtimeMs > st.ctimeMs ? st.mtimeMs : st.ctimeMs) > at - SETTLED_MS) stat = '';
      if (st.mode & 0o111n) f.newMode = '100755';
      token.update(`${f.newMode} ${st.size} ${st.mtimeNs}`);
      if (preview && st.size <= MAX_PREVIEW_BYTES) {
        const data = await readFile(file);
        token.update(data);
        if (!data.subarray(0, 8000).includes(0)) {
          const text = data.toString('latin1');
          const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
          f.binary = false;
          f.partial = true;
          f.added = lines.length;
          if (lines.length) {
            f.hunks.push({
              header: `@@ -0,0 +1,${lines.length} @@`,
              oldStart: 0,
              oldCount: 0,
              newStart: 1,
              lines: lines.map((l, i) => ({
                t: '+' as const,
                s: l.endsWith('\n') ? l.slice(0, -1) : l,
                i,
                n: i + 1,
                ...(l.endsWith('\n') ? {} : { eof: true }),
              })),
            });
          }
        }
      }
    }
  } catch {
    // Vanished while we looked: staging it will fail cleanly.
    stat = '';
  }
  f.token = token.digest('hex');
  return { stat, f };
}
