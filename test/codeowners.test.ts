import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile, fields, ownedBy, ownersOf, parseCodeowners } from '../src/ui/lib/codeowners.ts';

const matches = (pattern: string, path: string) => compile(pattern)!.test(path);

/** Which of `paths` the pattern matches. */
const which = (pattern: string, paths: string[]) => paths.filter((p) => matches(pattern, p));

test('a line is a pattern and owners, up to a comment; escapes stay for the pattern', () => {
  assert.deepEqual(fields('*.js    @js-owner #This is an inline comment.'), ['*.js', '@js-owner']);
  assert.deepEqual(fields('  # a comment'), []);
  assert.deepEqual(fields('\\#notes @a'), ['\\#notes', '@a']);
  assert.deepEqual(fields('my\\ file.txt\t@a  @b'), ['my\\ file.txt', '@a', '@b']);
  assert.deepEqual(fields('a#b @c'), ['a#b', '@c']);
  assert.deepEqual(fields(''), []);
});

test('patterns without a slash match at any depth, as a file or a folder', () => {
  const paths = ['x.js', 'a/x.js', 'a/b/x.js', 'x.jsx', 'x.js/inner.txt', 'ax.js'];
  assert.deepEqual(which('*.js', paths), ['x.js', 'a/x.js', 'a/b/x.js', 'x.js/inner.txt', 'ax.js']);
  assert.deepEqual(which('logs', ['logs', 'logs/a', 'a/logs', 'a/logs/b.txt', 'logsx', 'a/xlogs']), ['logs', 'logs/a', 'a/logs', 'a/logs/b.txt']);
  assert.deepEqual(which('?.md', ['a.md', 'ab.md', 'd/a.md']), ['a.md', 'd/a.md']);
});

test('a leading or middle slash anchors to the root', () => {
  assert.deepEqual(which('/build/logs/', ['build/logs/a.txt', 'build/logs/deep/b', 'build/logs', 'x/build/logs/a']), ['build/logs/a.txt', 'build/logs/deep/b']);
  assert.deepEqual(which('/README.md', ['README.md', 'docs/README.md']), ['README.md']);
  assert.deepEqual(which('src/app', ['src/app', 'src/app/x.ts', 'lib/src/app/x.ts', 'src/apple']), ['src/app', 'src/app/x.ts']);
  assert.deepEqual(which('/apps/github', ['apps/github', 'apps/github/x', 'apps/githubx']), ['apps/github', 'apps/github/x']);
});

test('a trailing slash only matches folders, at any depth without another slash', () => {
  assert.deepEqual(which('apps/', ['apps/a', 'apps/a/b', 'x/apps/a', 'apps', 'xapps/a']), ['apps/a', 'apps/a/b', 'x/apps/a']);
  assert.deepEqual(which('/docs/', ['docs/a', 'docs/a/b', 'x/docs/a']), ['docs/a', 'docs/a/b']);
});

test('a trailing /* matches only the folder’s own files; * within a name stops at slashes', () => {
  assert.deepEqual(which('docs/*', ['docs/getting-started.md', 'docs/build-app/troubleshooting.md', 'x/docs/a.md']), ['docs/getting-started.md']);
  assert.deepEqual(which('docs/*.md', ['docs/a.md', 'docs/d/a.md']), ['docs/a.md']);
  assert.deepEqual(which('src/*/index.ts', ['src/a/index.ts', 'src/index.ts', 'src/a/b/index.ts']), ['src/a/index.ts']);
});

