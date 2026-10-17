// node scripts/gh-demo.ts <dir>: a repo whose origin is "github.com:acme/widgets" (really a bare
// repo next to it), with the branches the fake GitHub (src/server/gh/mock/) has pull requests for.
// Then: LEGIT_GITHUB_MOCK=1 node bin/legit.ts --dev --no-open <dir>

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? 'gh-demo');
const bare = `${dir}.remote.git`;
rmSync(dir, { recursive: true, force: true });
rmSync(bare, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const env = { ...process.env, GIT_AUTHOR_NAME: 'Mona Octocat', GIT_AUTHOR_EMAIL: 'octocat@users.noreply.github.com' };
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
let day = 0;
const commit = (msg: string, files: Record<string, string>) => {
  for (const [f, s] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), s);
  }
  git('add', '-A');
  const date = `2026-10-${String(1 + day++).padStart(2, '0')}T10:00:00Z`;
  execFileSync('git', ['commit', '-qm', msg], { cwd: dir, env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
};

execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Mona Octocat');
git('config', 'user.email', 'octocat@users.noreply.github.com');
git('remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
git('config', `url.${bare}.insteadOf`, 'git@github.com:acme/widgets.git');

commit('Initial commit', {
  'README.md': '# widgets\n\nWidgets, specified in `.widget` files.\n\n## Usage\n\n```sh\nwidgets build specs/\n```\n',
  'src/index.ts': "export { build } from './build.ts';\n",
  'src/build.ts': "import { readFileSync } from 'node:fs';\n\nexport function build(path: string): string {\n  const text = readFileSync(path, 'utf8');\n  return text.trim();\n}\n",
});
commit('Fix a typo in the README (#9)', {
  'README.md': '# widgets\n\nWidgets, specified in `.widget` files.\n\n## Usage\n\n```sh\nwidgets build specs/\n```\n\nSee `docs/` for the format.\n',
});
git('push', '-q', '-u', 'origin', 'main');

git('switch', '-q', '-c', 'feature/parser');
commit('Add a tokenizer for widget specs', {
  'src/tokenizer.ts': [
    "export type Token = { kind: 'word' | 'number' | 'punct'; text: string; line: number };",
    '',
    'export function tokenize(src: string): Token[] {',
    '  const out: Token[] = [];',
    '  let line = 1;',
    '  for (const m of src.matchAll(/(\\n)|(\\d+)|(\\w+)|([{}:;])/g)) {',
    '    if (m[1]) line++;',
    "    else if (m[2]) out.push({ kind: 'number', text: m[2], line });",
    "    else if (m[3]) out.push({ kind: 'word', text: m[3], line });",
    "    else out.push({ kind: 'punct', text: m[4], line });",
    '  }',
    '  return out;',
    '}',
    '',
  ].join('\n'),
});
commit('Parse tokens into widget specs', {
  'src/parser.ts': [
    "import { tokenize, type Token } from './tokenizer.ts';",
    '',
    'export interface Spec {',
    '  name: string;',
    '  props: Record<string, string>;',
    '}',
    '',
    'export function parse(src: string): Spec[] {',
    '  const tokens = tokenize(src);',
    '  const specs: Spec[] = [];',
    '  let i = 0;',
    '  while (i < tokens.length) {',
    '    const name = tokens[i++].text;',
    '    const props: Record<string, string> = {};',
    "    i++; // '{'",
    "    while (tokens[i] && tokens[i].text !== '}') {",
    '      const key = tokens[i].text;',
    '      props[key] = tokens[i + 2].text;',
    '      i += 4;',
    '    }',
    '    i++;',
    '    specs.push({ name, props });',
    '  }',
    '  return specs;',
    '}',
    '',
  ].join('\n'),
  'src/build.ts': "import { readFileSync } from 'node:fs';\nimport { parse } from './parser.ts';\n\nexport function build(path: string): string {\n  const specs = parse(readFileSync(path, 'utf8'));\n  return JSON.stringify(specs, null, 2);\n}\n",
});
git('push', '-q', '-u', 'origin', 'feature/parser');

git('switch', '-q', '-c', 'feature/parser-errors');
commit('Report parse errors with line numbers', {
  'src/errors.ts': 'export class ParseError extends Error {\n  constructor(message: string, readonly line: number) {\n    super(`line ${line}: ${message}`);\n  }\n}\n',
});
commit('Throw a ParseError on a missing brace', {
  'src/parser.ts': [
    "import { ParseError } from './errors.ts';",
    "import { tokenize, type Token } from './tokenizer.ts';",
    '',
    'export interface Spec {',
    '  name: string;',
    '  props: Record<string, string>;',
    '}',
    '',
    'export function parse(src: string): Spec[] {',
    '  const tokens = tokenize(src);',
    '  const specs: Spec[] = [];',
    '  let i = 0;',
    '  while (i < tokens.length) {',
    '    const name = tokens[i++].text;',
    '    const props: Record<string, string> = {};',
    "    if (tokens[i]?.text !== '{') throw new ParseError(`expected { after ${name}`, tokens[i - 1].line);",
    '    i++;',
    "    while (tokens[i] && tokens[i].text !== '}') {",
    '      const key = tokens[i].text;',
    '      props[key] = tokens[i + 2].text;',
    '      i += 4;',
    '    }',
    "    if (!tokens[i]) throw new ParseError(`unclosed ${name}`, tokens[i - 1].line);",
    '    i++;',
    '    specs.push({ name, props });',
    '  }',
    '  return specs;',
    '}',
    '',
  ].join('\n'),
});
git('push', '-q', '-u', 'origin', 'feature/parser-errors');

git('switch', '-q', '-c', 'feature/pretty-errors');
commit('Pretty-print parse errors with the offending line', {
  'src/pretty.ts': "import type { ParseError } from './errors.ts';\n\nexport function pretty(e: ParseError, src: string): string {\n  const text = src.split('\\n')[e.line - 1] ?? '';\n  return `${e.message}\\n  ${e.line} | ${text}`;\n}\n",
});
git('push', '-q', '-u', 'origin', 'feature/pretty-errors');

git('switch', '-q', '-c', 'feature/cache', 'main');
commit('Cache built specs by file hash', {
  'src/cache.ts': "const cache = new Map<string, string>();\n\nexport function cached(key: string, make: () => string): string {\n  if (!cache.has(key)) cache.set(key, make());\n  return cache.get(key)!;\n}\n",
});
git('switch', '-q', 'feature/parser-errors');
console.log(`demo repo: ${dir}\nLEGIT_GITHUB_MOCK=1 node bin/legit.ts --dev --no-open --port 4321 ${dir}`);
