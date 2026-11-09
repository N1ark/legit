import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fencePath, language } from '../src/ui/lib/languages.ts';

test('Lean files and ```lean blocks are highlighted as Lean', async () => {
  assert.equal(language('Mathlib/Order/Basic.lean'), 'lean');
  assert.equal(language(fencePath('lean4') ?? ''), 'lean');
  (globalThis as any).Prism = { manual: true, disableWorkerMessageHandler: true };
  const Prism = (await import('prismjs')).default;
  (globalThis as any).Prism = Prism;
  await import('../src/ui/lib/prism-lean.ts');
  const src = [
    '/-- The successor is bigger. -/',
    "@[simp] theorem lt_succ' (n : Nat) : n < n + 1 := by",
    '  -- easy',
    '  exact Nat.lt_succ_self n',
    'def greet (s : String) : String := s!"hi {s}" ++ "\\"" ++ toString \'x\'',
  ].join('\n');
  const kinds = (Prism.tokenize(src, Prism.languages.lean) as any[])
    .filter((t) => typeof t !== 'string')
    .map((t) => `${t.type}:${typeof t.content === 'string' ? t.content : ''}`);
  for (const k of [
    'comment:/-- The successor is bigger. -/', 'attribute:@[simp]', 'keyword:theorem', "function:lt_succ'",
    'operator::=', 'keyword:by', 'comment:-- easy', 'keyword:def', 'function:greet',
    'string:s!"hi {s}"', 'string:"\\""', "char:'x'", 'number:1',
  ]) {
    assert.ok(kinds.includes(k), `${k} in ${kinds.join(' ')}`);
  }
  // A prime ends an identifier, not a character literal.
  assert.ok(!kinds.some((k) => k.startsWith('char:') && k !== "char:'x'"));
});
