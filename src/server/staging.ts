// What's staged, line by line, in a file's HEAD-to-working-tree diff, and the index that
// staging or unstaging some of those lines makes.
//
// The index is read against the diff's "positions": every line HEAD's version and the working
// tree's put out, in the order `applyLines` emits them. Some set of staged lines rebuilds the
// index from HEAD exactly when the index is a subsequence of those positions that keeps every
// unchanged line. Aligning the index with them (a line diff) says which: a removed line the
// index lacks is staged, an added line it has is staged. Index lines that align with nothing
// (a line edited again after it was staged, say) make a "mixed" region, which keeps its
// staged version until one of its lines is staged or unstaged, or the whole file is.

import type { DiffLine, Hunk } from '../shared/types.ts';
import { alignRun } from './diff.ts';

/** 0: unchanged, 1: removed, 2: added. */
type Kind = 0 | 1 | 2;

export interface Position {
  kind: Kind;
  text: string;
  /** Index among the file's changed lines, or -1. */
  ci: number;
  /** The run of consecutive changed lines it's in, or -1. */
  block: number;
}

const splitLines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Every line of `old` and the hunks' added lines, in the order `applyLines` emits them. */
export function positions(old: string, hunks: Hunk[]): Position[] {
  const oldLines = splitLines(old);
  const out: Position[] = [];
  let cur = 0;
  let block = 0;
  const ctx = () => out.push({ kind: 0, text: oldLines[cur++], ci: -1, block: -1 });
  for (const h of hunks) {
    const start = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    while (cur < start) ctx();
    for (let k = 0; k < h.lines.length; ) {
      if (h.lines[k].t === ' ') {
        ctx();
        k++;
        continue;
      }
      const dels: { l: DiffLine; text: string }[] = [];
      const adds: DiffLine[] = [];
      for (; k < h.lines.length && h.lines[k].t !== ' '; k++) {
        const l = h.lines[k];
        if (l.t === '-') dels.push({ l, text: oldLines[cur++] });
        else adds.push(l);
      }
      for (const slot of alignRun(dels.map((d) => d.l.s), adds.map((a) => a.s))) {
        if (slot.del !== undefined) out.push({ kind: 1, text: dels[slot.del].text, ci: dels[slot.del].l.i!, block });
        if (slot.add !== undefined) {
          const a = adds[slot.add];
          out.push({ kind: 2, text: a.eof ? a.s : a.s + '\n', ci: a.i!, block });
        }
      }
      block++;
    }
  }
  while (cur < oldLines.length) ctx();
  return out;
}

/** Shown in the file, with these lines staged. */
const shown = (p: Position, staged: (ci: number) => boolean) => p.kind === 0 || (p.kind === 1) !== staged(p.ci);

/** Lines joined as `applyLines` does: one that lost its end-of-file position gets its newline back. */
function join(lines: string[]): string {
  for (let k = 0; k < lines.length - 1; k++) if (!lines[k].endsWith('\n')) lines[k] += '\n';
  return lines.join('');
}

/** The file with these lines staged (the index it would make). */
export const emit = (pos: Position[], staged: (ci: number) => boolean) => join(pos.filter((p) => shown(p, staged)).map((p) => p.text));

/** A run of positions whose staged version can't be told as lines, and the index lines it has instead. */
export interface Region {
  /** Positions [from, to]. */
  from: number;
  to: number;
  /** Index lines [start, end). */
  start: number;
  end: number;
  /** Changed lines in it (none: the index changed lines HEAD and the working tree agree on). */
  lines: number[];
}

export interface Staging {
  /** Changed lines staged, outside regions. */
  staged: Set<number>;
  regions: Region[];
  /** The index differs in a way no line shows (only the newline at the end of the file). */
  other: boolean;
}

