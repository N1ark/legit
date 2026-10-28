import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aheadBehind, trackTip } from '../src/ui/lib/track.ts';

test("track: git's ahead/behind counts, and nothing for what isn't one", () => {
  assert.deepEqual(aheadBehind('ahead 2'), { ahead: 2, behind: 0 });
  assert.deepEqual(aheadBehind('behind 13'), { ahead: 0, behind: 13 });
  assert.deepEqual(aheadBehind('ahead 2, behind 1'), { ahead: 2, behind: 1 });
  for (const t of ['gone', '', 'ahead', 'ahead 2 behind 1', ', behind 1', 'ahead 2, ']) assert.equal(aheadBehind(t), null, t);
});

test('track: the counts in words', () => {
  assert.equal(trackTip('origin/x', 1, 0), "1 commit origin/x doesn't have");
  assert.equal(trackTip('main', 0, 3), "main has 3 commits this branch doesn't");
  assert.equal(trackTip('origin/x', 2, 1), "2 commits origin/x doesn't have; origin/x has 1 commit this branch doesn't");
});
