import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CodeDiff,
  type DiffSpan,
  type Marks,
  alignRows,
  blockKey,
  diffInline,
  foldRanges,
  joinRanges,
  mergeBlock,
  pairRun,
} from '../src/ui/lib/md-align.ts';
import { type Token, type Tokens, lexDocument } from '../src/ui/lib/markdown.ts';
import { Ids, commonItems } from '../src/ui/lib/seqdiff.ts';

/** Reference LCS length, by dynamic programming. */
function lcs(a: number[], b: number[]): number {
  const w = b.length + 1;
  const t = new Int32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  return t[0];
}

function valid(a: ArrayLike<number>, b: ArrayLike<number>, pairs: [number, number][]) {
  for (let k = 0; k < pairs.length; k++) {
    const [i, j] = pairs[k];
    assert.equal(a[i], b[j]);
    if (k) assert.ok(i > pairs[k - 1][0] && j > pairs[k - 1][1], 'in order');
  }
}

test('common items are a longest common subsequence while the sequences are close', () => {
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let round = 0; round < 300; round++) {
    const a = Array.from({ length: rnd(40) }, () => rnd(6));
    const b = a.flatMap((x) => (rnd(5) === 0 ? [] : rnd(6) === 0 ? [x, rnd(6)] : [rnd(8) === 0 ? rnd(6) : x]));
    const pairs = commonItems(a, b);
    valid(a, b, pairs);
    assert.equal(pairs.length, lcs(a, b), `${a} / ${b}`);
  }
  assert.deepEqual(commonItems([], [1]), []);
  assert.deepEqual(commonItems([1, 2, 3], [1, 2, 3]), [
    [0, 0],
    [1, 1],
    [2, 2],
  ]);
});

test('far apart, big sequences are matched on what they share uniquely, quickly', () => {
  const n = 20_000;
  const a = Array.from({ length: n }, (_, k) => k);
  // Every third item replaced, and blocks moved about: Myers' search runs out, patience anchors.
  const b = a.map((x) => (x % 3 === 0 ? n + x : x));
  b.splice(5000, 0, ...b.splice(12_000, 300));
  const t0 = performance.now();
  const pairs = commonItems(a, b);
  const ms = performance.now() - t0;
  valid(a, b, pairs);
  assert.ok(pairs.length > (2 * n) / 3 - 400, `found ${pairs.length}`);
  assert.ok(ms < 100, `${ms} ms`);
  // Nothing in common at all.
  const c = Array.from({ length: n }, (_, k) => 2 * n + k);
  assert.deepEqual(commonItems(a, c), []);
});

test('ids intern strings', () => {
  const ids = new Ids();
  assert.equal(ids.of('a'), ids.of('a'));
  assert.notEqual(ids.of('a'), ids.of('b'));
});

test("a block's key leaves out the blank lines around it", () => {
  assert.equal(blockKey({ raw: '\n\nHello\nworld\n\n' }), 'Hello\nworld');
  assert.equal(blockKey({ raw: 'x' }), 'x');
});

test('rows: blocks kept, removed and added, the edited ones paired in order', () => {
  const kind = ['p', 'p', 'h', 'p'];
  const pair = (ra: number[], rb: number[]) =>
    pairRun(
      ra.length,
      rb.length,
      (x) => kind[ra[x] % 4],
      (y) => kind[rb[y] % 4],
      () => 1,
    );
  const rows = alignRows([0, 1, 2, 3], [0, 9, 3, 7], pair);
  assert.deepEqual(
    rows.map((r) => `${r.op}:${r.o}:${r.n}`),
    ['same:0:0', 'mod:1:1', 'del:2:-1', 'same:3:2', 'add:-1:3'],
  );
});

test('pairing: of a kind, alike enough, most alike overall; a lone pair however different', () => {
  const kinds = (s: string) => (x: number) => s[x];
  const sims: Record<string, number> = { '0,0': 0.2, '0,1': 0.9, '1,1': 0.5, '1,0': 0.6 };
  assert.deepEqual(pairRun(2, 2, kinds('pp'), kinds('pp'), (x, y) => sims[`${x},${y}`]), [[0, 1]]);
  assert.deepEqual(pairRun(2, 2, kinds('ph'), kinds('hp'), () => 1), [[1, 0]]);
  assert.deepEqual(pairRun(1, 1, kinds('p'), kinds('p'), () => 0), [[0, 0]]);
  assert.deepEqual(pairRun(1, 1, kinds('p'), kinds('h'), () => 1), []);
  assert.deepEqual(pairRun(1, 1, kinds(' '), kinds(' '), () => 1).length, 1);
  assert.deepEqual(pairRun(1, 1, () => '', () => '', () => 1), [], "'' never pairs");
});

const inline = (s: string) => (lexDocument(s)[0] as Tokens.Paragraph).tokens;

