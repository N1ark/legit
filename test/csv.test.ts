import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexDelimited, laterRows, numericColumns } from '../src/ui/lib/csv.ts';

const rows = (text: string, d?: string) => indexDelimited(text, d).rows;

test('fields, quoted fields and escaped quotes', () => {
  assert.deepEqual(rows('a,b,c\n1,2,3'), [['a', 'b', 'c'], ['1', '2', '3']]);
  assert.deepEqual(rows('"a,b","say ""hi""",""\n'), [['a,b', 'say "hi"', '']]);
  assert.deepEqual(rows('"""",x'), [['"', 'x']]);
  assert.deepEqual(rows(',,\n'), [['', '', '']]);
  assert.deepEqual(rows('a,b,'), [['a', 'b', '']]);
});

test('newlines inside quotes, CRLF and the trailing newline', () => {
  const t = indexDelimited('name,note\r\n"Ann","two\r\nlines"\r\nBob,"x\ny\nz"\r\n');
  assert.deepEqual(t.rows, [['name', 'note'], ['Ann', 'two\r\nlines'], ['Bob', 'x\ny\nz']]);
  assert.deepEqual(t.lines, [[1, 1], [2, 3], [4, 6]]);
  assert.equal(t.total, 3);
  assert.deepEqual(rows('a\r\nb'), [['a'], ['b']]);
  assert.deepEqual(rows('a\rb\n'), [['a\rb']], 'a lone CR is text');
});

test('blank lines are skipped but still counted as lines; ragged rows keep their own length', () => {
  const t = indexDelimited('a,b\n\n1\n1,2,3\n\n\n');
  assert.deepEqual(t.rows, [['a', 'b'], ['1'], ['1', '2', '3']]);
  assert.deepEqual(t.lines, [[1, 1], [3, 3], [4, 4]]);
  assert.equal(t.columns, 3);
  assert.deepEqual(indexDelimited(''), { rows: [], lines: [], total: 0, columns: 0, marks: [] });
  assert.deepEqual(rows('﻿a,b'), [['a', 'b']], 'a byte order mark is dropped');
});

test('lenient with what RFC 4180 forbids', () => {
  assert.deepEqual(rows('a"b,c'), [['a"b', 'c']], 'a quote inside an unquoted field');
  assert.deepEqual(rows('"a"b,c'), [['ab', 'c']], 'text after the closing quote');
  assert.deepEqual(rows('"open,\nnever closed'), [['open,\nnever closed']], 'an unclosed quote runs to the end');
});

test('TSV', () => {
  assert.deepEqual(rows('a\tb\n"x\ty"\t2\n', '\t'), [['a', 'b'], ['x\ty', '2']]);
  assert.deepEqual(rows('a,b\tc', '\t'), [['a,b', 'c']]);
});

test('only the first rows are kept; the rest are counted, quoted newlines included', () => {
  const t = indexDelimited('h\n1\n"2\n2"\n3\n"4\n4"\n5', ',', 2);
  assert.deepEqual(t.rows, [['h'], ['1']]);
  assert.equal(t.total, 6);
  assert.equal(t.columns, 1);
  assert.deepEqual(t.marks, [2, 4, 3], 'the first row past them is marked');
});

test('later rows holding wanted lines, read from the marks', () => {
  const text = 'h\n1\n"2\n2"\n3,x\n\n"4\n4"\n5\n';
  const t = indexDelimited(text, ',', 2);
  const later = laterRows(text, t, ',', [1, 4, 6, 9], 10);
  const want = { rows: [['2\n2'], ['5']], index: [2, 5], lines: [[3, 4], [9, 9]] };
  assert.deepEqual(later, want, 'not the kept rows, nor a blank line');
  assert.deepEqual(laterRows(text, t, ',', [3, 4, 5, 7, 8, 9], 2).index, [2, 3], 'no more than asked for');
  assert.deepEqual(laterRows(text, t, ',', [10, 11], 5).index, [], 'past the end');
});

test('later rows are those a full read finds, whatever the text', () => {
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
  const bits = ['a', 'bc', ',', ',', '"', '""', '\n', '\n', '\r\n', '\r', '\t', 'x y'];
  for (let round = 0; round < 300; round++) {
    let text = '';
    for (let k = rand(round % 10 ? 400 : 6000); k > 0; k--) text += bits[rand(bits.length)];
    const d = rand(4) ? ',' : '\t';
    const all = indexDelimited(text, d);
    const limit = rand(6);
    const t = indexDelimited(text, d, limit);
    assert.equal(t.total, all.total);
    assert.deepEqual(t.rows, all.rows.slice(0, limit));
    const lines = all.lines.at(-1)?.[1] ?? 1;
    const wanted = [...new Set(Array.from({ length: rand(40) }, () => 1 + rand(lines + 1)))].sort((a, b) => a - b);
    const max = 1 + rand(10);
    const want: number[] = [];
    for (let k = limit; k < all.rows.length && want.length < max; k++) {
      if (wanted.some((l) => l >= all.lines[k][0] && l <= all.lines[k][1])) want.push(k);
    }
    const later = laterRows(text, t, d, wanted, max);
    assert.deepEqual(later.index, want, JSON.stringify({ text, d, limit, wanted }));
    assert.deepEqual(later.rows, want.map((k) => all.rows[k]));
    assert.deepEqual(later.lines, want.map((k) => all.lines[k]));
  }
});

test('numeric columns, ignoring the header and empty cells', () => {
  const t = indexDelimited('id,name,price,pct,mixed\n1,a,1.50,10%,1\n2,b,,-3e2%,x\n-3,c,"1,200",.5,2');
  assert.deepEqual(numericColumns(t.rows, t.columns + 1), [true, false, true, true, false, false]);
});

test('a 5 MB file parses quickly, and its later rows read quickly', () => {
  const line = '12345,"Some, quoted text",3.14159,plain text here,"multi\nline"\n';
  const text = line.repeat(Math.ceil((5 << 20) / line.length));
  const t0 = performance.now();
  const t = indexDelimited(text, ',', 1001);
  const ms = performance.now() - t0;
  assert.equal(t.total, Math.ceil((5 << 20) / line.length));
  assert.equal(t.rows.length, 1001);
  assert.deepEqual(t.lines[1000], [2001, 2002]);
  assert.ok(ms < 500, `took ${ms.toFixed(0)} ms`);
  const wanted = Array.from({ length: 100 }, (_, k) => 2003 + k * 1500);
  const t1 = performance.now();
  const later = laterRows(text, t, ',', wanted, 100);
  const ms1 = performance.now() - t1;
  assert.equal(later.rows.length, 100);
  assert.deepEqual(later.index.slice(0, 2), [1001, 1751]);
  assert.ok(ms1 < 20, `took ${ms1.toFixed(1)} ms`);
});
