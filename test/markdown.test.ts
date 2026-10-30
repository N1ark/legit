/// <reference path="../src/ui/lib/prism.d.ts" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fencePath, language } from '../src/ui/lib/languages.ts';
import { Marked } from 'marked';
import {
  DocLexer,
  DocModel,
  blockLines,
  changedBlocks,
  docLink,
  headingSlugs,
  lexBlocks,
  lexDocument,
  lexInline,
  refUrl,
  safeHref,
  sections,
} from '../src/ui/lib/markdown.ts';

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

/** Files whose sections could lex differently from the whole, if cut in the wrong place. */
const TRICKY = [
  ['Use [the docs][docs] and [x].', '', '- a', '', '  still a', '- b', '', 'After the list.', '', '> [docs]: https://d.x', '', '[x]: https://x.y "X"'],
  ['```md', '# not a heading', '', 'Para in a fence', '```', '', '~~~', '```', '', 'Text', '~~~~~', '', 'Out.'],
  ['<!-- a comment', '', '# not a heading', '', '-->', '', '<pre>', '', 'Kept', '', '</pre>', '', 'Text', '===', '', 'Para'],
  ['1. one', '', '   two', '', '2. three', '', 'Para', '', '    indented code', '', '    # still code', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', 'Next'],
  ['> quote', 'lazy line', '', 'Para ``` not a fence ``` here', '', '* x', '', '  * y', '', 'Para', '---', '', 'Last <b>html</b>.'],
];

/** Lexed in sections as small as can be, a step at a time. */
function stepwise(text: string, size: number) {
  const l = new DocLexer(text, size);
  while (!l.step(((go) => () => go && !(go = false))(true)));
  return l.tokens;
}

test('a file lexed in sections, a step at a time, lexes as the whole does', () => {
  const whole = new Marked({ gfm: true, breaks: false });
  for (const lines of TRICKY) {
    const text = lines.join('\n');
    assert.ok(sections(text, 1).length > 0, 'it is cut');
    const want = JSON.stringify(whole.lexer(text));
    for (const size of [1, 30]) assert.equal(JSON.stringify(stepwise(text, size)), want, `${lines[0]}, sections of ${size}`);
  }
  // Front matter and alerts too, as the whole file is lexed.
  const text = ['---', 'a: 1', '---', '# T', '', '> [!TIP]', '> Hi', '', 'End'].join('\n');
  assert.equal(JSON.stringify(stepwise(text, 1)), JSON.stringify(lexDocument(text)));
  assert.equal((stepwise(text, 1)[0] as any).lang, 'yaml');
});

test('sections start at headings and paragraphs after a blank line, outside fences and comments', () => {
  const text = 'a\n\n# b\n\n- c\n\n```\n\nd\n```\n\n<!--\n\ne\n-->\n\nf\n';
  const cuts = sections(text, 1);
  assert.deepEqual(
    cuts.map((at) => text.slice(at).split('\n')[0]),
    ['# b', 'f'],
  );
  assert.deepEqual(sections(text, 1000), [], 'none smaller than asked');
});

test("a file's model gives lines, anchors and changes as the whole file's tokens do", () => {
  const text = ['# A', '', 'p', '', '> ## A', '', '- x', '  # In a list', '', '# A', ...Array.from({ length: 40 }, (_, k) => `\nPara ${k}\n\n## A`)].join('\n');
  const all = lexDocument(text);
  const m = new DocModel(text);
  while (!m.step(((go) => () => go && !(go = false))(true)));
  assert.deepEqual(m.lines, blockLines(all));
  assert.deepEqual([...m.slugs.values()], [...headingSlugs(all).values()]);
  assert.equal(m.anchors.get('a-1'), all.findIndex((t) => t.type === 'blockquote'), 'an anchor in a quote is its block');
  assert.equal(m.anchors.get('in-a-list'), all.findIndex((t) => t.type === 'list'));
  const changed = new Set([5, 8, 14]);
  const want = changedBlocks(all, changed);
  const got = new Set(m.tokens.flatMap((_, k) => [...m.changed(k, changed)]));
  assert.equal(JSON.stringify([...got]), JSON.stringify([...want]));
  assert.equal(DocModel.of(text), DocModel.of(text), 'a text is lexed once');
});

test("a version of a file takes the sections another lexed that read the same, and lexes as the whole does", () => {
  const para = (k: number) => `Paragraph ${k} with **bold** and a [link](https://x.y/${k}).`;
  const one = Array.from({ length: 60 }, (_, k) => `## Part ${k}\n\n${para(k)}\n\n> [!NOTE]\n> Note ${k}.\n`).join('\n');
  const two = one.replace('Paragraph 30 with', 'Paragraph thirty with');
  const a = new DocLexer(one, 200);
  a.step(() => true);
  const b = new DocLexer(two, 200);
  b.share(a);
  b.step(() => true);
  assert.equal(JSON.stringify(b.tokens), JSON.stringify(lexDocument(two)));
  const shared = b.tokens.filter((t) => a.tokens.includes(t)).length;
  assert.ok(shared > b.tokens.length * 0.8, `${shared} of ${b.tokens.length} taken`);
  assert.equal(new Set(b.tokens).size, b.tokens.length, 'none twice');
  // A file that defines link references lexes each version whole.
  const c = new DocLexer(`${one}\n[x]: https://x.y\n`, 200);
  c.step(() => true);
  const d = new DocLexer(`${two}\n[x]: https://x.y\n`, 200);
  d.share(c);
  d.step(() => true);
  assert.equal(d.tokens.filter((t) => c.tokens.includes(t)).length, 0);
});
