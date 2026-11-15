// Keeping track during a review, the pure parts: CI annotations placed on a file's rows (new-side
// lines of the pull request's head), how a file's annotations add up, and how many files are viewed.

import type { RowsLike } from './gh-threads.ts';
import type { Annotation, AnnotationLevel, ViewedState } from '../../shared/gh-files.ts';

// lib/rows.ts's kinds, repeated so this stays a leaf.
const HUNK = 0;
const REMOVED = 3;
const TAIL = 4;

export interface PlacedNote {
  note: Annotation;
  /** The row it goes under (the last of its lines shown), and its first line's. */
  row: number;
  start: number;
}

/** A file's annotations on the rows showing their lines (a range partly folded away: on what's shown of it); and those with none. */
export function placeNotes(notes: Annotation[], rows: RowsLike): { placed: PlacedNote[]; elsewhere: Annotation[] } {
  const first = notes.map(() => -1);
  const last = notes.map(() => -1);
  for (let r = 0; r < rows.kind.length; r++) {
    const k = rows.kind[r];
    const n = rows.n[r];
    if (k === HUNK || k === TAIL || k === REMOVED || !n) continue;
    notes.forEach((a, j) => {
      if (n < a.startLine || n > a.endLine) return;
      if (first[j] < 0) first[j] = r;
      last[j] = r;
    });
  }
  const placed: PlacedNote[] = [];
  const elsewhere: Annotation[] = [];
  notes.forEach((note, j) => (last[j] < 0 ? elsewhere.push(note) : placed.push({ note, row: last[j], start: first[j] })));
  placed.sort((a, b) => a.row - b.row || RANK[b.note.level] - RANK[a.note.level]);
  return { placed, elsewhere };
}

const RANK: Record<AnnotationLevel, number> = { notice: 0, warning: 1, failure: 2 };

export interface NoteCounts {
  count: number;
  /** The most serious level among them. */
  level: AnnotationLevel;
  failure: number;
  warning: number;
  notice: number;
}

export function countNotes(notes: Annotation[]): NoteCounts | null {
  if (!notes.length) return null;
  const c: NoteCounts = { count: notes.length, level: 'notice', failure: 0, warning: 0, notice: 0 };
  for (const a of notes) {
    c[a.level]++;
    if (RANK[a.level] > RANK[c.level]) c.level = a.level;
  }
  return c;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "1 failure, 2 warnings". */
export function describeNotes(c: NoteCounts): string {
  return [c.failure && plural(c.failure, 'failure'), c.warning && plural(c.warning, 'warning'), c.notice && plural(c.notice, 'notice')].filter(Boolean).join(', ');
}

/** "line 12" or "lines 12–15". */
export const noteLines = (a: Annotation) => (a.endLine > a.startLine ? `lines ${a.startLine}–${a.endLine}` : `line ${a.startLine}`);

/** Of the files shown that are in the pull request, how many are marked viewed (a mark dismissed by a later change doesn't count). */
export function viewedCount(paths: string[], viewed: Record<string, ViewedState>): { viewed: number; total: number } {
  let n = 0;
  let total = 0;
  for (const p of paths) {
    const s = viewed[p];
    if (!s) continue;
    total++;
    if (s === 'VIEWED') n++;
  }
  return { viewed: n, total };
}
