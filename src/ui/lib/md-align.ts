// A markdown file's two versions lined up block by block, as GitHub's rich diff shows them: blocks in
// common are kept, the others removed or added, and a removed and an added block of a kind that read
// alike are paired, one block edited. An edited block shows once, with what changed in it marked the same
// way: a paragraph's words, a list's items, a table's rows and their cells, a code block's lines. Tokens
// in, tokens out (never HTML): md-diff.ts builds and marks them.

import type { Alert, Token, Tokens } from './markdown.ts';
import { Ids, commonItems } from './seqdiff.ts';
import { overlap, tokenize } from './worddiff.ts';

export type Op = 'same' | 'add' | 'del' | 'mod';

/** A row of two sequences lined up: item `o` of the old one and `n` of the new (-1 where that side has none). */
export interface Row {
  op: Op;
  o: number;
  n: number;
}

/** What a diff says of a block, list item or table row; with, where it's known, the line it starts at on each side. */
export interface Mark {
  op: Op;
  line?: number;
  old?: number;
  /** An ordered list's item: its number. */
  num?: number;
}

/** Inline tokens a diff removed (`-`) or added (`+`). */
export interface DiffSpan {
  type: 'diff';
  raw: string;
  op: '+' | '-';
  tokens: Token[];
}

/** A code block's lines, from both versions: each line's mark ('+', '-' or ' '), and for a top-level block the line it is on each side (0: none). */
export interface CodeDiff extends Tokens.Code {
  marks: string;
  lines?: Int32Array;
  olds?: Int32Array;
}

/** The first and last lines of a top-level block, on each side. */
export interface At {
  line: number;
  old: number;
}

/** Below this share of their words in common, two blocks of a kind aren't paired (unless they're all there is). */
const MIN_SIMILARITY = 0.4;
/** Below this share of their text in common, an edited paragraph shows as removed and added rather than word by word. */
const SPLIT = 0.25;
/** Stretches of more removed × added items than this pair by position. */
const MAX_CELLS = 1600;
/** Only this much of a block's text is read to tell how alike it is to another. */
const SIMILAR_TEXT = 4000;
/** Inline content of more words than this is compared as a whole. */
const MAX_ATOMS = 3000;

/** A block's text as compared, without the blank lines around it. */
export function blockKey(t: { raw: string }): string {
  const r = t.raw;
  let s = 0;
  let e = r.length;
  while (s < e && r.charCodeAt(s) === 10) s++;
  while (e > s && (r.charCodeAt(e - 1) === 10 || r.charCodeAt(e - 1) === 32)) e--;
  return s === 0 && e === r.length ? r : r.slice(s, e);
}

/** Which blocks can be one edited into the other: the same kind (a quote, the same kind of alert); '' for none. */
export function blockKind(t: Token): string {
  switch (t.type) {
    case 'paragraph':
    case 'text':
      return 'p';
    case 'blockquote':
      return `quote:${(t as Alert).alert ?? ''}`;
    case 'heading':
    case 'code':
    case 'list':
    case 'table':
      return t.type;
    default:
      return '';
  }
}

/** Blocks that render nothing, left out of a diff. */
export const invisible = (t: Token) => t.type === 'space' || t.type === 'def';

const words = new WeakMap<object, string[]>();
const wordsOf = (t: { raw: string }) => {
  let w = words.get(t);
  if (!w) words.set(t, (w = tokenize(t.raw.length > SIMILAR_TEXT ? t.raw.slice(0, SIMILAR_TEXT) : t.raw)));
  return w;
};

/** How alike two blocks read: the share of their words in common. */
export const similarity = (a: { raw: string }, b: { raw: string }) => overlap(wordsOf(a), wordsOf(b));

/**
 * Pairs [x, y] of `m` removed items and `n` added ones (by place among them) that were edited into each
 * other, in order: of a kind (`kind`, '' never pairs) and alike (`sim`), the most alike overall; a lone
 * removed and added item of a kind pair however different. A stretch too long to compare pairs by place.
 */
