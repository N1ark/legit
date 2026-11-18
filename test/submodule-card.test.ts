import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SubmoduleLog } from '../src/shared/types.ts';
import { SUB, asLaidOut, inert, logRows, logSummary, submoduleCard, submoduleHeight } from '../src/ui/lib/submodule.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const commit = (c: string, subject = c) => ({ sha: c.repeat(40), subject, author: 'Ann', time: 1 });
const log = (more: Partial<SubmoduleLog>): SubmoduleLog => ({ added: [], removed: [], more: { added: 0, removed: 0 }, ...more });

test("a submodule's card says where it moved, and only lists commits when it moved between two", () => {
  assert.equal(submoduleCard({ old: A, new: B }).change, 'aaaaaaa → bbbbbbb');
  assert.equal(submoduleCard({ old: A, new: B }).log, true);
  assert.equal(submoduleCard({ new: B }).change, 'added at bbbbbbb');
  assert.equal(submoduleCard({ old: A }).change, 'removed (was aaaaaaa)');
  assert.equal(submoduleCard({ old: A }).log, false);
  const dirty = submoduleCard({ old: A, new: A, dirty: { modified: true, untracked: true } }, 'Has changes inside it');
  assert.equal(dirty.change, 'at aaaaaaa');
  assert.equal(dirty.log, false);
  assert.deepEqual(dirty.badges.map((b) => b.label), ['modified content', 'untracked content']);
  assert.equal(submoduleCard({ new: B, nested: true, url: 'u' }).badges[0].label, 'nested repository');
  assert.equal(submoduleCard({ old: A, new: A, missing: true }).openable, false);
});

test("a card's height is fixed by what it shows, not by its commits", () => {
  const line = 2 * SUB.PAD + SUB.LINE;
  assert.equal(submoduleHeight(submoduleCard({ new: B })), line);
  assert.equal(submoduleHeight(submoduleCard({ old: A, new: A }, 'note')), line + SUB.NOTE);
  assert.equal(submoduleHeight(submoduleCard({ old: A, new: B })), line + SUB.ROWS * SUB.ROW + SUB.PAD);
});

test('a log reads as commits added, dropped, or both, with those left out counted', () => {
  assert.equal(logSummary(log({ added: [commit('1'), commit('2')] })), '2 new commits');
  assert.equal(logSummary(log({ removed: [commit('1')] })), 'went back 1 commit');
  assert.equal(logSummary(log({ added: [commit('1')], removed: [commit('2')], more: { added: 4, removed: 0 } })), '5 commits added, 1 commit dropped');
  assert.match(logSummary(log({ unavailable: 'missing-commit' })), /fetch it there/);
  assert.deepEqual(
    logRows(log({ added: [commit('1')], removed: [commit('2')], more: { added: 3, removed: 1 } })).map((r) => (r.kind === 'more' ? `${r.side}${r.n}` : r.kind + r.subject)),
    ['+1', '+3', '-2', '-1'],
  );
});

test('submodules lay out as cards (no rows), and other files stay as they are', () => {
  const f = { rows: 3, width: 50, ws: 0, paired: 1, pairedWs: 1, path: 'x' };
  const plain = [f];
  assert.equal(asLaidOut(plain), plain);
  const [s, o] = asLaidOut([{ ...f, submodule: { old: A, new: B } }, f]);
  assert.equal(s.rows, 0);
  assert.equal(s.width, 0);
  assert.equal(o, f);
  assert.equal(inert({ submodule: { old: A, new: A } }), true);
  assert.equal(inert({ submodule: { old: A, new: B } }), false);
  assert.equal(inert({ submodule: { new: B, nested: true }, untracked: true }), false);
  assert.equal(inert({}), false);
  // Staged at another commit than the one checked out: that can be unstaged.
  assert.equal(inert({ submodule: { old: A, new: A }, stage: 'some' }), false);
});
