import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markSegments, matchesIn } from '../src/ui/lib/find.ts';

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
