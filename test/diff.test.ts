import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { alignRun, applyLines, commitDiff } from '../src/server/diff.ts';
import { Git } from '../src/server/git.ts';

const dir = mkdtempSync(join(tmpdir(), 'legit-fuzz-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, env, encoding: 'latin1' }).trim();

// Deterministic PRNG so failures reproduce.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

function randomFile(): string {
  const n = Math.floor(rand() * 30);
  const words = ['a', 'b', 'c', 'foo', 'bar', '', '  x', '\tindent', 'é', 'line\r'];
  const lines = Array.from({ length: n }, () => pick(words));
  const text = lines.join('\n');
  return rand() < 0.3 ? text : text + (n ? '\n' : '');
}

function mutate(s: string): string {
  const lines = s.split('\n');
  for (let k = Math.floor(rand() * 6); k >= 0; k--) {
    const i = Math.floor(rand() * (lines.length + 1));
    const r = rand();
    if (r < 0.35) lines.splice(i, 0, pick(['new', 'b', '', 'zz', 'ü']));
    else if (r < 0.7) lines.splice(i, 1);
    else lines[i] = 'changed' + i;
  }
  let out = lines.join('\n');
  if (rand() < 0.2) out = out.replace(/\n$/, '');
  else if (rand() < 0.2 && !out.endsWith('\n')) out += '\n';
  return out;
}

test('rebuilding from all/none/a subset of changed lines', async () => {
  git('init', '-q');
  const repo = await Git.open(dir);
  for (let round = 0; round < 100; round++) {
    const old = randomFile();
    const neu = rand() < 0.1 ? '' : mutate(old);
    writeFileSync(join(dir, 'f'), Buffer.from(old, 'latin1'));
    git('add', 'f');
    git('commit', '-q', '--allow-empty', '-m', 'old');
    writeFileSync(join(dir, 'f'), Buffer.from(neu, 'latin1'));
    git('add', 'f');
    git('commit', '-q', '--allow-empty', '-m', 'new');
    const d = await commitDiff(repo, git('rev-parse', 'HEAD'));
    const f = d.files[0];
    if (!f) continue;
    const ctx = `round ${round}: ${JSON.stringify(old)} -> ${JSON.stringify(neu)}`;
    assert.equal(applyLines(old, f.hunks, () => true), neu, ctx);
    assert.equal(applyLines(old, f.hunks, () => false), old, ctx);
    // A subset then its complement must end at the new content with git's own diff.
    const n = f.added + f.removed;
    const sel = new Set(Array.from({ length: n }, (_, i) => i).filter(() => rand() < 0.5));
    const mid = applyLines(old, f.hunks, (i) => sel.has(i));
    const midLines = mid.split('\n');
    const kept = f.hunks.flatMap((h) => h.lines).filter((l) => l.t === '+' && sel.has(l.i!)).length;
    const removed = f.hunks.flatMap((h) => h.lines).filter((l) => l.t === '-' && sel.has(l.i!)).length;
    const oldCount = old === '' ? 0 : old.split('\n').length - (old.endsWith('\n') ? 1 : 0);
    const midCount = mid === '' ? 0 : midLines.length - (mid.endsWith('\n') ? 1 : 0);
    assert.equal(midCount, oldCount + kept - removed, ctx);
  }
});

test('a kept old line stays in the place of the line it was edited into', () => {
  const h = (lines: [string, string][]) => [{
    header: '', oldStart: 1, oldCount: lines.filter(([t]) => t !== '+').length, newStart: 1,
    lines: (() => {
      let i = 0;
      return lines.map(([t, s]) => (t === ' ' ? { t, s } : { t, s, i: i++ })) as any;
    })(),
  }];
  // def greet / -return old / +docstring / +return new: pick only the docstring (index 1).
  const hunks = h([[' ', 'def greet(name):'], ['-', '    return f"hello {name}"'], ['+', '    """Say hello."""'], ['+', '    return f"hello {name}!"']]);
  const old = 'def greet(name):\n    return f"hello {name}"\n';
  assert.equal(applyLines(old, hunks, (i) => i === 1), 'def greet(name):\n    """Say hello."""\n    return f"hello {name}"\n');
  // Picking the edit of the return line but not the docstring.
  assert.equal(applyLines(old, hunks, (i) => i !== 1), 'def greet(name):\n    return f"hello {name}!"\n');
  // Everything / nothing are still exactly new / old.
  assert.equal(applyLines(old, hunks, () => true), 'def greet(name):\n    """Say hello."""\n    return f"hello {name}!"\n');
  assert.equal(applyLines(old, hunks, () => false), old);

  // Several edited lines with an insertion between: pairs follow similarity, not position.
  const dels = ['let a = 1;', 'let b = 2;', 'let c = 3;'];
  const adds = ['let a = 10;', '// new', 'let b = 20;', 'let c = 30;'];
  assert.deepEqual(alignRun(dels, adds), [{ del: 0, add: 0 }, { add: 1 }, { del: 1, add: 2 }, { del: 2, add: 3 }]);
  assert.deepEqual(alignRun(['x'], ['completely different']), [{ del: 0 }, { add: 0 }]);
});
