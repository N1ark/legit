import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type TitleFile, commitTitle } from '../src/ui/lib/title.ts';

const f = (path: string, status: TitleFile['status'] = 'M', more: Partial<TitleFile> = {}): TitleFile => ({ path, status, ...more });

test("a commit's default title says what was done to which files", () => {
  assert.equal(commitTitle([]), '');
  assert.equal(commitTitle([f('src/auth.ts')]), 'Update auth.ts');
  assert.equal(commitTitle([f('a.ts', 'A'), f('src/b.ts', 'M', { untracked: true })]), 'Add a.ts and b.ts');
  assert.equal(commitTitle([f('a.ts', 'D'), f('b.ts', 'M')]), 'Update a.ts and b.ts');
  assert.equal(commitTitle([f('old.ts', 'D')]), 'Delete old.ts');
  assert.equal(commitTitle([f('src/new.ts', 'R', { oldPath: 'src/old.ts' })]), 'Rename old.ts to new.ts');
  assert.equal(commitTitle([f('lib/new.ts', 'R', { oldPath: 'src/old.ts' })]), 'Rename src/old.ts to lib/new.ts');
});

test('many files are counted, in the folder they share', () => {
  assert.equal(commitTitle([f('src/ui/a.ts'), f('src/ui/b.ts'), f('src/ui/c/d.ts')]), 'Update 3 files in src/ui');
  assert.equal(commitTitle([f('src/ui/a.ts'), f('src/lib/b.ts'), f('src/c.ts')]), 'Update 3 files in src');
  assert.equal(commitTitle([f('a.ts', 'A'), f('src/b.ts', 'A'), f('c.ts', 'A')]), 'Add 3 files');
  assert.equal(commitTitle([f('x/index.ts'), f('y/index.ts')]), 'Update 2 files');
});