export function pairRun(m: number, n: number, kindA: (x: number) => string, kindB: (y: number) => string, sim: (x: number, y: number) => number): [number, number][] {
  const same = (x: number, y: number) => {
    const k = kindA(x);
    return k !== '' && k === kindB(y);
  };
  if (!m || !n) return [];
  if (m === 1 && n === 1) return same(0, 0) ? [[0, 0]] : [];
  const out: [number, number][] = [];
  if (m * n > MAX_CELLS) {
    for (let k = 0; k < Math.min(m, n); k++) if (same(k, k)) out.push([k, k]);
    return out;
  }
  const s = new Float64Array(m * n);
  const w = n + 1;
  const best = new Float64Array((m + 1) * w);
  for (let x = m - 1; x >= 0; x--) {
    for (let y = n - 1; y >= 0; y--) {
      const v = same(x, y) ? sim(x, y) : 0;
      s[x * n + y] = v >= MIN_SIMILARITY ? v : 0;
      const pair = s[x * n + y] ? s[x * n + y] + best[(x + 1) * w + y + 1] : 0;
      best[x * w + y] = Math.max(pair, best[(x + 1) * w + y], best[x * w + y + 1]);
    }
  }
  for (let x = 0, y = 0; x < m && y < n; ) {
    if (s[x * n + y] && best[x * w + y] === s[x * n + y] + best[(x + 1) * w + y + 1]) out.push([x++, y++]);
    else if (best[(x + 1) * w + y] >= best[x * w + y + 1]) x++;
    else y++;
  }
  return out;
}

/** Pairs a stretch of removed items `ra` and added `rb` (their indices) edited into each other, as `pairRun` does. */
export type Pairer = (ra: number[], rb: number[]) => [number, number][];

/**
 * Rows lining up sequences `a` and `b` (ids: equal for equal content), into `out`: items in common
 * `same`; between them the removed ones, then the added, but a pair `pair` makes is one `mod` row, in
 * order on both sides. Yields after each stretch of changes, so the caller can stop between them.
 */
export function* alignSteps(a: ArrayLike<number>, b: ArrayLike<number>, pair: Pairer, out: Row[] = []): Generator<void, Row[]> {
  const common = commonItems(a, b);
  let i = 0;
  let j = 0;
  for (let c = 0; c <= common.length; c++) {
    const [ci, cj] = c < common.length ? common[c] : [a.length, b.length];
    if (i < ci || j < cj) {
      const ra = Array.from({ length: ci - i }, (_, k) => i + k);
      const rb = Array.from({ length: cj - j }, (_, k) => j + k);
      let x = 0;
      let y = 0;
      for (const [px, py] of ra.length && rb.length ? pair(ra, rb) : []) {
        while (x < px) out.push({ op: 'del', o: ra[x++], n: -1 });
        while (y < py) out.push({ op: 'add', o: -1, n: rb[y++] });
        out.push({ op: 'mod', o: ra[x++], n: rb[y++] });
      }
      while (x < ra.length) out.push({ op: 'del', o: ra[x++], n: -1 });
      while (y < rb.length) out.push({ op: 'add', o: -1, n: rb[y++] });
      yield;
    }
    if (c < common.length) out.push({ op: 'same', o: ci, n: cj });
    i = ci + 1;
    j = cj + 1;
  }
  return out;
}

/** `alignSteps`, all at once. */
export function alignRows(a: ArrayLike<number>, b: ArrayLike<number>, pair: Pairer): Row[] {
  const steps = alignSteps(a, b, pair);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** Rows lining up blocks (or list items) `a` and `b` by their text, pairing those of a kind that read alike. */
function alignTokens<T extends { raw: string }>(a: readonly T[], b: readonly T[], kind: (t: T) => string, key: (t: T) => string = blockKey): Row[] {
  const ids = new Ids();
  return alignRows(
    a.map((t) => ids.of(key(t))),
    b.map((t) => ids.of(key(t))),
    (ra, rb) =>
      pairRun(
        ra.length,
        rb.length,
        (x) => kind(a[ra[x]]),
        (y) => kind(b[rb[y]]),
        (x, y) => similarity(a[ra[x]], b[rb[y]]),
      ),
  );
}

// ---- Inline: words ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
const decode = (s: string) => (s.includes('&') ? s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENTITIES[e]) : s);
const SPACE = /^\s+$/;

/** A word (or space, or punctuation), image, code span... of inline content, under the formatting it's in. */
interface Atom {
  key: string;
  leaf: Token;
  /** The formatting it's in, outermost first, and what each level is (`strong`, `link:href`...). */
  path: Token[];
  sigs: string[];
  space: boolean;
  /** Its non-space length. */
  size: number;
}

