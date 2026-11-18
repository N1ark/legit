import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Repo } from '../src/server/repo.ts';
import { setup } from './util.ts';

const t = setup();

test('trimming keeps only the diffs used last, the one on screen among them', async () => {
  const shas = Array.from({ length: 30 }, (_, k) => t.commit(`c${k}`, { f: `${k}\n` }));
  const repo = await Repo.open(t.dir);
  const diffs = new Map<string, unknown>();
  for (const s of shas) diffs.set(s, await repo.diff(s));
  // Looked at last: the oldest commit, the one shown.
  await repo.diff(shas[0]);
  repo.trim();
  assert.equal(await repo.diff(shas[0]), diffs.get(shas[0]));
  assert.equal(await repo.diff(shas.at(-1)!), diffs.get(shas.at(-1)!));
  // The least recently used went, and is worked out again when asked for.
  const again = await repo.diff(shas[1]);
  assert.notEqual(again, diffs.get(shas[1]));
  assert.deepEqual(again.files.map((f) => f.path), ['f']);
});

test('trimming keeps the newest working-tree snapshots, the others then out of date', async () => {
  t.commit('one', { f: '1\n' });
  const repo = await Repo.open(t.dir);
  const keys: string[] = [];
  for (let k = 0; k < 6; k++) {
    t.write('f', `1\n${k}\n`);
    keys.push((await repo.work()).sha);
  }
  assert.equal(new Set(keys).size, 6);
  repo.trim();
  for (const k of keys.slice(2)) assert.equal((await repo.diff(k)).sha, k);
  for (const k of keys.slice(0, 2)) await assert.rejects(repo.diff(k), /out of date/);
  // The same changes read again get the newest's key.
  assert.equal((await repo.work()).sha, keys.at(-1));
});
