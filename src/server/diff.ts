// Commit diffs: parsing git's patch output, and rebuilding files from a subset of changed lines.

import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONTEXT_LINES, expandable, moreAfter } from '../shared/context.ts';
import { comparePaths } from '../shared/paths.ts';
import type { CommitDiff, DiffLine, DiffSummary, FileDiff, FileLines, HunkData, Hunk } from '../shared/types.ts';
import { imageType } from '../shared/files.ts';
import { whitespacePairs } from '../shared/whitespace.ts';
import { type Git, GitError, toUtf8 } from './git.ts';

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const TEXT_MODES = new Set(['100644', '100755', '000000']);

/** Options shared by every diff we parse: raw records + patch, no renames, no external tools. */
export const DIFF_ARGS = ['-r', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--full-index', '--patch-with-raw', `-U${CONTEXT_LINES}`];
/** The same, with renamed files found (as `git diff` does): commits, squashes and what's staged. */
export const RENAME_ARGS = DIFF_ARGS.map((a) => (a === '--no-renames' ? '-M' : a));

/** Diff of a commit against its first parent. All strings are byte strings. */
export async function commitDiff(git: Git, sha: string): Promise<CommitDiff> {
  const c = await git.commit(sha);
  const { out } = await git.run(['diff-tree', ...RENAME_ARGS, c.parents[0] ?? git.emptyTree, sha]);
  return parseDiff(out.toString('latin1'), sha);
}

/**
 * Parse `--patch-with-raw -z` output. Each file gets a token (hash of its raw record and
 * patch), so a later request can check that the file is still exactly what was shown.
 */
export function parseDiff(data: string, sha: string): CommitDiff {
  // Raw section: ":oldmode newmode oldsha newsha status\0path\0" records (a rename or copy has
  // the old path, then the new one), then "\0", then the patch.
  const files: FileDiff[] = [];
  let pos = 0;
  while (data[pos] === ':') {
    const metaEnd = data.indexOf('\0', pos);
    let pathEnd = data.indexOf('\0', metaEnd + 1);
    const [oldMode, newMode, oldSha, newSha, status] = data.slice(pos + 1, metaEnd).split(' ');
    let path = data.slice(metaEnd + 1, pathEnd);
    let oldPath: string | undefined;
    if (status[0] === 'R' || status[0] === 'C') {
      oldPath = path;
      const end = data.indexOf('\0', pathEnd + 1);
      path = data.slice(pathEnd + 1, end);
      pathEnd = end;
    }
    files.push({
      path,
      status: status[0] as FileDiff['status'],
      ...(oldPath === undefined ? {} : { oldPath }),
      oldMode, newMode, oldSha, newSha,
      binary: false, partial: false, hunks: [], added: 0, removed: 0,
    });
    pos = pathEnd + 1;
  }
  if (data[pos] === '\0') pos++;
  // Each patch starts a line with "diff --git ": chunk k is data[starts[k], starts[k + 1] - 1), read in
  // place (no copy of the patch, nor an array of its lines, which for a huge commit is most of the work).
  const starts = [pos];
  for (let k = data.indexOf('\ndiff --git ', pos); k >= 0; k = data.indexOf('\ndiff --git ', k + 1)) starts.push(k + 1);
  starts.push(data.length + 1);
  const chunks = starts.length - 1;

  // Patches come in the same order as the raw records; a type change produces two.
  let ci = 0;
  for (const f of files) {
    // A working-tree file listed (stat-dirty) but no different has a record and no patch.
    const at = starts[ci];
    const begins = (s: string) => ci < chunks && s.length < starts[ci + 1] - at && data.startsWith(s, at);
    if (!begins('diff --git "') && !begins(`diff --git a/${f.oldPath ?? f.path} b/`)) {
      f.token = createHash('sha1').update(`${f.oldMode} ${f.newMode} ${f.oldSha} ${f.status}\0`).digest('hex');
      continue;
    }
    const upto = Math.min(ci + (f.status === 'T' ? 2 : 1), chunks);
    f.token = createHash('sha1').update(`${f.oldMode} ${f.newMode} ${f.oldSha} ${f.status} ${f.oldPath ?? ''}\0`).update(data.slice(at, starts[upto] - 1), 'latin1').digest('hex');
    let idx = 0;
    for (; ci < upto; ci++) {
      const stop = starts[ci + 1] - 1;
      let hunk: Hunk | null = null;
      let o = 0;
      let n = 0;
      for (let p = starts[ci]; p < stop; ) {
        let e = data.indexOf('\n', p);
        if (e < 0 || e > stop) e = stop;
        const c = data[p];
        const m = c === '@' ? HUNK.exec(data.slice(p, e)) : null;
        if (m) {
          hunk = { header: m.input, oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], lines: [] };
          o = +m[1];
          n = +m[3];
          f.hunks.push(hunk);
        } else if (!hunk) {
          if (e - p >= 13 && data.startsWith('Binary files ', p)) f.binary = true;
        } else if (c === '\\') {
          const last = hunk.lines[hunk.lines.length - 1];
          if (last) last.eof = true;
        } else if (c === '+') {
          hunk.lines.push({ t: '+', s: data.slice(p + 1, e), i: idx++, n: n++ });
          f.added++;
        } else if (c === '-') {
          hunk.lines.push({ t: '-', s: data.slice(p + 1, e), i: idx++, o: o++ });
          f.removed++;
        } else if (c === ' ') {
          hunk.lines.push({ t: ' ', s: data.slice(p + 1, e), o: o++, n: n++ });
        }
        p = e + 1;
      }
    }
    f.partial = !f.binary && f.status !== 'T' && TEXT_MODES.has(f.oldMode) && TEXT_MODES.has(f.newMode);
  }
  return { sha, files: sortFiles(files) };
}

