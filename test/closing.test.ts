import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addClosing, closes, removeClosing } from '../src/ui/lib/closing.ts';

const here = 'acme/widgets';

test('linking an issue adds "Closes #N", unless a keyword names it already', () => {
  assert.equal(addClosing('', here, 12, here), 'Closes #12');
  assert.equal(addClosing('Fixes the parser.\n', here, 12, here), 'Fixes the parser.\n\nCloses #12');
  assert.equal(addClosing('Text\n\nCloses #3', here, 12, here), 'Text\n\nCloses #3\nCloses #12');
  assert.equal(addClosing('Text', 'other/lib', 4, here), 'Text\n\nCloses other/lib#4');
  assert.equal(addClosing('fixes #12 by checking', here, 12, here), 'fixes #12 by checking');
});

test('closing keywords are read as GitHub reads them', () => {
  for (const b of ['Closes #12', 'closed #12.', 'Fix: #12', 'resolves acme/widgets#12', 'Fixes https://github.com/acme/widgets/issues/12']) {
    assert.ok(closes(b, here, 12, here), b);
  }
  for (const b of ['See #12', 'Closes #123', 'Closes #1', 'Closes other/repo#12']) assert.ok(!closes(b, here, 12, here), b);
});

test('unlinking takes out the keyword naming it, and a line left empty', () => {
  assert.equal(removeClosing('Text\n\nCloses #12\n', here, 12, here), 'Text\n');
  assert.equal(removeClosing('Text\n\nCloses #3\nCloses #12', here, 12, here), 'Text\n\nCloses #3');
  assert.equal(removeClosing('Closes #3, closes #12', here, 12, here), 'Closes #3');
  assert.equal(removeClosing('- Fixes #12\n- Keeps #13', here, 12, here), '- Keeps #13');
  assert.equal(removeClosing('Closes #123', here, 12, here), 'Closes #123');
});
