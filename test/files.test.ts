import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatSize, imageType } from '../src/shared/files.ts';

test('images by extension, sizes for people', () => {
  assert.equal(imageType('a/logo.PNG'), 'image/png');
  assert.equal(imageType('icon.svg'), 'image/svg+xml');
  assert.equal(imageType('x.png/readme'), null);
  assert.equal(imageType('png'), null);
  assert.equal(formatSize(950), '950 B');
  assert.equal(formatSize(12_600), '12.3 KB');
  assert.equal(formatSize(4 * 1024 * 1024), '4.0 MB');
});