/** Files in the order the file tree lists them (folders first, as in Zed). */
export const sortFiles = (files: FileDiff[]) => files.sort((a, b) => comparePaths(a.path, b.path));

/** File list with exact row counts and widths, but no content (utf8 for display). `syntax`: grammars by path. */
export function summarize(d: CommitDiff, generated: Set<string>, syntax = new Map<string, string>()): DiffSummary {
  return {
    sha: d.sha,
    files: d.files.map(({ hunks, ...f }) => {
      let rows = 0;
      let width = 0;
      let ws = 0;
      for (const h of hunks) {
        rows += h.lines.length + 1;
        ws += whitespacePairs(h.lines.map((l) => l.t).join(''), h.lines.map((l) => l.s), (k) => !!h.lines[k].eof).size;
        for (const l of h.lines) {
          let w = l.s.length;
          for (let k = l.s.indexOf('\t'); k >= 0; k = l.s.indexOf('\t', k + 1)) w += 3;
          if (w > width) width = w;
        }
      }
      if (hunks.length && expandable(f)) {
        const last = hunks[hunks.length - 1].lines;
        if (moreAfter(last.map((l) => l.t).join(''), !!last[last.length - 1]?.eof)) rows++;
      }
      const { token: _, ...rest } = f;
      const grammar = syntax.get(f.path);
      return { ...rest, path: toUtf8(f.path), ...(f.oldPath === undefined ? {} : { oldPath: toUtf8(f.oldPath) }), rows, width, ws, generated: generated.has(f.path), ...(grammar ? { syntax: grammar } : {}) };
    }),
  };
}

const absent = (sha: string) => !sha || /^0+$/.test(sha);
/** The file on disk, for a working-tree side (its byte-string path). */
const onDisk = (git: Git, path: string) => join(git.root, Buffer.from(path, 'latin1').toString('utf8'));

/** A file's bytes on one side of a diff: its blob, or the file on disk for working-tree changes; null where there's none. */
export async function fileBytes(git: Git, f: FileDiff, side: 'old' | 'new'): Promise<Buffer | null> {
  if (side === 'old' ? f.status === 'A' || absent(f.oldSha) : f.status === 'D') return null;
  const sha = side === 'old' ? f.oldSha : f.newSha;
  if (absent(sha)) return readFile(onDisk(git, f.path)).catch(() => null);
  return (await git.readObjects([sha])).get(sha)?.data ?? null;
}

/** Sizes in bytes of binary files and images, on each side that has one, by file index. */
export async function fileSizes(git: Git, d: CommitDiff): Promise<Map<number, { oldSize?: number; newSize?: number }>> {
  const out = new Map<number, { oldSize?: number; newSize?: number }>();
  const shas = new Set<string>();
  const want = d.files.flatMap((f, k) => (f.binary || imageType(f.path) ? [k] : []));
  for (const k of want) {
    const f = d.files[k];
    if (f.status !== 'A' && !absent(f.oldSha)) shas.add(f.oldSha);
    if (f.status !== 'D' && !absent(f.newSha)) shas.add(f.newSha);
  }
  const sizes = new Map<string, number>();
  if (shas.size) {
    const { out: res } = await git.run(['cat-file', '--batch-check=%(objectname) %(objectsize)'], { input: [...shas].join('\n') + '\n' });
    for (const l of res.toString('latin1').split('\n')) {
      const [sha, n] = l.split(' ');
      if (/^\d+$/.test(n ?? '')) sizes.set(sha, +n);
    }
  }
  for (const k of want) {
    const f = d.files[k];
    const s: { oldSize?: number; newSize?: number } = {};
    if (f.status !== 'A' && !absent(f.oldSha)) s.oldSize = sizes.get(f.oldSha);
    if (f.status !== 'D') {
      s.newSize = absent(f.newSha) ? await lstat(onDisk(git, f.path)).then((st) => st.size, () => undefined) : sizes.get(f.newSha);
    }
    out.set(k, s);
  }
  return out;
}

/** A modified file's old version (utf8 for display), for the lines between its hunks. */
export async function oldLines(git: Git, f: FileDiff): Promise<FileLines> {
  if (!expandable(f) || /^0+$/.test(f.oldSha)) throw new GitError("That file's other lines can't be shown.");
  const { out } = await git.run(['cat-file', 'blob', f.oldSha]);
  const lines = out.toString('utf8').split('\n');
  const noNewline = lines[lines.length - 1] !== '';
  if (!noNewline) lines.pop();
  return { lines, noNewline };
}

