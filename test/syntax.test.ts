import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Git } from '../src/server/git.ts';
import { grammarFiles, grammarProblems, syntaxes, withoutNeeded, zedGrammars } from '../src/server/syntax.ts';
import { setup } from './util.ts';

const t = setup();

/** A minimal side module: a dylink.0 section (memory info, then `needed`), then a custom section after it. */
function module(needed: string[]): Buffer {
  const str = (s: string) => [s.length, ...Buffer.from(s)];
  const sub = (type: number, body: number[]) => [type, body.length, ...body];
  const section = (name: string, body: number[]) => [0, str(name).length + body.length, ...str(name), ...body];
  return Buffer.from([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section('dylink.0', [...sub(1, [4, 0, 0, 0]), ...sub(2, [needed.length, ...needed.flatMap(str)])]),
    ...section('after', [7]),
  ]);
}

test('dropping the needed libraries from a grammar keeps it a valid module with everything else', () => {
  const stripped = withoutNeeded(module(['libc.so']));
  const m = new WebAssembly.Module(new Uint8Array(stripped));
  const [dylink] = WebAssembly.Module.customSections(m, 'dylink.0');
  assert.deepEqual([...new Uint8Array(dylink)], [1, 4, 4, 0, 0, 0]);
  assert.deepEqual([...new Uint8Array(WebAssembly.Module.customSections(m, 'after')[0])], [7]);
  // Nothing to drop: unchanged.
  const plain = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  assert.equal(withoutNeeded(plain), plain);
});

test('syntax rules pick a grammar by glob, and only grammars a rule uses are served', async () => {
  const git = await Git.open(t.dir);
  const rules = [
    { pattern: '*.out', grammar: 'ullbc' },
    { pattern: 'tests/special/*.out', grammar: 'grammars/mine' },
  ];
  const map = syntaxes(rules, ['a.out', 'tests/ui/b.out', 'tests/special/c.out', 'd.rs']);
  assert.deepEqual(Object.fromEntries(map), { 'a.out': 'ullbc', 'tests/ui/b.out': 'ullbc', 'tests/special/c.out': 'grammars/mine' });

  // A folder (relative to the repo) with a compiled grammar and its query, laid out like a grammar's repo.
  mkdirSync(join(t.dir, 'grammars/mine/queries'), { recursive: true });
  writeFileSync(join(t.dir, 'grammars/mine/tree-sitter-mine.wasm'), module(['libc.so']));
  writeFileSync(join(t.dir, 'grammars/mine/queries/highlights.scm'), '(x) @keyword\n');
  const g = await grammarFiles(git, rules, 'grammars/mine');
  assert.equal(g.highlights, '(x) @keyword\n');
  assert.deepEqual(g.wasm, withoutNeeded(module(['libc.so'])));

  await assert.rejects(grammarFiles(git, rules, '/etc'), /No syntax highlighting rule uses "\/etc"/);
  const none = [...rules, { pattern: '*.x', grammar: 'grammars/none' }];
  await assert.rejects(grammarFiles(git, none, 'grammars/none'), /No grammar \(\*.wasm\) and highlights.scm in grammars\/none/);
  await withZed(async () => assert.deepEqual(Object.keys(await grammarProblems(git, none)), ['grammars/none']));
});

/** Run `f` with a fake home holding a Zed extension that has an `ullbc` grammar. */
async function withZed(f: () => Promise<void>) {
  const home = t.tmp('legit-home-');
  const ext = join(process.platform === 'darwin' ? join(home, 'Library/Application Support') : join(home, '.local/share'), 'zed/extensions/installed/ullbc');
  mkdirSync(join(ext, 'grammars'), { recursive: true });
  mkdirSync(join(ext, 'languages/ullbc'), { recursive: true });
  writeFileSync(join(ext, 'grammars/ullbc.wasm'), module(['libc.so']));
  writeFileSync(join(ext, 'languages/ullbc/config.toml'), 'name = "ULLBC Crate"\ngrammar = "ullbc"\npath_suffixes = ["ullbc.crate", "crate"]\n');
  writeFileSync(join(ext, 'languages/ullbc/highlights.scm'), '(y) @type\n');
  const before = { HOME: process.env.HOME, XDG: process.env.XDG_DATA_HOME };
  process.env.HOME = home;
  delete process.env.XDG_DATA_HOME;
  try {
    await f();
  } finally {
    process.env.HOME = before.HOME;
    if (before.XDG !== undefined) process.env.XDG_DATA_HOME = before.XDG;
  }
}

test("a grammar in a rule is found in Zed's installed extensions, by grammar or language name", async () => {
  await withZed(async () => {
    const git = await Git.open(t.dir);
    const rules = [
      { pattern: '*.out', grammar: 'ullbc' },
      { pattern: '*.crate', grammar: 'ULLBC Crate' },
      { pattern: '*.nope', grammar: 'nope' },
    ];
    assert.equal((await grammarFiles(git, rules, 'ullbc')).highlights, '(y) @type\n');
    assert.equal((await grammarFiles(git, rules, 'ULLBC Crate')).highlights, '(y) @type\n');
    await assert.rejects(grammarFiles(git, rules, 'nope'), /No grammar "nope" in Zed's installed extensions/);
    assert.deepEqual(await zedGrammars(), [{ grammar: 'ullbc', language: 'ULLBC Crate', suffixes: ['ullbc.crate', 'crate'] }]);
    assert.deepEqual(Object.keys(await grammarProblems(git, rules)), ['nope']);
  });
});
