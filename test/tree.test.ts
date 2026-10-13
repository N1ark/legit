import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comparePaths } from '../src/shared/paths.ts';
import { fileTree, treeRows } from '../src/ui/lib/tree.ts';

const show = (rows: ReturnType<typeof treeRows>) =>
  rows.map((r) => '  '.repeat(r.depth) + (r.kind === 'dir' ? r.name + '/' : `${r.name} #${r.index}`));

test('folders come before files, sorted by name, and a lone subfolder merges into its parent', () => {
  const tree = fileTree(['README.md', 'src/ui/App.svelte', 'src/ui/lib/a.ts', 'src/ui/z.svelte', 'test/x.ts']);
  assert.deepEqual(show(treeRows(tree, {})), [
    'src/ui/',
    '  lib/',
    '    a.ts #2',
    '  App.svelte #1',
    '  z.svelte #3',
    'test/',
    '  x.ts #4',
    'README.md #0',
  ]);
});

test('names sort like Zed: a folder before one it prefixes, case-insensitive, numbers by value', () => {
  // git's order: '-' sorts before '/', and capitals before lower case.
  const paths = ['Soteria.md', 'soteria-rust/Zed.rs', 'soteria-rust/lib.rs', 'soteria/a10.ml', 'soteria/a9.ml'];
  assert.deepEqual(show(treeRows(fileTree(paths), {})), [
    'soteria/',
    '  a9.ml #4',
    '  a10.ml #3',
    'soteria-rust/',
    '  lib.rs #2',
    '  Zed.rs #1',
    'Soteria.md #0',
  ]);
  assert.deepEqual([...paths].sort(comparePaths), [
    'soteria/a9.ml',
    'soteria/a10.ml',
    'soteria-rust/lib.rs',
    'soteria-rust/Zed.rs',
    'Soteria.md',
  ]);
});

test("a collapsed folder hides what's in it", () => {
  const tree = fileTree(['a/b/c.ts', 'a/d.ts', 'e.ts']);
  assert.deepEqual(show(treeRows(tree, { 'a/b': true })), ['a/', '  b/', '  d.ts #1', 'e.ts #2']);
  assert.deepEqual(show(treeRows(tree, { a: true })), ['a/', 'e.ts #2']);
});
