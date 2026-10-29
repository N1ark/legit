import assert from 'node:assert/strict';
import { test } from 'node:test';
import { numericColumns, parseDelimited } from '../src/ui/lib/csv.ts';

const rows = (text: string, d?: string) => parseDelimited(text, d).rows;

test('fields, quoted fields and escaped quotes', () => {
  assert.deepEqual(rows('a,b,c\n1,2,3'), [['a', 'b', 'c'], ['1', '2', '3']]);
  assert.deepEqual(rows('"a,b","say ""hi""",""\n'), [['a,b', 'say "hi"', '']]);
  assert.deepEqual(rows('"""",x'), [['"', 'x']]);
  assert.deepEqual(rows(',,\n'), [['', '', '']]);
  assert.deepEqual(rows('a,b,'), [['a', 'b', '']]);
});

test('newlines inside quotes, CRLF and the trailing newline', () => {
  const t = parseDelimited('name,note\r\n"Ann","two\r\nlines"\r\nBob,"x\ny\nz"\r\n');
  assert.deepEqual(t.rows, [['name', 'note'], ['Ann', 'two\r\nlines'], ['Bob', 'x\ny\nz']]);
  assert.deepEqual(t.lines, [[1, 1], [2, 3], [4, 6]]);
  assert.equal(t.total, 3);
  assert.deepEqual(rows('a\r\nb'), [['a'], ['b']]);
  assert.deepEqual(rows('a\rb\n'), [['a\rb']], 'a lone CR is text');
});

test('blank lines are skipped but still counted as lines; ragged rows keep their own length', () => {
  const t = parseDelimited('a,b\n\n1\n1,2,3\n\n\n');
  assert.deepEqual(t.rows, [['a', 'b'], ['1'], ['1', '2', '3']]);
  assert.deepEqual(t.lines, [[1, 1], [3, 3], [4, 4]]);
  assert.equal(t.columns, 3);
  assert.deepEqual(parseDelimited(''), { rows: [], index: [], lines: [], total: 0, columns: 0 });
  assert.deepEqual(t.index, [0, 1, 2]);
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
  const t = parseDelimited('h\n1\n"2\n2"\n3\n"4\n4"\n5', ',', 2);
  assert.deepEqual(t.rows, [['h'], ['1']]);
  assert.equal(t.total, 6);
  assert.equal(t.columns, 1);
});

test('later rows are kept too when their lines are wanted, up to the limit again', () => {
  const text = 'h\n1\n"2\n2"\n3,x\n"4\n4"\n5\n';
  const changed = new Set([4, 8]);
  const t = parseDelimited(text, ',', 2, (s, e) => [...changed].some((l) => l >= s && l <= e));
  assert.deepEqual(t.rows, [['h'], ['1'], ['2\n2'], ['5']]);
  assert.deepEqual(t.index, [0, 1, 2, 5]);
  assert.deepEqual(t.lines, [[1, 1], [2, 2], [3, 4], [8, 8]]);
  assert.equal(t.total, 6);
  const capped = parseDelimited(text, ',', 1, () => true);
  assert.deepEqual(capped.index, [0, 1], 'no more than the limit again');
});

test('numeric columns, ignoring the header and empty cells', () => {
  const t = parseDelimited('id,name,price,pct,mixed\n1,a,1.50,10%,1\n2,b,,-3e2%,x\n-3,c,"1,200",.5,2');
  assert.deepEqual(numericColumns(t.rows, t.columns + 1), [true, false, true, true, false, false]);
});

test('a 5 MB file parses quickly', () => {
  const line = '12345,"Some, quoted text",3.14159,plain text here,"multi\nline"\n';
  const text = line.repeat(Math.ceil((5 << 20) / line.length));
  const t0 = performance.now();
  const t = parseDelimited(text, ',', 1001);
  const ms = performance.now() - t0;
  assert.equal(t.total, Math.ceil((5 << 20) / line.length));
  assert.equal(t.rows.length, 1001);
  assert.deepEqual(t.lines[1000], [2001, 2002]);
  assert.ok(ms < 500, `took ${ms.toFixed(0)} ms`);
});