/** Inline tokens as text: [-removed-] and {+added+}, **strong**, _em_, `code`. */
function show(list: Token[]): string {
  return list
    .map((x) => {
      const t = x as Tokens.Generic;
      if (t.type === 'diff') return (t as DiffSpan).op === '-' ? `[-${show(t.tokens!)}-]` : `{+${show(t.tokens!)}+}`;
      if (t.type === 'strong') return `**${show(t.tokens!)}**`;
      if (t.type === 'em') return `_${show(t.tokens!)}_`;
      if (t.type === 'link') return `[${show(t.tokens!)}](${(t as Tokens.Link).href})`;
      if (t.type === 'codespan') return `\`${t.text}\``;
      if (t.type === 'checkbox') return (t as Tokens.Checkbox).checked ? '[x]' : '[ ]';
      if ('tokens' in t && t.tokens) return show(t.tokens);
      return t.text ?? t.raw;
    })
    .join('');
}

test('inline: words changed, as one change across the spaces between', () => {
  const d = diffInline(inline('the quick brown fox jumps'), inline('a slow brown fox jumps high'))!;
  assert.equal(show(d.tokens), '[-the quick-]{+a slow+} brown fox jumps {+high+}');
  assert.ok(d.changed);
  assert.ok(d.similarity > 0.5 && d.similarity < 1);
  const same = diffInline(inline('same *text*'), inline('same _text_'))!;
  assert.equal(same.changed, false, 'the same as shown');
  assert.equal(show(same.tokens), 'same _text_');
});

test('inline: formatting kept around what changed, and a change of formatting is a change', () => {
  assert.equal(show(diffInline(inline('a **bold word** here'), inline('a **bold term** here'))!.tokens), 'a **bold [-word-]{+term+}** here');
  assert.equal(show(diffInline(inline('make it bold'), inline('make it **bold**'))!.tokens), 'make it [-bold-]**{+bold+}**');
  assert.equal(show(diffInline(inline('see [docs](http://a.b)'), inline('see [docs](http://c.d)'))!.tokens), 'see [[-docs-]](http://a.b)[{+docs+}](http://c.d)');
  assert.equal(show(diffInline(inline('run `npm i` now'), inline('run `npm ci` now'))!.tokens), 'run [-`npm i`-]{+`npm ci`+} now');
  assert.equal(show(diffInline(inline('AT&amp;T rocks'), inline('AT&amp;T rules'))!.tokens), 'AT&T [-rocks-]{+rules+}');
});

const marks = (): Marks => ({ marks: new WeakMap(), alias: new Map() });
const block = (s: string) => lexDocument(s).find((t) => t.type !== 'space')!;

test('an edited paragraph is one block, marked edited; one rewritten is removed and added', () => {
  const m = marks();
  const [t] = mergeBlock(block('Hello there world'), block('Hello there, world'), m);
  assert.equal(show((t as Tokens.Paragraph).tokens), 'Hello there{+,+} world');
  assert.equal(m.marks.get(t)?.op, 'mod');
  const a = block('Completely different words here');
  const b = block('Nothing alike at all in this one');
  const out = mergeBlock(a, b, m);
  assert.deepEqual(out, [a, b]);
  assert.equal(m.marks.get(a)?.op, 'del');
  assert.equal(m.marks.get(b)?.op, 'add');
});

test('an edited heading keeps the new one as its anchor', () => {
  const m = marks();
  const b = block('## Getting started fast');
  const [t] = mergeBlock(block('## Getting started'), b, m);
  assert.equal(m.alias.get(t), b);
  assert.equal(show((t as Tokens.Heading).tokens), 'Getting started {+fast+}');
});

test('a list edited item by item: kept, removed, added, edited (a task ticked)', () => {
  const m = marks();
  const a = block('- one\n- two\n- [ ] three\n- four') as Tokens.List;
  const b = block('- one\n- [x] three\n- four, more\n- five') as Tokens.List;
  const [t] = mergeBlock(a, b, m) as [Tokens.List];
  const ops = t.items.map((it) => `${m.marks.get(it)?.op ?? 'same'}:${show(it.tokens)}`);
  assert.deepEqual(ops, ['same:one', 'del:two', 'mod:[-[ ]-]{+[x]+}three', 'mod:four{+, more+}', 'add:five']);
  assert.equal(m.marks.get(t)?.op, 'mod');
});

test('an ordered list numbers its items as each side does', () => {
  const m = marks();
  const [t] = mergeBlock(block('1. a\n2. b\n3. c'), block('1. a\n2. c'), m) as [Tokens.List];
  assert.deepEqual(
    t.items.map((it) => [m.marks.get(it)?.op, m.marks.get(it)?.num]),
    [
      ['same', 1],
      ['del', 2],
      ['same', 2],
    ],
  );
});