function atoms(list: readonly Token[], path: Token[] = [], sigs: string[] = [], out: Atom[] = []): Atom[] {
  const sig = sigs.length ? sigs[sigs.length - 1] : '';
  const push = (key: string, leaf: Token, space: boolean, size: number) => out.push({ key: `${sig}\u0001${key}`, leaf, path, sigs, space, size });
  for (const t of list) {
    switch (t.type) {
      case 'text':
      case 'escape':
        if (t.type === 'text' && 'tokens' in t && t.tokens?.length) atoms(t.tokens, path, sigs, out);
        else
          for (const w of tokenize(t.type === 'text' ? decode(t.text) : t.text)) {
            const space = SPACE.test(w);
            push(`w${w}`, { type: 'escape', raw: w, text: w }, space, space ? 0 : w.length);
          }
        break;
      case 'strong':
      case 'em':
      case 'del':
      case 'link': {
        const level = t.type === 'link' ? `${sig}>link:${(t as Tokens.Link).href}` : `${sig}>${t.type}`;
        atoms(t.tokens ?? [], [...path, t], [...sigs, level], out);
        break;
      }
      case 'codespan':
        push(`c${t.text}`, t, false, Math.max(1, t.text.length));
        break;
      case 'image':
        push(`i${(t as Tokens.Image).href}\u0000${(t as Tokens.Image).text}`, t, false, 1);
        break;
      case 'checkbox':
        push(`x${(t as Tokens.Checkbox).checked}`, t, false, 1);
        break;
      default:
        push(`${t.type}\u0000${t.raw}`, t, false, 1);
    }
  }
  return out;
}

interface Piece {
  op: ' ' | '-' | '+';
  atom: Atom;
}

/** Inline tokens `b` with what changed from `a` marked (`DiffSpan`s), whether anything did, and how alike they are; null when too long to compare. */
export function diffInline(a: readonly Token[], b: readonly Token[]): { tokens: Token[]; changed: boolean; similarity: number } | null {
  const xa = atoms(a);
  const xb = atoms(b);
  if (xa.length > MAX_ATOMS || xb.length > MAX_ATOMS) return null;
  const ids = new Ids();
  const common = commonItems(
    xa.map((x) => ids.of(x.key)),
    xb.map((x) => ids.of(x.key)),
  );
  // Stretches of words changed and in common, in turn.
  const segs: { same: boolean; a: Atom[]; b: Atom[] }[] = [];
  const put = (same: boolean, a: Atom[], b: Atom[]) => {
    const last = segs[segs.length - 1];
    if (last?.same === same) {
      last.a.push(...a);
      last.b.push(...b);
    } else segs.push({ same, a, b });
  };
  let i = 0;
  let j = 0;
  let same = 0;
  for (let c = 0; c <= common.length; c++) {
    const [ci, cj] = c < common.length ? common[c] : [xa.length, xb.length];
    if (i < ci || j < cj) put(false, xa.slice(i, ci), xb.slice(j, cj));
    if (c < common.length) {
      put(true, [xa[ci]], [xb[cj]]);
      same += xb[cj].size;
    }
    i = ci + 1;
    j = cj + 1;
  }
  let total = 0;
  for (const x of xa) total += x.size;
  for (const x of xb) total += x.size;
  // Spaces in common between two edits are part of one: "the quick fox" → "a slow fox" reads as one change, not two.
  const edit = (s: { same: boolean; a: Atom[]; b: Atom[] } | undefined) => !!s && !s.same && s.a.length > 0 && s.b.length > 0;
  const pieces: Piece[] = [];
  const run: [Atom[], Atom[]] = [[], []];
  // A change's spaces at either end show as they are, unmarked: only words are (whitespace collapses, so none show twice).
  const flush = () => {
    for (const [list, op] of [
      [run[0], '-'],
      [run[1], '+'],
    ] as const) {
      let s = 0;
      let e = list.length;
      while (s < e && list[s].space) s++;
      while (e > s && list[e - 1].space) e--;
      list.forEach((x, k) => pieces.push({ op: k < s || k >= e ? ' ' : op, atom: x }));
    }
    run[0] = [];
    run[1] = [];
  };
  segs.forEach((s, k) => {
    if (!s.same || (edit(segs[k - 1]) && edit(segs[k + 1]) && s.b.every((x) => x.space))) {
      run[0].push(...s.a);
      run[1].push(...s.b);
      return;
    }
    flush();
    for (const x of s.b) pieces.push({ op: ' ', atom: x });
  });
  flush();
  return { tokens: rebuild(pieces), changed: pieces.some((p) => p.op !== ' '), similarity: total ? (2 * same) / total : 1 };
}

