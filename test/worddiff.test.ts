import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markSegments } from '../src/ui/lib/find.ts';
import { buildRows } from '../src/ui/lib/rows.ts';
import { changedSpans, cutWords, pairLines, tokenize, wordDiff } from '../src/ui/lib/worddiff.ts';

const pieces = (s: string, at: number[]) => Array.from({ length: at.length / 2 }, (_, k) => s.slice(at[2 * k], at[2 * k + 1]));

test('words: identifiers, whitespace runs and single punctuation', () => {
  assert.deepEqual(tokenize('  foo_1(bar, "été");'), ['  ', 'foo_1', '(', 'bar', ',', ' ', '"', 'été', '"', ')', ';']);
  assert.deepEqual(tokenize(''), []);
});

test('changed words: only what differs, joined across the spaces between', () => {
  const a = 'const reduced = sum - sum * discount;';
  const b = 'const reduced = sum - sum * Math.min(discount, 1);';
  const d = changedSpans(a, b)!;
  assert.deepEqual(d.a, []);
  assert.deepEqual(pieces(b, d.b), ['Math.min(', ', 1)']);
  const e = changedSpans('return { amount: total, currency: "EUR" };', 'return { amount: total, currency };')!;
  assert.deepEqual(pieces('return { amount: total, currency: "EUR" };', e.a), [': "EUR"']);
  assert.deepEqual(e.b, []);
  // Neighbouring words changed together read as one span, space included.
  const f = changedSpans('let x = old value here;', 'let x = new thing here;')!;
  assert.deepEqual(pieces('let x = new thing here;', f.b), ['new thing']);
});

test('changed words: none for lines too different, too long, or the same', () => {
  assert.equal(changedSpans('import { a } from "b";', 'export default class Foo extends Bar {}'), null);
  assert.equal(changedSpans('x'.repeat(2000), 'y' + 'x'.repeat(1999)), null);
  assert.equal(changedSpans('same', 'same'), null);
  // Indentation alone shows, unless whitespace is ignored.
  assert.deepEqual(changedSpans('  for (x) {', '    for (x) {')!.b, [0, 4]);
  assert.equal(changedSpans('a+b', 'a + b', true), null);
  assert.deepEqual(pieces('a + c', changedSpans('a+b', 'a + c', true)!.b), ['c']);
});

test('pairing lines: by similarity, in order, by position for big blocks of equal counts', () => {
  assert.deepEqual(pairLines(['for (const item of items) {', 'sum += item.price;'], ['if (items.length) {', 'for (const item of items) {', 'sum += item.price * 2;', '}']), [[0, 1], [1, 2]]);
  assert.deepEqual(pairLines(['alpha beta gamma'], ['totally unrelated text here']), []);
  const big = Array.from({ length: 30 }, (_, k) => `line ${k}`);
  assert.equal(pairLines(big, big).length, 30);
  assert.deepEqual(pairLines(big, big.slice(1)), []);
});

test('cutting runs at changed words keeps their highlighting, and find cuts them further', () => {
  const segs = [{ t: 'const ', c: 'kw' }, { t: 'x = 1', c: '' }];
  const cut = cutWords(segs, [4, 7, 10, 11]);
  assert.deepEqual(cut.map((s) => [s.t, s.c, s.w]), [['cons', 'kw', false], ['t ', 'kw', true], ['x', '', true], [' = ', '', false], ['1', '', true]]);
  const marked = markSegments(cut, [6], 3);
  assert.deepEqual(marked.map((s) => [s.t, s.w, s.m]), [['cons', false, 0], ['t ', true, 0], ['x', true, 1], [' =', false, 1], [' ', false, 0], ['1', true, 0]]);
});

test("a file's rows: each removed line compared with the added line it became", () => {
  const hunks = [{ header: '@@', oldStart: 1, newStart: 1, types: ' --++ -+', text: ['a', 'let total = 1;', 'zzz qqq', 'let total = 2;', 'other stuff', 'b', 'x = y', 'x = z'], eof: [] }];
  const rows = buildRows(hunks);
  const spans = wordDiff(rows);
  assert.equal(spans(1), null);
  assert.deepEqual(pieces(rows.text[2], spans(2)!), ['1']);
  assert.deepEqual(pieces(rows.text[4], spans(4)!), ['2']);
  assert.equal(spans(3), null);
  assert.equal(spans(5), null);
  assert.deepEqual(pieces(rows.text[8], spans(8)!), ['z']);
});
