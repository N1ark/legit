// Uncommitted changes: what's staged (index vs HEAD), what isn't (working tree vs index),
// and untracked files. Reading only; staging lives in repo.ts.

import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommitDiff, FileDiff } from '../shared/types.ts';
import { DIFF_ARGS, parseDiff } from './diff.ts';
import type { Git } from './git.ts';

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

/** Index vs HEAD. */
export async function stagedDiff(git: Git, key: string): Promise<CommitDiff> {
  const { out } = await git.run(['diff-index', '--cached', ...DIFF_ARGS, 'HEAD'], { env: NO_LOCKS });
  return parseDiff(out.toString('latin1'), key);
}

/** Working tree vs index, followed by untracked files as all-added diffs. */
export async function unstagedDiff(git: Git, key: string): Promise<CommitDiff> {
  // Refresh stat info first so files that were only touched don't show up as changed.
  await git.run(['update-index', '-q', '--refresh'], { allowFail: true });
  const [tracked, others] = await Promise.all([
    git.run(['diff-files', ...DIFF_ARGS], { env: NO_LOCKS }),
    git.run(['ls-files', '--others', '--exclude-standard', '-z'], { env: NO_LOCKS }),
  ]);
  const d = parseDiff(tracked.out.toString('latin1'), key);
  const paths = others.out.toString('latin1').split('\0').filter(Boolean);
  const untracked = await Promise.all(paths.map((p, k) => untrackedFile(git.root, p, k < MAX_UNTRACKED_PREVIEWS)));
  d.files.push(...untracked);
  return d;
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
