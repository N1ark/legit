import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitTitle } from '../src/ui/lib/split.ts';

test("a split's default title is the original's, naming the picked files when there are few", () => {
  assert.equal(splitTitle('Tweak modules', ['src/a.ts']), 'Tweak modules (a.ts)');
  assert.equal(splitTitle('Tweak modules', ['src/a.ts', 'b.ts']), 'Tweak modules (a.ts, b.ts)');
  assert.equal(splitTitle('Tweak modules', ['a', 'b', 'c']), 'Tweak modules (split)');
  assert.equal(splitTitle('  ', ['x/a.ts']), 'Changes (a.ts)');
});
