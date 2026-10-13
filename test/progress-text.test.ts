import assert from 'node:assert/strict';
import { test } from 'node:test';
import { progressSummary, progressText } from '../src/ui/lib/progress.ts';
import type { Progress } from '../src/shared/types.ts';

const p = (o: Partial<Progress>): Progress => ({ op: 'fetch', remote: 'origin', phase: 'Receiving objects', server: false, percent: 41, detail: '5/12', ...o });

test('progress reads as the phase and how far, naming the remote for its own side or among several', () => {
  assert.equal(progressText(p({})), 'Receiving objects 41%');
  assert.equal(progressText(p({ server: true, phase: 'Counting objects', percent: 23 })), 'origin: counting objects 23%');
  assert.equal(progressText(p({ phase: 'Enumerating objects', percent: null })), 'Enumerating objects');
  assert.equal(progressSummary([p({ detail: '3.11 MiB | 590.00 KiB/s' })]), 'Receiving objects 41% · 3.11 MiB | 590.00 KiB/s');
  assert.equal(progressSummary([p({})]), 'Receiving objects 41%');
  assert.equal(
    progressSummary([p({}), p({ remote: 'upstream', phase: 'Resolving deltas', percent: 7 })]),
    'origin: receiving objects 41% · upstream: resolving deltas 7%',
  );
});