test('** matches any number of folders', () => {
  assert.deepEqual(which('**/logs', ['logs', 'a/logs', 'a/b/logs/c.txt', 'xlogs']), ['logs', 'a/logs', 'a/b/logs/c.txt']);
  assert.deepEqual(which('docs/**', ['docs/a', 'docs/a/b', 'docs', 'x/docs/a']), ['docs/a', 'docs/a/b']);
  assert.deepEqual(which('a/**/b', ['a/b', 'a/x/b', 'a/x/y/b', 'a/x/y/b/c', 'a/xb']), ['a/b', 'a/x/b', 'a/x/y/b', 'a/x/y/b/c']);
  assert.deepEqual(which('**', ['a', 'a/b']), ['a', 'a/b']);
  assert.deepEqual(which('*', ['a', 'a/b', '.github/CODEOWNERS']), ['a', 'a/b', '.github/CODEOWNERS']);
});

test('special characters are literal, escapes too; matching is case-sensitive', () => {
  assert.ok(matches('a+b(c).ts', 'a+b(c).ts'));
  assert.ok(!matches('a.ts', 'abts'));
  assert.ok(matches('\\#notes', '#notes'));
  assert.ok(matches('\\*.md', '*.md') && !matches('\\*.md', 'a.md'));
  assert.ok(matches('my\\ file.txt', 'dir/my file.txt'));
  assert.ok(!matches('README.md', 'readme.md'));
});

test("patterns GitHub doesn't support are refused", () => {
  assert.equal(compile('!keep.js'), null);
  assert.equal(compile('[Rr]eadme.md'), null);
  assert.equal(compile('/'), null);
  assert.ok(compile('\\[x].md'));
});

const FILE = `# GitHub's example, mostly
*       @global-owner1 @global-owner2
*.js    @js-owner #This is an inline comment.
*.go docs@example.com
*.txt @octo-org/octocats
/build/logs/ @doctocat
docs/*  docs@example.com
apps/ @octocat
/docs/ @doctocat
/scripts/ @doctocat @octocat
**/logs @octocat

/apps/ @octocat
/apps/github
!skipped.js @nobody
bad-owner.js octocat
`;

test('the last matching rule wins; one without owners leaves the file unowned; bad lines are skipped', () => {
  const rules = parseCodeowners(FILE);
  assert.deepEqual(rules.map((r) => r.line), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14]);
  const who = (p: string) => ownersOf(rules, p)?.owners ?? null;
  assert.deepEqual(who('README.md'), ['@global-owner1', '@global-owner2']);
  assert.deepEqual(who('src/app.js'), ['@js-owner']);
  assert.deepEqual(who('main.go'), ['docs@example.com']);
  assert.deepEqual(who('notes/a.txt'), ['@octo-org/octocats']);
  assert.deepEqual(who('build/logs/a.txt'), ['@octocat']); // **/logs comes later
  assert.deepEqual(who('docs/getting-started.md'), ['@doctocat']); // /docs/ comes after docs/*
  assert.deepEqual(who('scripts/x.sh'), ['@doctocat', '@octocat']);
  assert.deepEqual(who('apps/web/x.ts'), ['@octocat']);
  assert.equal(who('apps/github/x.ts'), null);
  assert.deepEqual(who('skipped.js'), ['@js-owner']);
  assert.deepEqual(who('bad-owner.js'), ['@js-owner']);
  assert.equal(ownersOf(rules, 'apps/web/x.ts')?.rule.line, 13);
  assert.equal(ownersOf(parseCodeowners('/src/ @a\n'), 'lib/x.ts'), null);
  assert.deepEqual(parseCodeowners('a @b\r\nc @d\r\n').map((r) => r.pattern), ['a', 'c']);
});

test("the viewer owns a file named for them, whatever the case; teams and e-mails aren't theirs", () => {
  assert.ok(ownedBy(['@acme/devs', '@OctoCat'], 'octocat'));
  assert.ok(!ownedBy(['@acme/octocat', 'octocat@github.com'], 'octocat'));
  assert.ok(!ownedBy(['@octocat'], ''));
  // Through a team the viewer is on.
  assert.ok(ownedBy(['@acme/Docs'], 'octocat', ['@acme/docs']));
  assert.ok(!ownedBy(['@acme/devs'], 'octocat', ['@acme/docs']));
});