/** What's staged, given HEAD's version, the index's, and the HEAD-to-working-tree hunks. */
export function analyse(pos: Position[], index: string): Staging {
  const idx = splitLines(index);
  const strip = (s: string) => (s.endsWith('\n') ? s.slice(0, -1) : s);
  const match = lcs(pos.map((p) => strip(p.text)), idx.map(strip));
  // An unchanged line left out while an identical changed line next to it took its match: swap them.
  for (let c = 0; c < pos.length; c++) {
    if (pos[c].kind !== 0 || match[c] >= 0) continue;
    for (const dir of [-1, 1]) {
      let m = c + dir;
      while (m >= 0 && m < pos.length && match[m] < 0 && pos[m].kind !== 0) m += dir;
      if (m >= 0 && m < pos.length && pos[m].kind !== 0 && match[m] >= 0 && strip(pos[m].text) === strip(pos[c].text)) {
        match[c] = match[m];
        match[m] = -1;
        break;
      }
    }
  }
  const staged = new Set<number>();
  for (const [k, p] of pos.entries()) if (p.kind !== 0 && (p.kind === 2) === match[k] >= 0) staged.add(p.ci);

  // Unaligned unchanged lines and index lines, as position ranges between aligned positions.
  const raw: [number, number][] = [];
  let prev = -1;
  let prevIdx = -1;
  for (let k = 0; k <= pos.length; k++) {
    const j = k < pos.length ? match[k] : idx.length;
    if (k < pos.length && j < 0) {
      if (pos[k].kind === 0) raw.push([k, k]);
      continue;
    }
    // Index lines between two aligned positions: an insertion next to a changed line belongs to its block.
    if (j > prevIdx + 1) raw.push([prev >= 0 && pos[prev].block >= 0 ? prev : prev + 1, k < pos.length && pos[k].block >= 0 ? k : k - 1]);
    prev = k;
    prevIdx = j;
  }
  const blocks = new Map<number, [number, number]>();
  pos.forEach((p, k) => {
    if (p.block < 0) return;
    const b = blocks.get(p.block);
    if (b) b[1] = k;
    else blocks.set(p.block, [k, k]);
  });
  // Grow each to whole blocks, and merge those with no aligned position between them.
  const grown = raw.map(([a, b]) => {
    for (let changed = true; changed; ) {
      changed = false;
      for (const [x, y] of blocks.values()) {
        if (y >= a && x <= b && (x < a || y > b)) {
          [a, b] = [Math.min(a, x), Math.max(b, y)];
          changed = true;
        }
      }
    }
    return [a, b] as [number, number];
  });
  grown.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const r of grown) {
    const last = merged.at(-1);
    let between = false;
    if (last) for (let k = last[1] + 1; k < r[0] && !between; k++) between = match[k] >= 0;
    if (last && (r[0] <= last[1] + 1 || !between)) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  const regions = merged.map(([from, to]): Region => {
    let start = 0;
    for (let k = from - 1; k >= 0; k--) if (match[k] >= 0) { start = match[k] + 1; break; }
    let end = idx.length;
    for (let k = to + 1; k < pos.length; k++) if (match[k] >= 0) { end = match[k]; break; }
    const lines = pos.slice(from, to + 1).filter((p) => p.ci >= 0).map((p) => p.ci);
    return { from, to, start, end, lines };
  });
  for (const r of regions) for (const ci of r.lines) staged.delete(ci);
  const s: Staging = { staged, regions, other: false };
  s.other = !regions.length && emit(pos, (ci) => staged.has(ci)) !== index;
  return s;
}

/**
 * The index after staging (`on`) or unstaging `lines`. A region any of them is in takes `on`
 * for all its lines; the others keep the index's own version.
 */
export function restage(pos: Position[], index: string, s: Staging, lines: Iterable<number>, on: boolean): string {
  const picked = new Set(lines);
  const staged = new Set(s.staged);
  for (const ci of picked) on ? staged.add(ci) : staged.delete(ci);
  const kept = new Map<number, Region>();
  for (const r of s.regions) {
    if (r.lines.some((ci) => picked.has(ci))) for (const ci of r.lines) on ? staged.add(ci) : staged.delete(ci);
    else kept.set(r.from, r);
  }
  const idx = splitLines(index);
  const out: string[] = [];
  for (let k = 0; k <= pos.length; k++) {
    const r = kept.get(k);
    if (r) {
      out.push(...idx.slice(r.start, r.end));
      // An empty region is index lines inserted before position k, which still comes.
      if (r.to >= k) {
        k = r.to;
        continue;
      }
    }
    if (k < pos.length && shown(pos[k], (ci) => staged.has(ci))) out.push(pos[k].text);
  }
  return join(out);
}

/**
 * Which of `a` is matched to which of `b` (or -1) in a longest common subsequence: Myers'
 * O((n+m)·d) diff, after trimming what they start and end with.
 */
export function lcs(a: string[], b: string[]): number[] {
  const match = new Array<number>(a.length).fill(-1);
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) match[lo] = lo++;
  let ha = a.length;
  let hb = b.length;
  while (ha > lo && hb > lo && a[ha - 1] === b[hb - 1]) match[--ha] = --hb;
  const n = ha - lo;
  const m = hb - lo;
  if (!n || !m) return match;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[lo + x] === b[lo + y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // Walk back through the saved frontiers, recording the diagonal (matching) moves.
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const t = trace[d];
    const k = x - y;
    const pk = k === -d || (k !== d && t[off + k - 1] < t[off + k + 1]) ? k + 1 : k - 1;
    const px = t[off + pk];
    const py = px - pk;
    while (x > px && y > py) match[lo + --x] = lo + --y;
    if (d > 0) [x, y] = [px, py];
  }
  return match;
}
