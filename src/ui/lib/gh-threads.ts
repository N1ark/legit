// Review threads on legit's diffs. GitHub places a thread on the pull request's diff at some
// commit, and legit rewrites commits all the time, so a thread is placed by what's known for sure
// when there is something (the commit it was made on is the one shown, or the diff shown ends at
// the pull request's head) and otherwise by the text of the line it's on, near where it was.

import type { DiffSide, ReviewThread } from '../../shared/gh-review.ts';

/** What placing needs of a file's rows (lib/rows.ts's FileRows). */
export interface RowsLike {
  kind: ArrayLike<number>;
  text: string[];
  o: ArrayLike<number>;
  n: ArrayLike<number>;
}

// lib/rows.ts's kinds, repeated so this stays a leaf.
const HUNK = 0;
const CONTEXT = 1;
const ADDED = 2;
const REMOVED = 3;
const TAIL = 4;
const SPACED = 5;
const isHead = (k: number) => k === HUNK || k === TAIL;

/** What a diff shows, as far as the pull request goes. */
export interface DiffContext {
  /** The one commit shown, or null for several. */
  sha: string | null;
  /** The new side is the pull request's head: threads' current lines are its lines. */
  head: boolean;
  /** The old side is the pull request's base: so are their removed lines. */
  base: boolean;
}

export interface HunkLine {
  kind: ' ' | '+' | '-';
  text: string;
}

/** A diff hunk's lines (headers and "\ No newline" notes left out). */
export function hunkLines(diffHunk: string): HunkLine[] {
  const out: HunkLine[] = [];
  for (const l of diffHunk.split('\n')) {
    const k = l[0];
    if (k === ' ' || k === '+' || k === '-') out.push({ kind: k, text: l.slice(1) });
    else if (l === '') out.push({ kind: ' ', text: '' });
  }
  // A blank context line loses its space in some copies; a trailing empty split isn't one.
  if (diffHunk.endsWith('\n')) out.pop();
  return out;
}

const strip = (s: string) => s.replace(/\r$/, '');
const sideOf = (k: ' ' | '+' | '-'): DiffSide => (k === '-' ? 'LEFT' : 'RIGHT');
const lineOn = (rows: RowsLike, r: number, side: DiffSide) => (side === 'LEFT' ? rows.o[r] : rows.n[r]);

/** Row r can show a line of this kind (a whitespace-only change shows both of its lines). */
function fits(rows: RowsLike, r: number, kind: ' ' | '+' | '-'): boolean {
  const k = rows.kind[r];
  if (kind === '+') return k === ADDED || k === SPACED;
  if (kind === '-') return k === REMOVED || k === SPACED;
  return k === CONTEXT;
}

/** The row showing `line` of `side`, or -1. */
export function rowOfLine(rows: RowsLike, side: DiffSide, line: number): number {
  for (let r = 0; r < rows.kind.length; r++) if (!isHead(rows.kind[r]) && lineOn(rows, r, side) === line) return r;
  return -1;
}

/** How many of the hunk's lines before its last match the rows before r (up to 3). */
function contextScore(rows: RowsLike, r: number, lines: HunkLine[]): number {
  let score = 0;
  for (let k = 1; k <= 3 && k < lines.length && r - k >= 0; k++) {
    if (isHead(rows.kind[r - k]) || strip(rows.text[r - k]) !== strip(lines[lines.length - 1 - k].text)) break;
    score++;
  }
  return score;
}

/** Lines further than this from where a thread was are only taken with some context agreeing. */
const NEAR = 100;

/** The row with the hunk's last line, found by its text near line `expect`; -1 when none is convincing. */
export function matchText(rows: RowsLike, lines: HunkLine[], expect: number | null): number {
  const last = lines[lines.length - 1];
  if (!last || last.kind === ' ') return -1;
  const side = sideOf(last.kind);
  const want = strip(last.text);
  let best = -1;
  let bestScore = -1;
  let bestDist = Infinity;
  for (let r = 0; r < rows.kind.length; r++) {
    if (!fits(rows, r, last.kind) || strip(rows.text[r]) !== want) continue;
    const score = contextScore(rows, r, lines);
    const dist = expect === null ? 0 : Math.abs(lineOn(rows, r, side) - expect);
    if (score > bestScore || (score === bestScore && dist < bestDist)) [best, bestScore, bestDist] = [r, score, dist];
  }
  if (best < 0) return -1;
  // A short line (`}`, `i++;`) or a far one says little on its own.
  const telling = want.trim().length >= 6 && bestDist <= NEAR;
  return bestScore > 0 || telling ? best : -1;
}