/** `toUtf8`, without its two copies for ASCII (most lines), which reads the same either way. */
const utf8 = (s: string) => (/^[\0-\x7f]*$/.test(s) ? s : toUtf8(s));

/** A file's hunks in compact form, utf8 for display. */
export function fileContent(f: FileDiff): HunkData[] {
  return f.hunks.map((h) => {
    let types = '';
    const text: string[] = [];
    const eof: number[] = [];
    h.lines.forEach((l, k) => {
      types += l.t;
      text.push(utf8(l.s));
      if (l.eof) eof.push(k);
    });
    return { header: utf8(h.header), oldStart: h.oldStart, newStart: h.newStart, types, text, eof };
  });
}

/**
 * Rebuild a file from its old content, applying only the changed lines for which
 * `apply(i)` is true: an applied '-' removes the line, an applied '+' inserts it.
 *
 * Within each run of changed lines, removed lines are paired with the added lines they were
 * edited into (by similarity), and a kept old line stays in its partner's place. So picking
 * just the new `"""doc"""` line out of `-return x` / `+"""doc"""` / `+return y` gives
 * `"""doc"""` then `return x`, not the other way round. Applying everything still gives the
 * new file, and applying nothing the old one.
 */
export function applyLines(old: string, hunks: Hunk[], apply: (i: number) => boolean): string {
  const oldLines = old.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const out: string[] = [];
  let cur = 0;
  const added = (l: DiffLine) => (l.eof ? l.s : l.s + '\n');
  for (const h of hunks) {
    const start = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    while (cur < start) out.push(oldLines[cur++]);
    for (let k = 0; k < h.lines.length; ) {
      if (h.lines[k].t === ' ') {
        out.push(oldLines[cur++]);
        k++;
        continue;
      }
      // A run of changes: its removed lines (old order) and added lines (new order).
      const dels: { l: DiffLine; text: string }[] = [];
      const adds: DiffLine[] = [];
      for (; k < h.lines.length && h.lines[k].t !== ' '; k++) {
        const l = h.lines[k];
        if (l.t === '-') dels.push({ l, text: oldLines[cur++] });
        else adds.push(l);
      }
      for (const slot of alignRun(dels.map((d) => d.l.s), adds.map((a) => a.s))) {
        const d = slot.del === undefined ? undefined : dels[slot.del];
        const a = slot.add === undefined ? undefined : adds[slot.add];
        const keepOld = d && !apply(d.l.i!);
        const addNew = a && apply(a.i!);
        if (keepOld) out.push(d.text);
        if (addNew) out.push(added(a));
      }
    }
  }
  while (cur < oldLines.length) out.push(oldLines[cur++]);
  // A line that lost its "no newline at end of file" position gets its newline back.
  for (let k = 0; k < out.length - 1; k++) if (!out[k].endsWith('\n')) out[k] += '\n';
  return out.join('');
}

/** Bigram (Dice) similarity of two lines, ignoring surrounding whitespace, in [0, 1]. */
function similarity(a: string, b: string): number {
  a = a.trim();
  b = b.trim();
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let common = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      grams.set(g, n - 1);
      common++;
    }
  }
  return (2 * common) / (a.length - 1 + b.length - 1);
}

/** Similar enough to count as the same line, edited. */
const PAIR = 0.5;
/** Runs bigger than this (removed × added) aren't paired, to stay fast. */
const MAX_PAIRING = 40_000;

/**
 * Order a run of removed and added lines into slots: pairs (a removed line and the line it
 * became) in a monotonic best-similarity alignment, and unpaired lines around them. Removed
 * lines stay in old order and added lines in new order.
 */
export function alignRun(dels: string[], adds: string[]): { del?: number; add?: number }[] {
  const m = dels.length;
  const n = adds.length;
  const pairs: [number, number][] = [];
  if (m && n && m * n <= MAX_PAIRING) {
    // score[i][j]: best total similarity aligning dels[i..] with adds[j..].
    const score = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));
    const sim = Array.from({ length: m }, (_, i) => Float64Array.from(adds, (a) => similarity(dels[i], a)));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        const pair = sim[i][j] >= PAIR ? sim[i][j] + score[i + 1][j + 1] : -1;
        score[i][j] = Math.max(pair, score[i + 1][j], score[i][j + 1]);
      }
    }
    for (let i = 0, j = 0; i < m && j < n; ) {
      if (sim[i][j] >= PAIR && score[i][j] === sim[i][j] + score[i + 1][j + 1]) pairs.push([i++, j++]);
      else if (score[i][j] === score[i + 1][j]) i++;
      else j++;
    }
  }
  const slots: { del?: number; add?: number }[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [m, n] as [number, number]]) {
    while (i < pi) slots.push({ del: i++ });
    while (j < pj) slots.push({ add: j++ });
    if (pi < m) slots.push({ del: i++, add: j++ });
  }
  return slots;
}
