import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emojiOfUrl, toEmojis } from '../src/shared/gh-emojis.ts';
import { lexInline } from '../src/ui/lib/markdown.ts';

test("GitHub's emoji: Unicode from its image URLs, its own as images", () => {
  assert.equal(emojiOfUrl('https://github.githubassets.com/images/icons/emoji/unicode/1f44d.png?v8'), '👍');
  assert.equal(emojiOfUrl('https://github.githubassets.com/images/icons/emoji/unicode/1f1fa-1f1f8.png?v8'), '🇺🇸');
  assert.equal(emojiOfUrl('https://github.githubassets.com/images/icons/emoji/octocat.png?v8'), null);
  assert.deepEqual(toEmojis({ '+1': 'https://x/unicode/1f44d.png', octocat: 'https://x/octocat.png' }), { '+1': '👍', octocat: 'img:https://x/octocat.png' });
});

test('shortcodes are their own tokens in messages, not in code or words', () => {
  const kinds = (s: string) => lexInline(s).map((t) => (t.type === 'emoji' ? `emoji:${(t as unknown as { name: string }).name}` : t.type));
  assert.deepEqual(kinds('Sounds good :+1:'), ['text', 'emoji:+1']);
  assert.deepEqual(kinds(':tada: shipped'), ['emoji:tada', 'text']);
  assert.deepEqual(kinds('`:tada:`'), ['codespan']);
});