/** Row r's lines up to `count` rows above it, within its hunk: where a range that ends at r starts. */
function rangeStart(rows: RowsLike, r: number, count: number): number {
  let a = r;
  for (let k = 1; k < count && a > 0 && !isHead(rows.kind[a - 1]); k++) a--;
  return a;
}

export interface Placed {
  thread: ReviewThread;
  /** The row it's under (its last line), and its first line's. */
  row: number;
  start: number;
  /** Found by the text of its line rather than its number: the commit it was made on was rewritten. */
  moved: boolean;
}

/** Lines a thread spans, as GitHub counts them. */
const span = (start: number | null, end: number | null) => (start !== null && end !== null && end >= start ? end - start + 1 : 1);

/** The row of a range's first line, ending at row `end`; when that line isn't shown (folded
 *  away above the hunk), the hunk's first row after it, so what's shown of the range is marked. */
function startRow(rows: RowsLike, side: DiffSide, line: number, end: number): number {
  const s = rowOfLine(rows, side, line);
  if (s >= 0) return s <= end ? s : end;
  let r = end;
  while (r > 0 && !isHead(rows.kind[r - 1]) && (lineOn(rows, r - 1, side) || line) >= line) r--;
  return r;
}

/** Where a line thread goes in these rows, or null. */
export function placeThread(t: ReviewThread, rows: RowsLike, ctx: DiffContext): Placed | null {
  if (t.subject === 'FILE') return null;
  const first = t.comments[0];
  const lines = hunkLines(first?.diffHunk ?? '');
  const last = lines[lines.length - 1];
  const exact = (side: DiffSide, line: number, startSide: DiffSide | null, startLine: number | null, kind?: ' ' | '+' | '-') => {
    const row = rowOfLine(rows, side, line);
    if (row < 0 || (kind && !fits(rows, row, kind))) return null;
    return { thread: t, row, start: startLine !== null ? startRow(rows, startSide ?? side, startLine, row) : row, moved: false };
  };
  if (ctx.head && t.line !== null && (t.side === 'RIGHT' || ctx.base)) {
    const p = exact(t.side, t.line, t.startSide, t.startLine);
    if (p) return p;
  }
  if (ctx.sha && first?.originalCommit === ctx.sha && t.originalLine !== null) {
    // On the commit it was made on, unless that line is only context here and was a change there.
    const p = exact(t.side, t.originalLine, t.startSide, t.originalStartLine, last?.kind);
    if (p) return p;
  }
  if (!last || (ctx.head && t.outdated)) return null;
  const row = matchText(rows, lines, (ctx.head ? t.line : null) ?? t.originalLine);
  if (row < 0) return null;
  return { thread: t, row, start: rangeStart(rows, row, span(t.originalStartLine, t.originalLine)), moved: true };
}

/** A file's threads placed on its rows, and those of them that belong to this diff but have no line in it. */
export function placeThreads(threads: ReviewThread[], rows: RowsLike | null, ctx: DiffContext): { placed: Placed[]; elsewhere: ReviewThread[] } {
  const placed: Placed[] = [];
  const elsewhere: ReviewThread[] = [];
  for (const t of threads) {
    const p = rows ? placeThread(t, rows, ctx) : null;
    if (p) placed.push(p);
    else if (belongs(t, ctx)) elsewhere.push(t);
  }
  placed.sort((a, b) => a.row - b.row);
  return { placed, elsewhere };
}

/** A thread this diff should show even when it can't put it on a line: made on this commit, or on the PR's head. */
export function belongs(t: ReviewThread, ctx: DiffContext): boolean {
  return ctx.head || (!!ctx.sha && t.comments[0]?.originalCommit === ctx.sha);
}

/** Where a new comment on rows a..b goes on GitHub, or why it can't. */
export function commentTarget(
  rows: RowsLike,
  a: number,
  b: number,
  ctx: Pick<DiffContext, 'base'>,
): { line: number; side: DiffSide; startLine?: number; startSide?: DiffSide } | { error: string } {
  if (a > b) [a, b] = [b, a];
  for (let r = a; r <= b; r++) if (isHead(rows.kind[r])) return { error: 'Pick lines within one block of the diff.' };
  const at = (r: number) => (rows.kind[r] === REMOVED ? { side: 'LEFT' as const, line: rows.o[r] } : { side: 'RIGHT' as const, line: rows.n[r] });
  const end = at(b);
  const start = at(a);
  if (!ctx.base && (end.side === 'LEFT' || start.side === 'LEFT')) {
    return { error: "GitHub reads removed lines against the pull request's base, which isn't this commit's parent: comment on added or unchanged lines." };
  }
  return a === b ? end : { ...end, startLine: start.line, startSide: start.side };
}

