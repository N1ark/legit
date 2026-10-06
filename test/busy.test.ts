import assert from 'node:assert/strict';
import { test } from 'node:test';
import { switchRefusal } from '../src/ui/lib/busy.ts';

test('switching repo while busy says what to wait for', () => {
  assert.equal(switchRefusal('rebase'), 'Wait for the rebase to finish before switching repos.');
  assert.equal(switchRefusal('stage'), 'Wait for staging to finish before switching repos.');
  assert.equal(switchRefusal('somethingNew'), 'Wait for the current operation to finish before switching repos.');
  assert.equal(switchRefusal(null), 'Wait for the current operation to finish before switching repos.');
});
