import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lexBlocks, lexInline, refUrl, safeHref } from '../src/ui/lib/markdown.ts';

const kinds = (text: string) => lexInline(text).map((t) => `${t.type}:${t.raw}`);

test('issue references, but not inside words, entities or URLs', () => {
  assert.deepEqual(kinds('Fix #12, GH-3 and a/b#4'), ['text:Fix ', 'ref:#12', 'text:, ', 'ref:GH-3', 'text: and ', 'ref:a/b#4']);
  assert.deepEqual(kinds('abc#4 &#123; #12a'), ['text:abc#4 &#123; #12a']);
  assert.deepEqual(kinds('see https://x.com/page#12 now'), ['text:see ', 'link:https://x.com/page#12', 'text: now']);
  assert.deepEqual(kinds('Merge pull request #7 from me/branch'), ['text:Merge pull request ', 'ref:#7', 'text: from me/branch']);
});

test('titles stay inline; messages get blocks', () => {
  assert.deepEqual(kinds('1. Use `x`'), ['text:1. Use ', 'codespan:`x`']);
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
