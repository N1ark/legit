// Commit diffs: parsing git's patch output, and rebuilding files from a subset of changed lines.

import type { CommitDiff, DiffLine, FileDiff, Hunk } from '../shared/types.ts';
import { type Git, toUtf8 } from './git.ts';

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const TEXT_MODES = new Set(['100644', '100755', '000000']);

/** Diff of a commit against its first parent. All strings are byte strings. */
export async function commitDiff(git: Git, sha: string): Promise<CommitDiff> {
  const c = await git.commit(sha);
  const { out } = await git.run([
    'diff-tree', '-r', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--full-index',
    '--patch-with-raw', '-U3', c.parents[0] ?? git.emptyTree, sha,
  ]);
  const data = out.toString('latin1');

  // Raw section: ":oldmode newmode oldsha newsha status\0path\0" records, then "\0", then the patch.
  const files: FileDiff[] = [];
  let pos = 0;
  while (data[pos] === ':') {
    const metaEnd = data.indexOf('\0', pos);
    const pathEnd = data.indexOf('\0', metaEnd + 1);
    const [oldMode, newMode, oldSha, newSha, status] = data.slice(pos + 1, metaEnd).split(' ');
    files.push({
      path: data.slice(metaEnd + 1, pathEnd),
      status: status[0] as FileDiff['status'],
      oldMode, newMode, oldSha, newSha,
      binary: false, partial: false, hunks: [], added: 0, removed: 0,
    });
    pos = pathEnd + 1;
  }
  if (data[pos] === '\0') pos++;
  const chunks = data.slice(pos).split(/\n(?=diff --git )/);

  // Patches come in the same order as the raw records; a type change produces two.
  let ci = 0;
  for (const f of files) {
    const mine = f.status === 'T' ? chunks.slice(ci, ci + 2) : chunks.slice(ci, ci + 1);
    ci += mine.length;
    let idx = 0;
    for (const chunk of mine) {
      const lines = chunk.split('\n');
      let hunk: Hunk | null = null;
      let o = 0;
      let n = 0;
      for (const l of lines) {
        const m = HUNK.exec(l);
        if (m) {
          hunk = { header: l, oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], lines: [] };
          o = +m[1];
          n = +m[3];
          f.hunks.push(hunk);
        } else if (!hunk) {
          if (l.startsWith('Binary files ')) f.binary = true;
        } else if (l[0] === '\\') {
          const last = hunk.lines[hunk.lines.length - 1];
          if (last) last.eof = true;
        } else if (l[0] === '+') {
          hunk.lines.push({ t: '+', s: l.slice(1), i: idx++, n: n++ });
          f.added++;
        } else if (l[0] === '-') {
          hunk.lines.push({ t: '-', s: l.slice(1), i: idx++, o: o++ });
          f.removed++;
        } else if (l[0] === ' ') {
          hunk.lines.push({ t: ' ', s: l.slice(1), o: o++, n: n++ });
        }
      }
    }
    f.partial = !f.binary && f.status !== 'T' && TEXT_MODES.has(f.oldMode) && TEXT_MODES.has(f.newMode);
  }
  return { sha, files };
}

/** Convert a byte-string diff to utf8 for display. */
export function displayDiff(d: CommitDiff): CommitDiff {
  return {
    sha: d.sha,
    files: d.files.map((f) => ({
      ...f,
      path: toUtf8(f.path),
      hunks: f.hunks.map((h) => ({
        ...h,
        header: toUtf8(h.header),
        lines: h.lines.map((l): DiffLine => ({ ...l, s: toUtf8(l.s) })),
      })),
    })),
  };
}

/**
 * Rebuild a file from its old content, applying only the changed lines for which
 * `apply(i)` is true: an applied '-' removes the line, an applied '+' inserts it.
 */
export function applyLines(old: string, hunks: Hunk[], apply: (i: number) => boolean): string {
  const oldLines = old.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const out: string[] = [];
  let cur = 0;
  for (const h of hunks) {
    const start = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    while (cur < start) out.push(oldLines[cur++]);
    for (const l of h.lines) {
      if (l.t === ' ') out.push(oldLines[cur++]);
      else if (l.t === '-') {
        if (apply(l.i!)) cur++;
        else out.push(oldLines[cur++]);
      } else if (apply(l.i!)) out.push(l.eof ? l.s : l.s + '\n');
    }
  }
  while (cur < oldLines.length) out.push(oldLines[cur++]);
  // A line that lost its "no newline at end of file" position gets its newline back.
  for (let k = 0; k < out.length - 1; k++) if (!out[k].endsWith('\n')) out[k] += '\n';
  return out.join('');
}
