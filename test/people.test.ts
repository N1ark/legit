import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAuthor, parsePeople } from '../src/ui/lib/people.ts';

test('people: an author is `Name <email>` with a name', () => {
  assert.deepEqual(parseAuthor('  Ada Lovelace  <ada@example.com> '), { name: 'Ada Lovelace', email: 'ada@example.com' });
  assert.deepEqual(parseAuthor('Ada <>'), { name: 'Ada', email: '' });
  assert.equal(parseAuthor(''), null);
  assert.equal(parseAuthor('Ada Lovelace'), null);
  assert.equal(parseAuthor('<ada@example.com>'), null);
});

test('people: co-authors skip blank lines and refuse a malformed one', () => {
  assert.deepEqual(parsePeople(['', 'Ada <ada@example.com>', ' ']), [{ name: 'Ada', email: 'ada@example.com' }]);
  assert.equal(parsePeople(['Ada <ada@example.com>', 'Grace']), null);
});
