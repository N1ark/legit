import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Lru } from '../src/ui/lib/cache.ts';

test('the cache forgets the least recently used entries past its size', () => {
  const c = new Lru<string, number>(3);
  for (const k of ['a', 'b', 'c']) c.set(k, 1);
  assert.equal(c.get('a'), 1);
  c.set('d', 1);
  assert.deepEqual(['a', 'b', 'c', 'd'].map((k) => c.has(k)), [true, false, true, true]);
  assert.equal(c.size, 3);
});

test('the cache forgets the oldest entries past its weight, but keeps the newest however heavy', () => {
  const c = new Lru<string, string>(100, 10);
  c.set('a', 'a', 4);
  c.set('b', 'b', 4);
  c.set('c', 'c', 4);
  assert.deepEqual([c.has('a'), c.has('b'), c.has('c'), c.weight], [false, true, true, 8]);
  c.set('huge', 'huge', 50);
  assert.deepEqual([c.size, c.weight, c.get('huge')], [1, 50, 'huge']);
  c.set('b', 'b', 2);
  assert.deepEqual([c.has('huge'), c.weight], [false, 2]);
});

test('a weight known later counts, and a value replaced meanwhile is left alone', () => {
  const c = new Lru<string, string>(100, 10);
  c.set('a', 'old');
  c.set('b', 'b', 5);
  c.set('a', 'new');
  c.weigh('a', 'old', 100);
  c.delete('a', 'old');
  assert.deepEqual([c.get('a'), c.weight], ['new', 6]);
  c.weigh('a', 'new', 8);
  assert.deepEqual([c.has('b'), c.weight], [false, 8]);
  c.delete('a');
  assert.deepEqual([c.size, c.weight], [0, 0]);
});
