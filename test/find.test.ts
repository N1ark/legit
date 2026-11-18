import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findAll, markSegments, matchesIn } from '../src/ui/lib/find.ts';

test('find: smart case, no overlaps', () => {
  assert.deepEqual(matchesIn('Foo foo FOO', 'foo'), [0, 4, 8]);
  assert.deepEqual(matchesIn('Foo foo FOO', 'Foo'), [0]);
  assert.deepEqual(matchesIn('aaaa', 'aa'), [0, 2]);
  assert.deepEqual(matchesIn('abc', ''), []);
});

test('find: segments cut at matches, across highlighting', () => {
  const segs = [{ t: 'const ', c: 'kw' }, { t: 'foo = foo', c: '' }];
  const out = markSegments(segs, matchesIn('const foo = foo', 'st f'), 4, 3);
  assert.deepEqual(out, [
    { t: 'con', c: 'kw', m: 0 },
    { t: 'st ', c: 'kw', m: 2 },
    { t: 'f', c: '', m: 2 },
    { t: 'oo = foo', c: '', m: 0 },
  ]);
  const two = markSegments([{ t: 'foo = foo', c: '' }], [0, 6], 3);
  assert.deepEqual(two.map((s) => [s.t, s.m]), [['foo', 1], [' = ', 0], ['foo', 1]]);
});

test('find: every file, rows skipped, and a longer query only where the shorter one matched', () => {
  const files = [['@@ head foo', 'Foo bar', 'baz'], null, ['food foo', 'nothing']];
  const lines = (i: number) => files[i];
  const skip = (i: number, r: number) => r === 0 && i === 0;
  const all = findAll('foo', 3, lines, skip);
  assert.deepEqual(all, [
    { i: 0, r: 1, start: 0 },
    { i: 2, r: 0, start: 0 },
    { i: 2, r: 0, start: 5 },
  ]);
  assert.deepEqual(findAll('food', 3, lines, skip, all), [{ i: 2, r: 0, start: 0 }]);
  assert.deepEqual(findAll('foo', 3, lines, skip, findAll('fo', 3, lines, skip)), all);
  assert.deepEqual(findAll('Foo', 3, lines, skip, findAll('f', 3, lines, skip)), [{ i: 0, r: 1, start: 0 }]);
  assert.deepEqual(findAll('', 3, lines, skip), []);
});

test('find: matches are where they are in the line, even after a letter whose lowercase is longer (İ)', () => {
  assert.deepEqual(matchesIn('İx foo', 'foo'), [3]);
  assert.deepEqual(findAll('foo', 1, () => ['İİ foo'], () => false), [{ i: 0, r: 0, start: 3 }]);
  assert.deepEqual(matchesIn('İstanbul', 'stan'), [1]);
});
