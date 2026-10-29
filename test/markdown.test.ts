/// <reference path="../src/ui/lib/prism.d.ts" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fencePath, language } from '../src/ui/lib/languages.ts';
import { blockLines, changedBlocks, docLink, headingSlugs, lexBlocks, lexDocument, lexInline, refUrl, safeHref } from '../src/ui/lib/markdown.ts';

const kinds = (text: string) => lexInline(text).map((t) => `${t.type}:${t.raw}`);

test('issue references, but not inside words, entities or URLs', () => {
  assert.deepEqual(kinds('Fix #12, GH-3 and a/b#4'), ['text:Fix ', 'ref:#12', 'text:, ', 'ref:GH-3', 'text: and ', 'ref:a/b#4']);
  assert.deepEqual(kinds('abc#4 &#123; #12a'), ['text:abc#4 &#123; #12a']);
  assert.deepEqual(kinds('see https://x.com/page#12 now'), ['text:see ', 'link:https://x.com/page#12', 'text: now']);
  assert.deepEqual(kinds('Merge pull request #7 from me/branch'), ['text:Merge pull request ', 'ref:#7', 'text: from me/branch']);
});

test('titles stay inline; messages get blocks', () => {
  assert.deepEqual(kinds('1. Use `x`'), ['text:1. Use ', 'codespan:`x`']);
  assert.equal(lexInline('1. Use `x`'), lexInline('1. Use `x`'), 'a title seen lately is lexed once');
  assert.deepEqual(
    lexBlocks('Wrapped\nline.\n\n- a\n- b').filter((t) => t.type !== 'space').map((t) => t.type),
    ['paragraph', 'list'],
  );
});

test('links', () => {
  const [r] = lexInline('#5') as any[];
  assert.equal(refUrl(r, 'o/r'), 'https://github.com/o/r/issues/5');
  assert.equal(refUrl(r, null), null);
  const [x] = lexInline('x/y#6') as any[];
  assert.equal(refUrl(x, null), 'https://github.com/x/y/issues/6');
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('file:///etc/passwd'), null);
  assert.equal(safeHref('relative/path'), null);
  assert.equal(safeHref('https://a.b/c'), 'https://a.b/c');
});

const doc = (lines: string[]) => lexDocument(lines.join('\n'));

test("a file's blocks map to their lines", () => {
  const text = ['# Title', '', 'Para one', 'still one', '', '```ts', 'x', '```', '', '', '- a', '- b', 'end'];
  const tokens = doc(text);
  const ranges = blockLines(tokens)
    .map((r, k) => [tokens[k].type, ...r])
    .filter(([type]) => type !== 'space');
  assert.deepEqual(ranges, [['heading', 1, 1], ['paragraph', 3, 4], ['code', 6, 8], ['list', 11, 13]]);
  // CRLF is one line break, as git counts lines.
  const crlf = lexDocument('a\r\n\r\nb\r\n');
  assert.deepEqual(blockLines(crlf).at(-1), [3, 3]);
});

test('front matter is a YAML block; alerts are marked and lose their marker', () => {
  const tokens = doc(['---', 'title: x', '---', '', '> [!WARNING]', '> Careful', '', '> plain']) as any[];
  assert.equal(tokens[0].type, 'code');
  assert.equal(tokens[0].lang, 'yaml');
  assert.equal(tokens[0].text, 'title: x');
  const [warn, plain] = tokens.filter((t) => t.type === 'blockquote');
  assert.equal(warn.alert, 'warning');
  assert.deepEqual(warn.tokens.map((t: any) => t.raw), ['Careful']);
  assert.equal(plain.alert, undefined);
  assert.deepEqual(blockLines(tokens).filter((_, k) => tokens[k].type === 'blockquote'), [[5, 6], [8, 8]]);
  assert.deepEqual(kinds('see #12'), ['text:see ', 'ref:#12'], 'messages still link references');
  assert.ok(!(lexDocument('see #12')[0] as any).tokens.some((t: any) => t.type === 'ref'), 'files do not');
});

test('changed lines mark blocks, list items and table rows', () => {
  const text = ['# T', '', 'p1', 'p2', '', '- a', '- b', '  - nested', '- c', '', '| h | i |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |'];
  const tokens = doc(text);
  const list = tokens.find((t) => t.type === 'list') as any;
  const table = tokens.find((t) => t.type === 'table') as any;
  const names = new Map<object, string>([
    ...tokens.map((t) => [t, t.type] as [object, string]),
    ...list.items.map((i: any) => [i, `item ${i.text.split('\n')[0]}`] as [object, string]),
    [list.items[1].tokens.find((t: any) => t.type === 'list').items[0], 'item nested'],
    [table.header, 'header'],
    ...table.rows.map((r: any, j: number) => [r, `row ${j}`] as [object, string]),
  ]);
  const marked = (at: number[]) => [...changedBlocks(tokens, new Set(at))].map((m) => names.get(m));
  assert.deepEqual(marked([]), []);
  assert.deepEqual(marked([1, 4]), ['heading', 'paragraph']);
  assert.deepEqual(marked([2, 5]), [], 'blank lines mark nothing');
  assert.deepEqual(marked([7]), ['item b']);
  assert.deepEqual(marked([8]), ['item nested'], 'a nested item marks itself, not the item around it');
  assert.deepEqual(marked([9, 12, 14]), ['item c', 'header', 'row 1']);
});

test('heading anchors, as GitHub makes them', () => {
  const tokens = doc(['# Getting started', '## Use `npm` & *go*!', '# Getting started', '> ## Ünïcode 2.0']);
  assert.deepEqual([...headingSlugs(tokens).values()], ['getting-started', 'use-npm--go', 'getting-started-1', 'ünïcode-20']);
});

test("links in a file: web pages, the file's headings, the repository's files", () => {
  assert.deepEqual(docLink('https://x.y/z', 'docs/a.md'), { kind: 'url', href: 'https://x.y/z' });
  assert.deepEqual(docLink('#Install%20it', 'docs/a.md'), { kind: 'anchor', slug: 'install it' });
  assert.deepEqual(docLink('b.md#part', 'docs/a.md'), { kind: 'file', path: 'docs/b.md' });
  assert.deepEqual(docLink('../src/my%20x.ts?raw', 'docs/a.md'), { kind: 'file', path: 'src/my x.ts' });
  assert.deepEqual(docLink('./img/../shot.png', 'README.md'), { kind: 'file', path: 'shot.png' });
  assert.deepEqual(docLink('/LICENSE', 'docs/deep/a.md'), { kind: 'file', path: 'LICENSE' });
  assert.equal(docLink('javascript:alert(1)', 'a.md'), null);
  assert.equal(docLink('//evil.com/x', 'a.md'), null);
  assert.equal(docLink('', 'a.md'), null);
});

test('code block languages', () => {
  assert.equal(language(fencePath('ts')!), 'typescript');
  assert.equal(language(fencePath('rust')!), 'rust');
  assert.equal(language(fencePath('Python {linenos}')!), 'python');
  assert.equal(language(fencePath('shell')!), 'bash');
  assert.equal(language(fencePath('dockerfile')!), 'docker');
  assert.equal(language(fencePath('html')!), 'markup');
  assert.equal(fencePath('mermaid'), null);
  assert.equal(fencePath(''), null);
  assert.equal(fencePath(undefined), null);
});