/** The new text of rows a..b (what a suggestion replaces): its added and unchanged lines. */
export function newText(rows: RowsLike, a: number, b: number): string[] {
  const out: string[] = [];
  for (let r = Math.min(a, b); r <= Math.max(a, b); r++) if (!isHead(rows.kind[r]) && rows.kind[r] !== REMOVED) out.push(strip(rows.text[r]));
  return out;
}

/** The lines a right-side thread is on, from its hunk (what a suggestion in it replaces); null when that can't be told. */
export function commentedLines(t: ReviewThread): string[] | null {
  if (t.side !== 'RIGHT' || t.subject === 'FILE') return null;
  const want = span(t.originalStartLine, t.originalLine);
  const lines = hunkLines(t.comments[0]?.diffHunk ?? '').filter((l) => l.kind !== '-');
  if (lines.length < want) return null;
  return lines.slice(lines.length - want).map((l) => strip(l.text));
}

export type BodyPart = { md: string } | { suggestion: string[] };

/** A comment's markdown with its ```suggestion blocks taken out, in order. */
export function splitSuggestions(body: string): BodyPart[] {
  const out: BodyPart[] = [];
  const re = /^ {0,3}(`{3,}|~{3,})[ \t]*suggestion[ \t]*\r?\n([\s\S]*?)^ {0,3}\1[ \t]*(?:\r?\n|$)/gm;
  let from = 0;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m.index > from) out.push({ md: body.slice(from, m.index) });
    const code = m[2].replace(/\r?\n$/, '');
    out.push({ suggestion: code === '' && m[2] === '' ? [] : code.split(/\r?\n/) });
    from = re.lastIndex;
  }
  if (from < body.length) out.push({ md: body.slice(from) });
  return out.filter((p) => !('md' in p) || p.md.trim());
}

/** A ```suggestion block suggesting `lines`, for a composer. */
export function suggestionBlock(lines: string[]): string {
  const fence = lines.some((l) => /^ {0,3}```/.test(l)) ? '````' : '```';
  return `${fence}suggestion\n${lines.join('\n')}${lines.length ? '\n' : ''}${fence}`;
}

/** Unresolved first, then by path and line. */
export function threadOrder(a: ReviewThread, b: ReviewThread): number {
  return +a.resolved - +b.resolved || a.path.localeCompare(b.path) || (a.line ?? a.originalLine ?? 0) - (b.line ?? b.originalLine ?? 0);
}

/** "line 12" or "lines 12–15", where a thread is (or was). */
export function linesLabel(t: ReviewThread): string {
  if (t.subject === 'FILE') return 'the file';
  const end = t.line ?? t.originalLine;
  const start = t.line !== null ? t.startLine : t.originalStartLine;
  if (end === null) return '';
  return start !== null && start !== end ? `lines ${start}–${end}` : `line ${end}`;
}

/** Blocks under a file's rows (sorted by row), for the diff's layout. */
export interface BlockLayout<B> {
  /** The row each is under, in order, and their heights summed up to each (one more entry). */
  rows: number[];
  sum: number[];
  byRow: Map<number, B[]>;
  /** Rows some block is about. */
  on: Set<number>;
}

export function layOut<B extends { row: number; start: number }>(blocks: B[], height: (b: B) => number): BlockLayout<B> {
  const a: BlockLayout<B> = { rows: [], sum: [0], byRow: new Map(), on: new Set() };
  for (const b of blocks) {
    a.rows.push(b.row);
    a.sum.push(a.sum[a.sum.length - 1] + height(b));
    const list = a.byRow.get(b.row);
    if (list) list.push(b);
    else a.byRow.set(b.row, [b]);
    for (let r = b.start; r <= b.row; r++) a.on.add(r);
  }
  return a;
}

/** Height of the blocks under the rows before row r. */
export function heightAbove(a: BlockLayout<unknown>, r: number): number {
  let lo = 0;
  let hi = a.rows.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a.rows[m] < r) lo = m + 1;
    else hi = m;
  }
  return a.sum[lo];
}