/** Pieces as inline tokens again: formatting rebuilt around them, each run of removed or added ones in a `DiffSpan`, innermost. */
function rebuild(pieces: Piece[]): Token[] {
  const root: Token[] = [];
  const open: { sig: string; tokens: Token[] }[] = [];
  for (const { op, atom } of pieces) {
    const want = op === ' ' ? atom.sigs : [...atom.sigs, op];
    let d = 0;
    while (d < open.length && d < want.length && open[d].sig === want[d]) d++;
    open.length = d;
    for (; d < want.length; d++) {
      const into = d ? open[d - 1].tokens : root;
      const node: Token = d < atom.path.length ? { ...atom.path[d], tokens: [] } : ({ type: 'diff', raw: '', op: op as DiffSpan['op'], tokens: [] } satisfies DiffSpan);
      into.push(node);
      open.push({ sig: want[d], tokens: node.tokens! });
    }
    (open.length ? open[open.length - 1].tokens : root).push(atom.leaf);
  }
  return root;
}

const span = (op: '+' | '-', tokens: Token[]): DiffSpan => ({ type: 'diff', raw: '', op, tokens });

// ---- Blocks ----------------------------------------------------------------------------------

/** Where a diff's marks go (by block, list item, table row: the objects built from), and which merged
 *  block stands for which of the new version's (a heading's anchor is the new one's). */
export interface Marks {
  marks: WeakMap<object, Mark>;
  alias: Map<Token, Token>;
}

/** A token's own tokens, if it has any. */
const inner = (t: Token): Token[] => ('tokens' in t && t.tokens) || [];

const mark = (m: Marks, t: object, op: Op, extra?: Omit<Mark, 'op'>) => m.marks.set(t, { op, ...extra });

/** `a` removed and `b` added, as two blocks. */
function split(a: Token, b: Token, m: Marks): Token[] {
  mark(m, a, 'del');
  mark(m, b, 'add');
  return [a, b];
}

/**
 * Block `a`, edited into `b` (of a kind: `blockKind`), as one block showing what changed (marked `mod`,
 * unless nothing that shows did); as `[a, b]`, removed and added, when they're too different for that. `at`:
 * where a top-level block starts on each side, so its table rows and code lines say their lines.
 */
export function mergeBlock(a: Token, b: Token, m: Marks, at?: At): Token[] {
  switch (b.type) {
    case 'paragraph':
    case 'text':
    case 'heading': {
      const d = diffInline(inner(a), inner(b));
      if (!d || (d.similarity < SPLIT && d.changed)) return split(a, b, m);
      const t = { ...b, tokens: d.tokens } as Token;
      m.alias.set(t, b);
      if (d.changed || a.type !== b.type || (a as Tokens.Heading).depth !== (b as Tokens.Heading).depth) mark(m, t, 'mod');
      return [t];
    }
    case 'code':
      return [mergeCode(a as Tokens.Code, b as Tokens.Code, m, at)];
    case 'list':
      return [mergeList(a as Tokens.List, b as Tokens.List, m)];
    case 'blockquote': {
      const t = { ...b, tokens: mergeChildren(inner(a), inner(b), m) } as Token;
      mark(m, t, 'mod');
      return [t];
    }
    case 'table':
      return [mergeTable(a as Tokens.Table, b as Tokens.Table, m, at)];
    default:
      return split(a, b, m);
  }
}

/** Whether a code block's code starts on the line after its first (a fence's, front matter's), not on it (indented code). */
const fenced = (t: Tokens.Code) => !/^\n*( {4}|\t)/.test(t.raw);

