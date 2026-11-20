import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unexpected } from '../src/server/gh/client.ts';
import { noCodeowners } from '../src/server/gh/prfiles.ts';

const missingFile = (alias: string, path: string) => ({
  type: 'NOT_FOUND',
  path: ['repository', 'pullRequest', 'baseRef', 'target', alias],
  message: `Could not resolve file for path '${path}'.`,
});

test("a CODEOWNERS place that has none reads null, rather than failing the pull request's files", () => {
  const data = { repository: { pullRequest: { baseRef: { target: { o0: { object: { text: '* @a' } }, o1: null, o2: null } } } } };
  assert.deepEqual(unexpected({ data, errors: [missingFile('o1', 'CODEOWNERS'), missingFile('o2', 'docs/CODEOWNERS')] }, noCodeowners), []);
});

test('other errors still fail the query, a missing file elsewhere included', () => {
  const repo = { type: 'NOT_FOUND', path: ['repository'], message: "Could not resolve to a Repository with the name 'a/b'." };
  assert.deepEqual(unexpected({ data: { repository: null }, errors: [missingFile('o1', 'CODEOWNERS'), repo] }, noCodeowners), [repo]);
  const file = missingFile('o1', 'CODEOWNERS');
  assert.deepEqual(unexpected({ data: {}, errors: [file] }), [file]);
  // No data at all: nothing to read null from.
  assert.deepEqual(unexpected({ errors: [file] }, noCodeowners), [file]);
});
