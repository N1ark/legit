// Tree-sitter grammars for files Prism doesn't highlight (or highlights wrongly), by glob, from
// the settings. A grammar is one of Zed's (the name of a grammar or language in its installed
// extensions, e.g. `ullbc`), or a folder with a compiled grammar (`*.wasm`, from
// `tree-sitter build --wasm`) and its `highlights.scm`.

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, matchesGlob, resolve } from 'node:path';
import { normalize } from './generated.ts';
import type { ScopeSettings, ZedGrammar } from '../shared/types.ts';
import { type Git, GitError, toUtf8 } from './git.ts';

type Rules = ScopeSettings['syntax'];

/** The grammar of each of `paths` (byte strings) that has one; the last matching rule wins. */
export function syntaxes(rules: Rules, paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const globs = rules.map((r) => ({ glob: normalize(r.pattern), grammar: r.grammar }));
  for (const p of globs.length ? paths : []) {
    const name = toUtf8(p);
    for (const r of globs) if (matchesGlob(name, r.glob)) out.set(p, r.grammar);
  }
  return out;
}

const zedExtensions = () =>
  process.platform === 'darwin'
    ? join(homedir(), 'Library/Application Support/Zed/extensions/installed')
    : join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'zed/extensions/installed');

const list = (dir: string) => readdir(dir).catch(() => [] as string[]);
const field = (toml: string, key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(toml)?.[1];

/** Every grammar in Zed's installed extensions that comes with highlights, for the settings page. */
export async function zedGrammars(): Promise<ZedGrammar[]> {
  const root = zedExtensions();
  const out: ZedGrammar[] = [];
  for (const ext of await list(root)) {
    const dir = join(root, ext);
    for (const lang of await list(join(dir, 'languages'))) {
      const toml = await readFile(join(dir, 'languages', lang, 'config.toml'), 'utf8').catch(() => '');
      const grammar = field(toml, 'grammar');
      if (!grammar || !existsSync(join(dir, 'grammars', `${grammar}.wasm`))) continue;
      if (!existsSync(join(dir, 'languages', lang, 'highlights.scm'))) continue;
      const suffixes = /^path_suffixes\s*=\s*\[([^\]]*)\]/m.exec(toml)?.[1].match(/"[^"]*"/g)?.map((x) => x.slice(1, -1)) ?? [];
      out.push({ grammar, language: field(toml, 'name') ?? grammar, suffixes });
    }
  }
  return out.sort((a, b) => a.language.localeCompare(b.language));
}

/** A grammar in Zed's installed extensions, by grammar name or language name. */
async function fromZed(name: string): Promise<{ wasm: string; highlights: string } | null> {
  const root = zedExtensions();
  const want = name.toLowerCase();
  for (const ext of await list(root)) {
    const dir = join(root, ext);
    for (const lang of await list(join(dir, 'languages'))) {
      const toml = await readFile(join(dir, 'languages', lang, 'config.toml'), 'utf8').catch(() => '');
      const grammar = field(toml, 'grammar');
      if (!grammar || (grammar.toLowerCase() !== want && field(toml, 'name')?.toLowerCase() !== want)) continue;
      const wasm = join(dir, 'grammars', `${grammar}.wasm`);
      const highlights = join(dir, 'languages', lang, 'highlights.scm');
      if (existsSync(wasm) && existsSync(highlights)) return { wasm, highlights };
    }
  }
  return null;
}

/** A folder with a compiled grammar and its highlights query (a grammar's repo, or a Zed extension). */
async function fromFolder(dir: string): Promise<{ wasm: string; highlights: string } | null> {
  const first = async (dirs: string[], ok: (f: string) => boolean) => {
    for (const d of dirs) for (const f of await list(d)) if (ok(f)) return join(d, f);
    return null;
  };
  const wasm = await first([dir, join(dir, 'grammars')], (f) => f.endsWith('.wasm'));
  const langs = (await list(join(dir, 'languages'))).map((l) => join(dir, 'languages', l));
  const highlights = await first([dir, join(dir, 'queries'), ...langs], (f) => f === 'highlights.scm');
  return wasm && highlights ? { wasm, highlights } : null;
}

/** Where grammar `name`'s files are (a folder's relative to the repo), or why it can't be used. */
async function findGrammar(git: Git, name: string): Promise<{ wasm: string; highlights: string }> {
  const path = name.startsWith('~/') ? join(homedir(), name.slice(2)) : name;
  const found = /[/\\]/.test(path) ? await fromFolder(isAbsolute(path) ? path : resolve(git.root, path)) : await fromZed(name);
  if (!found) {
    throw new GitError(
      /[/\\]/.test(path)
        ? `No grammar (*.wasm) and highlights.scm in ${name}.`
        : `No grammar "${name}" in Zed's installed extensions (${zedExtensions()}).`,
    );
  }
  return found;
}

/** Why each grammar the rules use can't be used, for those that can't. */
export async function grammarProblems(git: Git, rules: Rules): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of new Set(rules.map((r) => r.grammar))) {
    await findGrammar(git, name).catch((e) => (out[name] = e instanceof Error ? e.message : String(e)));
  }
  return out;
}

/** Grammar `name`'s files, if a rule uses it. */
export async function grammarFiles(git: Git, rules: Rules, name: string): Promise<{ wasm: Buffer; highlights: string }> {
  if (!rules.some((r) => r.grammar === name)) throw new GitError(`No syntax highlighting rule uses "${name}".`);
  const found = await findGrammar(git, name);
  const [wasm, highlights] = await Promise.all([readFile(found.wasm), readFile(found.highlights, 'utf8')]);
  return { wasm: withoutNeeded(wasm), highlights };
}

/**
 * The module with its dylink.0 section's list of needed libraries removed. Grammars built by
 * Zed name `libc.so` there without importing anything from it, and web-tree-sitter would try to
 * load it; whatever a grammar does import comes from web-tree-sitter itself.
 */
export function withoutNeeded(b: Buffer): Buffer {
  const leb = (p: number): [number, number] => {
    let v = 0;
    let s = 0;
    let x;
    do {
      x = b[p++];
      v |= (x & 0x7f) << s;
      s += 7;
    } while (x & 0x80);
    return [v >>> 0, p];
  };
  const enc = (v: number) => {
    const o: number[] = [];
    do {
      let x = v & 0x7f;
      v >>>= 7;
      if (v) x |= 0x80;
      o.push(x);
    } while (v);
    return Buffer.from(o);
  };
  for (let p = 8; p < b.length; ) {
    const [size, q] = leb(p + 1);
    const end = q + size;
    if (b[p] === 0) {
      const [len, r] = leb(q);
      if (b.toString('utf8', r, r + len) === 'dylink.0') {
        const subs: Buffer[] = [];
        for (let s = r + len; s < end; ) {
          const [n, u] = leb(s + 1);
          if (b[s] !== 2) subs.push(b.subarray(s, u + n)); // 2: WASM_DYLINK_NEEDED
          s = u + n;
        }
        const body = Buffer.concat([b.subarray(q, r + len), ...subs]);
        return Buffer.concat([b.subarray(0, p), Buffer.from([0]), enc(body.length), body, b.subarray(end)]);
      }
    }
    p = end;
  }
  return b;
}