function mergeCode(a: Tokens.Code, b: Tokens.Code, m: Marks, at?: At): CodeDiff {
  const la = a.text.split('\n');
  const lb = b.text.split('\n');
  const ids = new Ids();
  const common = commonItems(
    la.map((l) => ids.of(l)),
    lb.map((l) => ids.of(l)),
  );
  const text: string[] = [];
  let marks = '';
  const lines: number[] = [];
  const olds: number[] = [];
  const first = at ? at.line + (fenced(b) ? 1 : 0) : 0;
  const firstOld = at ? at.old + (fenced(a) ? 1 : 0) : 0;
  let i = 0;
  let j = 0;
  for (let c = 0; c <= common.length; c++) {
    const [ci, cj] = c < common.length ? common[c] : [la.length, lb.length];
    for (; i < ci; i++) {
      text.push(la[i]);
      marks += '-';
      lines.push(0);
      olds.push(at ? firstOld + i : 0);
    }
    for (; j < cj; j++) {
      text.push(lb[j]);
      marks += '+';
      lines.push(at ? first + j : 0);
      olds.push(0);
    }
    if (c < common.length) {
      text.push(lb[cj]);
      marks += ' ';
      lines.push(at ? first + cj : 0);
      olds.push(at ? firstOld + ci : 0);
    }
    i = ci + 1;
    j = cj + 1;
  }
  const t: CodeDiff = { ...b, text: text.join('\n'), marks };
  if (at) Object.assign(t, { lines: Int32Array.from(lines), olds: Int32Array.from(olds) });
  m.alias.set(t, b);
  mark(m, t, 'mod');
  return t;
}

/** A list item's content, not its marker: renumbered, it's the same item. */
const itemKey = (t: Tokens.ListItem) => `${t.task ? (t.checked ? 'x' : 'o') : ''}\u0001${t.text.trim()}`;

function mergeList(a: Tokens.List, b: Tokens.List, m: Marks): Tokens.List {
  const items: Tokens.ListItem[] = [];
  const startA = a.start === '' ? 1 : Number(a.start);
  const startB = b.start === '' ? 1 : Number(b.start);
  const num = (n: number, start: number) => (b.ordered ? { num: start + n } : undefined);
  for (const r of alignTokens(a.items, b.items, () => 'li', itemKey)) {
    if (r.op === 'same') {
      items.push(b.items[r.n]);
      if (b.ordered) mark(m, b.items[r.n], 'same', num(r.n, startB));
    } else if (r.op === 'add') {
      items.push(b.items[r.n]);
      mark(m, b.items[r.n], 'add', num(r.n, startB));
    } else if (r.op === 'del') {
      items.push(a.items[r.o]);
      mark(m, a.items[r.o], 'del', num(r.o, startA));
    } else {
      const x = a.items[r.o];
      const y = b.items[r.n];
      const item: Tokens.ListItem = { ...y, tokens: mergeChildren(x.tokens, y.tokens, m) };
      items.push(item);
      mark(m, item, 'mod', num(r.n, startB));
    }
  }
  const t = { ...b, items };
  mark(m, t, 'mod');
  return t;
}

/** A list item's (or quote's) blocks: its text and task box (shown inline) count as one. */
interface Unit {
  raw: string;
  tokens: Token[];
  inline: boolean;
}

function units(list: readonly Token[]): Unit[] {
  const out: Unit[] = [];
  for (const t of list) {
    if (invisible(t)) continue;
    const inline = t.type === 'text' || t.type === 'checkbox';
    const last = out[out.length - 1];
    if (inline && last?.inline) {
      last.raw += t.raw;
      last.tokens.push(t);
    } else out.push({ raw: t.raw, tokens: [t], inline });
  }
  return out;
}

const unitKind = (u: Unit) => (u.inline ? 'p' : blockKind(u.tokens[0]));
/** A unit's inline tokens: its text's (and box), or a paragraph's. */
const inlineOf = (u: Unit): Token[] => (u.inline ? u.tokens : inner(u.tokens[0]));
const inlineText = (tokens: Token[]): Token => ({ type: 'text', raw: '', text: '', tokens });

/** Blocks `a` edited into blocks `b` (a list item's, a quote's), each marked as `mergeBlock` does. */
export function mergeChildren(a: readonly Token[], b: readonly Token[], m: Marks): Token[] {
  const ua = units(a);
  const ub = units(b);
  const out: Token[] = [];
  for (const r of alignTokens(ua, ub, unitKind)) {
    if (r.op === 'same') out.push(...ub[r.n].tokens);
    else if (r.op === 'add' || r.op === 'del') {
      const u = r.op === 'add' ? ub[r.n] : ua[r.o];
      if (u.inline) out.push(inlineText([span(r.op === 'add' ? '+' : '-', u.tokens)]));
      else {
        mark(m, u.tokens[0], r.op);
        out.push(u.tokens[0]);
      }
    } else {
      const x = ua[r.o];
      const y = ub[r.n];
      if (x.inline || y.inline) {
        const d = diffInline(inlineOf(x), inlineOf(y));
        const tokens = d ? d.tokens : [span('-', inlineOf(x)), span('+', inlineOf(y))];
        if (y.inline) out.push(inlineText(tokens));
        else {
          const t = { ...y.tokens[0], tokens } as Token;
          m.alias.set(t, y.tokens[0]);
          if (!d || d.changed) mark(m, t, 'mod');
          out.push(t);
        }
      } else out.push(...mergeBlock(x.tokens[0], y.tokens[0], m));
    }
  }
  return out;
}

