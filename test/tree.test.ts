import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileTree, treeRows } from '../src/ui/lib/tree.ts';

const show = (rows: ReturnType<typeof treeRows>) =>
  rows.map((r) => '  '.repeat(r.depth) + (r.kind === 'dir' ? r.name + '/' : `${r.name} #${r.index}`));

test('folders keep the order of their files, and a lone subfolder merges into its parent', () => {
  const tree = fileTree(['README.md', 'src/ui/App.svelte', 'src/ui/lib/a.ts', 'src/ui/z.svelte', 'test/x.ts']);
  assert.deepEqual(show(treeRows(tree, {})), [
    'README.md #0',
    'src/ui/',
    '  App.svelte #1',
    '  lib/',
    '    a.ts #2',
    '  z.svelte #3',
    'test/',
    '  x.ts #4',
  ]);
});

test("a collapsed folder hides what's in it", () => {
  const tree = fileTree(['a/b/c.ts', 'a/d.ts', 'e.ts']);
  assert.deepEqual(show(treeRows(tree, { 'a/b': true })), ['a/', '  b/', '  d.ts #1', 'e.ts #2']);
  assert.deepEqual(show(treeRows(tree, { a: true })), ['a/', 'e.ts #2']);
});
