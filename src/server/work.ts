// Uncommitted changes: each file's diff from HEAD to the working tree, untracked files
// included, with which of its lines are staged. Reading only; staging lives in repo.ts.

import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommitDiff, FileDiff } from '../shared/types.ts';
import { DIFF_ARGS, parseDiff, sortFiles } from './diff.ts';
import type { Git } from './git.ts';
import { type Position, type Staging, analyse, emit, positions } from './staging.ts';

/** Status without taking the index lock, so it never gets in the way of the user's git. */
const NO_LOCKS = { GIT_OPTIONAL_LOCKS: '0' };

/** Untracked files beyond this many are listed without a preview. */
const MAX_UNTRACKED_PREVIEWS = 500;
/** Untracked files bigger than this aren't previewed (whole-file staging only). */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/** Files with staged changes, unstaged changes, and untracked files. */
export async function workCounts(git: Git): Promise<{ staged: number; unstaged: number; untracked: number }> {
  const r = await git.run(['status', '--porcelain=v2', '-z', '--untracked-files=normal', '--no-renames'], {
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

/** Paths in a `--raw -z` listing, with their records. */
function rawRecords(out: Buffer): Map<string, string[]> {
  const parts = out.toString('latin1').split('\0');
  const map = new Map<string, string[]>();
  for (let k = 0; k + 1 < parts.length; k += 2) map.set(parts[k + 1], parts[k].slice(1).split(' '));
  return map;
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
  // Refresh stat info first so files that were only touched don't show up as changed.
  await git.run(['update-index', '-q', '--refresh'], { allowFail: true });
  const [tree, cached, files, others] = await Promise.all([
    // Unquoted paths, so each patch's header names its file (see parseDiff).
    git.run(['-c', 'core.quotePath=false', 'diff-index', ...DIFF_ARGS, 'HEAD'], { env: NO_LOCKS }),
    git.run(['diff-index', '--cached', '-r', '-z', '--no-renames', '--raw', '--full-index', 'HEAD'], { env: NO_LOCKS }),
    git.run(['diff-files', '-r', '-z', '--no-renames', '--raw'], { env: NO_LOCKS }),
    git.run(['ls-files', '--others', '--exclude-standard', '-z'], { env: NO_LOCKS }),
  ]);
  const d = parseDiff(tree.out.toString('latin1'), key);
  d.files = d.files.filter((f) => f.hunks.length || f.binary || f.oldMode !== f.newMode || f.status !== 'M');
  const records = rawRecords(cached.out);
  const staged = new Map<string, Staged>();
  for (const [path, [, mode, , sha, status]] of records) staged.set(path, { mode, sha, gone: status === 'D' });
  const unstaged = new Set(rawRecords(files.out).keys());
  const untrackedPaths = new Set(others.out.toString('latin1').split('\0').filter(Boolean));
  const shown = new Set(d.files.map((f) => f.path));

  const partly: FileDiff[] = [];
  for (const f of d.files) {
    const s = staged.get(f.path);
    if (!s) f.stage = 'none';
    else if (s.gone && untrackedPaths.has(f.path)) {
      // `git rm --cached`: HEAD and the file may agree, but the index has nothing.
      untrackedPaths.delete(f.path);
      Object.assign(f, { status: 'M', newMode: f.oldMode, binary: false, partial: false, hunks: [], added: 0, removed: 0 });
      f.stage = 'some';
      f.unshown = "Removed from the index (committing deletes it from the repo) but still in your files.";
    } else if (!unstaged.has(f.path)) {
      f.stage = 'all';
      f.staged = allLines(f);
    } else if (f.partial && !s.gone) partly.push(f);
    else {
      f.stage = 'some';
      f.unshown = 'Staged in a version that is neither HEAD\'s nor your file\'s.';
    }
  }

  // Staged changes the working tree has undone since: nothing to show but the file.
  for (const path of staged.keys()) {
    if (shown.has(path) || untrackedPaths.has(path)) continue;
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
      unshown: 'Staged changes your file no longer has.',
    });
  }

  const blobs = await git.readObjects(partly.flatMap((f) => [f.oldSha, staged.get(f.path)!.sha].filter((x) => !isZero(x))));
  const text = (sha: string) => (isZero(sha) ? '' : (blobs.get(sha)?.data.toString('latin1') ?? ''));
  for (const f of partly) {
    const s = staged.get(f.path)!;
    const pos = positions(text(f.oldSha), f.hunks);
    const index = text(s.sha);
    const staging = analyse(pos, index);
    lineStaging.set(f, { pos, index, staging, mode: s.mode });
    f.stage = 'some';
    f.staged = [...staging.staged];
    const mixed = staging.regions.flatMap((r) => r.lines);
    if (mixed.length) f.mixed = mixed;
    if (staging.other || staging.regions.some((r) => !r.lines.length)) {
      f.unshown = 'Some of what is staged is in neither HEAD nor your file.';
    }
  }

  const paths = [...untrackedPaths];
  const untracked = await Promise.all(paths.map((p, k) => untrackedFile(git.root, p, k < MAX_UNTRACKED_PREVIEWS)));
  for (const f of untracked) f.stage = 'none';
  d.files.push(...untracked);
  sortFiles(d.files);
  return { diff: d, index: createHash('sha1').update(cached.out).digest('hex') };
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

/** An untracked file as a diff that adds all of its lines. `path` is a byte string. */
async function untrackedFile(root: string, path: string, preview: boolean): Promise<FileDiff> {
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
  try {
    const st = await lstat(file);
    if (st.isSymbolicLink()) {
      f.newMode = '120000';
      token.update('link:' + (await readlink(file)));
    } else {
      if (st.mode & 0o111) f.newMode = '100755';
      token.update(`${f.newMode} ${st.size} ${st.mtimeMs}`);
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
  }
  f.token = token.digest('hex');
  return f;
}