const rowText = (row: Tokens.TableCell[]) => row.map((c) => c.text).join('\u0001');

function mergeTable(a: Tokens.Table, b: Tokens.Table, m: Marks, at?: At): Tokens.Table {
  let header = b.header;
  if (rowText(a.header) !== rowText(b.header)) {
    header = mergeCells(a.header, b.header, b);
    mark(m, header, 'mod');
  }
  const rows: Tokens.TableCell[][] = [];
  const lines = (r: { o: number; n: number }) =>
    at ? { ...(r.n >= 0 && { line: at.line + 2 + r.n }), ...(r.o >= 0 && { old: at.old + 2 + r.o }) } : undefined;
  const ra = a.rows.map((row) => ({ raw: rowText(row), row }));
  const rb = b.rows.map((row) => ({ raw: rowText(row), row }));
  for (const r of alignTokens(ra, rb, () => 'tr', (x) => x.raw)) {
    const row = r.op === 'del' ? a.rows[r.o] : r.op === 'mod' ? mergeCells(a.rows[r.o], b.rows[r.n], b) : b.rows[r.n];
    rows.push(row);
    if (r.op !== 'same' || at) mark(m, row, r.op, lines(r));
  }
  const t = { ...b, header, rows };
  mark(m, t, 'mod');
  return t;
}

/** Row `a`'s cells edited into `b`'s, column by column, as cells of table `table`. */
function mergeCells(a: Tokens.TableCell[], b: Tokens.TableCell[], table: Tokens.Table): Tokens.TableCell[] {
  const out: Tokens.TableCell[] = [];
  for (let c = 0; c < Math.max(a.length, b.length); c++) {
    const x = a[c];
    const y = b[c];
    if (!y) out.push({ ...x, align: table.align[c] ?? null, tokens: [span('-', x.tokens)] });
    else if (!x) out.push({ ...y, tokens: [span('+', y.tokens)] });
    else if (x.text === y.text) out.push(y);
    else {
      const d = diffInline(x.tokens, y.tokens);
      out.push({ ...y, tokens: d ? d.tokens : [span('-', x.tokens), span('+', y.tokens)] });
    }
  }
  return out;
}

// ---- Folding ---------------------------------------------------------------------------------

/**
 * The rows of `count` to show, as [from, to) ranges in order: each changed row with `context` rows either
 * side, and the nearest heading above them; a stretch of fewer than `min` rows between two is shown too.
 */
export function foldRanges(count: number, changed: (r: number) => boolean, heading: (r: number) => boolean, context = 2, min = 2): [number, number][] {
  const out: [number, number][] = [];
  const add = (from: number, to: number) => {
    const last = out[out.length - 1];
    if (last && from - last[1] < min) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  };
  let above = -1;
  for (let r = 0; r < count; r++) {
    if (!changed(r)) {
      if (heading(r)) above = r;
      continue;
    }
    const from = Math.max(0, r - context);
    let to = r + 1;
    while (to < count && changed(to)) to++;
    for (let h = from; h < r; h++) if (heading(h)) above = h;
    if (above >= 0 && above < from) add(above, above + 1);
    add(from, Math.min(count, to + context));
    for (let h = r; h < to; h++) if (heading(h)) above = h;
    r = to - 1;
  }
  return out;
}

/** Ranges `a` and `b` together, in order, those that meet or overlap joined. */
export function joinRanges(a: readonly [number, number][], b: readonly [number, number][]): [number, number][] {
  const all = [...a, ...b].filter(([f, t]) => f < t).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [f, t] of all) {
    const last = out[out.length - 1];
    if (last && f <= last[1]) last[1] = Math.max(last[1], t);
    else out.push([f, t]);
  }
  return out;
}