test('a nested list and a quote are merged within', () => {
  const m = marks();
  const [t] = mergeBlock(block('- a\n  - x\n  - y'), block('- a\n  - x\n  - y, z'), m) as [Tokens.List];
  const inner = t.items[0].tokens.find((x) => x.type === 'list') as Tokens.List;
  assert.equal(m.marks.get(inner)?.op, 'mod');
  assert.deepEqual(
    inner.items.map((it) => m.marks.get(it)?.op ?? 'same'),
    ['same', 'mod'],
  );
  const [q] = mergeBlock(block('> one\n>\n> two'), block('> one\n>\n> two, three'), m);
  assert.equal(m.marks.get(q)?.op, 'mod');
  assert.equal(show(((q as Tokens.Blockquote).tokens.at(-1) as Tokens.Paragraph).tokens), 'two{+, three+}');
});

test('a table edited row by row, cell by cell, its rows saying their lines', () => {
  const m = marks();
  const a = block('| a | b |\n|---|---|\n| 1 | one |\n| 2 | two |\n| 3 | three |') as Tokens.Table;
  const b = block('| a | b |\n|---|---|\n| 1 | one |\n| 3 | three, four |\n| 5 | five |') as Tokens.Table;
  const [t] = mergeBlock(a, b, m, { line: 10, old: 20 }) as [Tokens.Table];
  assert.equal(t.header, b.header, 'the same header');
  assert.deepEqual(
    t.rows.map((r) => {
      const k = m.marks.get(r)!;
      return `${k.op} ${k.line ?? '-'} ${k.old ?? '-'} ${r.map((c) => show(c.tokens)).join('|')}`;
    }),
    ['same 12 22 1|one', 'del - 23 2|two', 'mod 13 24 3|three{+, four+}', 'add 14 - 5|five'],
  );
  const [h] = mergeBlock(a, block('| a | c | d |\n|---|---|---|\n| 1 | one | x |\n| 2 | two | y |\n| 3 | three | z |'), m) as [Tokens.Table];
  assert.equal(h.header.map((c) => show(c.tokens)).join('|'), 'a|[-b-]{+c+}|{+d+}');
  assert.equal(m.marks.get(h.header)?.op, 'mod');
});

test('a code block edited line by line, each line saying its line on each side', () => {
  const m = marks();
  const a = block('```js\nconst a = 1;\nconst b = 2;\nlog(a);\n```');
  const b = block('```js\nconst a = 1;\nconst b = 3;\nlog(a);\nlog(b);\n```');
  const [t] = mergeBlock(a, b, m, { line: 5, old: 7 }) as [CodeDiff];
  assert.equal(t.text, 'const a = 1;\nconst b = 2;\nconst b = 3;\nlog(a);\nlog(b);');
  assert.equal(t.marks, ' -+ +');
  assert.deepEqual([...t.lines!], [6, 0, 7, 8, 9]);
  assert.deepEqual([...t.olds!], [8, 9, 0, 10, 0]);
  assert.equal(t.lang, 'js');
  const [u] = mergeBlock(block('    x\n    y'), block('    x\n    z'), m, { line: 1, old: 1 }) as [CodeDiff];
  assert.deepEqual([...u.lines!], [1, 0, 2], 'indented code starts on its first line');
});

test('blocks of other kinds edited are removed and added', () => {
  const m = marks();
  const a = block('<div>a</div>');
  const b = block('<div>b</div>');
  assert.deepEqual(mergeBlock(a, b, m), [a, b]);
});

test('folding: changed rows with context, the heading above, short gaps shown', () => {
  const changed = new Set([10, 11, 30]);
  const headings = new Set([2, 8, 20, 29]);
  const fold = (ctx = 2, min = 2) => foldRanges(40, (r) => changed.has(r), (r) => headings.has(r), ctx, min);
  assert.deepEqual(fold(), [
    [8, 14],
    [28, 33],
  ]);
  assert.deepEqual(fold(1), [
    [8, 13],
    [29, 32],
  ]);
  headings.delete(29);
  assert.deepEqual(fold(1), [
    [8, 13],
    [20, 21],
    [29, 32],
  ], 'the heading above, on its own');
  assert.deepEqual(fold(1, 10), [[8, 32]], 'gaps shorter than min shown');
  assert.deepEqual(foldRanges(5, () => false, () => true), [], 'nothing changed, nothing shown');
  assert.deepEqual(foldRanges(3, (r) => r === 0, () => false), [[0, 3]]);
});

test('ranges joined', () => {
  assert.deepEqual(
    joinRanges(
      [
        [0, 2],
        [10, 12],
      ],
      [
        [2, 4],
        [6, 7],
        [11, 15],
      ],
    ),
    [
      [0, 4],
      [6, 7],
      [10, 15],
    ],
  );
});
