import assert from 'node:assert/strict';
import { matchesGlob } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_HIDDEN, globMatcher, normalize } from '../src/server/generated.ts';

test('globMatcher agrees with matchesGlob', () => {
  const globs = [
    ...DEFAULT_HIDDEN,
    'docs/*.md', '/build/**', 'src/**/gen/*.ts', '*.{js,ts}', 'a[bc].txt', '!x', 'é*.txt', '?.lock', 'vendor/**/*.min.*',
  ].map(normalize);
  const paths = [
    'package-lock.json', 'web/package-lock.json', 'web/Package-Lock.json', 'a/yarn.lock', 'x.min.js', 'dist/app.MIN.JS',
    'src/__snapshots__/a.snap', '__snapshots__/x', 'deep/a/b/c.pb.go', 'foo.generated.ts', 'foo.generatedts', '.yarn/releases/yarn.cjs',
    'a/.yarn/plugins/p.cjs', 'docs/a.md', 'docs/sub/a.md', 'build/x/y', 'src/a/gen/b.ts', 'src/gen/b.ts', 'a.js', 'b/a.ts', 'ab.txt',
    'x/ac.txt', '!x', 'é1.txt', 'É1.txt', 'a.lock', 'ab.lock', 'vendor/q/r.min.css', 'go.sum', 'x/go.work.sum', 'README.md',
  ];
  for (const g of globs) {
    const match = globMatcher(g);
    for (const p of paths) assert.equal(match(p), matchesGlob(p, g), `${p} ~ ${g}`);
  }
});
