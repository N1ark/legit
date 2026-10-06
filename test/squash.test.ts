import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CommitInfo } from '../src/shared/types.ts';
import { squashDiffKey } from '../src/ui/lib/squash.ts';

test("a squash's diff key lists the selection's runs of consecutive commits, newest first", () => {
  const sha = (n: number) => String(n).repeat(40);
  const all = [1, 2, 3, 4, 5, 6].map((n) => ({ sha: sha(n) }) as CommitInfo);
  const pick = (...ns: number[]) => squashDiffKey(ns.map((n) => all[n - 1]), all);
  assert.equal(pick(2, 3, 4), `q${sha(2)}-${sha(4)}`);
  assert.equal(pick(1, 3, 4, 6), `q${sha(1)}.${sha(3)}-${sha(4)}.${sha(6)}`);
});
