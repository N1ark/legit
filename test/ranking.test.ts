import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ListRanker, type Scorer } from '../src/ui/lib/ranking.ts';

// A stand-in for purr's scoring (which needs Svelte to load): a substring scores by how early it starts,
// letters in order score lower; anything else misses.
let scored = 0;
let lettered = 0;
const scorer: Scorer = {
  score(q, t) {
    scored++;
    const hay = t.toLowerCase();
    const needle = q.toLowerCase();
    const at = hay.indexOf(needle);
    if (at >= 0) return 1000 - at;
    let j = 0;
    for (const ch of needle) if ((j = hay.indexOf(ch, j) + 1) === 0) return null;
    return 10;
  },
  indices(q, t) {
    lettered++;
    const at = t.toLowerCase().indexOf(q.toLowerCase());
    return at < 0 ? [] : Array.from(q, (_, k) => at + k);
  },
};

const names = ['main', 'feature/login', 'fix-main', 'release', 'origin-main', 'Mainline'];
const ranker = () => new ListRanker(names, (n) => n, scorer);
const order = (r: ListRanker<string>, q: string) => r.rank(q).map((h) => h.item);

test('best score first, ties and an empty query in list order', () => {
  const r = ranker();
  assert.deepEqual(order(r, ''), names);
  assert.deepEqual(order(r, '  MAIN '), ['main', 'Mainline', 'fix-main', 'origin-main']);
  assert.deepEqual(order(r, 'fl'), ['feature/login']);
  assert.deepEqual(order(r, 'zzz'), []);
});

test('typing on only scores what the shorter query matched; matched letters only as read', () => {
  const r = ranker();
  scored = lettered = 0;
  const hits = r.rank('m');
  assert.equal(scored, 4, 'only names holding an m are scored');
  assert.equal(lettered, 0);
  assert.deepEqual(hits[0].indices, [0]);
  assert.equal(lettered, 1);
  void hits[0].indices;
  assert.equal(lettered, 1, 'worked out once');
  scored = 0;
  assert.deepEqual(order(r, 'mai'), ['main', 'Mainline', 'fix-main', 'origin-main']);
  assert.equal(scored, 4);
  scored = 0;
  // Not an extension of the last query: the whole list again.
  assert.deepEqual(order(r, 're'), ['release', 'feature/login']);
  assert.deepEqual(order(r, 'rel'), ['release', 'feature/login']);
  assert.deepEqual(order(r, 'rele'), ['release']);
  assert.deepEqual(order(r, 'm'), ['main', 'Mainline', 'fix-main', 'origin-main']);
});
