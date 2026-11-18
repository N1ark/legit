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
