// Syntax highlighting for diffs with Prism. Grammars load lazily per language; each side
// (old/new) of a hunk is tokenized as one block so multi-line strings and comments come out right.

import type { FileDiff } from '../../shared/types.ts';

/** A run of text with its token classes (empty for plain text). */
export interface Seg {
  t: string;
  c: string;
}

/** Segments per line, per hunk, parallel to `FileDiff.hunks[h].lines`. */
export type FileTokens = Seg[][][];

type Prism = typeof import('prismjs');
type Token = import('prismjs').Token;
type TokenStream = import('prismjs').TokenStream;

// Bundled with Prism's core: markup, css, clike, javascript.
const BUILTIN = new Set(['markup', 'css', 'clike', 'javascript']);

// language -> [dependencies not in core, loader]
const LANGS: Record<string, [string[], () => Promise<unknown>]> = {
  typescript: [[], () => import('prismjs/components/prism-typescript.js')],
  jsx: [[], () => import('prismjs/components/prism-jsx.js')],
  tsx: [['jsx', 'typescript'], () => import('prismjs/components/prism-tsx.js')],
  python: [[], () => import('prismjs/components/prism-python.js')],
  rust: [[], () => import('prismjs/components/prism-rust.js')],
  go: [[], () => import('prismjs/components/prism-go.js')],
  java: [[], () => import('prismjs/components/prism-java.js')],
  c: [[], () => import('prismjs/components/prism-c.js')],
  cpp: [['c'], () => import('prismjs/components/prism-cpp.js')],
  objectivec: [['c'], () => import('prismjs/components/prism-objectivec.js')],
  glsl: [['c'], () => import('prismjs/components/prism-glsl.js')],
  csharp: [[], () => import('prismjs/components/prism-csharp.js')],
  ruby: [[], () => import('prismjs/components/prism-ruby.js')],
  'markup-templating': [[], () => import('prismjs/components/prism-markup-templating.js')],
  php: [['markup-templating'], () => import('prismjs/components/prism-php.js')],
  swift: [[], () => import('prismjs/components/prism-swift.js')],
  kotlin: [[], () => import('prismjs/components/prism-kotlin.js')],
  scala: [['java'], () => import('prismjs/components/prism-scala.js')],
  groovy: [[], () => import('prismjs/components/prism-groovy.js')],
  dart: [[], () => import('prismjs/components/prism-dart.js')],
  haskell: [[], () => import('prismjs/components/prism-haskell.js')],
  idris: [['haskell'], () => import('prismjs/components/prism-idris.js')],
  purescript: [['haskell'], () => import('prismjs/components/prism-purescript.js')],
  agda: [[], () => import('prismjs/components/prism-agda.js')],
  ocaml: [[], () => import('prismjs/components/prism-ocaml.js')],
  sml: [[], () => import('prismjs/components/prism-sml.js')],
  fsharp: [[], () => import('prismjs/components/prism-fsharp.js')],
  coq: [[], () => import('prismjs/components/prism-coq.js')],
  elm: [[], () => import('prismjs/components/prism-elm.js')],
  lisp: [[], () => import('prismjs/components/prism-lisp.js')],
  scheme: [[], () => import('prismjs/components/prism-scheme.js')],
  racket: [['scheme'], () => import('prismjs/components/prism-racket.js')],
  clojure: [[], () => import('prismjs/components/prism-clojure.js')],
  elixir: [[], () => import('prismjs/components/prism-elixir.js')],
  erlang: [[], () => import('prismjs/components/prism-erlang.js')],
  zig: [[], () => import('prismjs/components/prism-zig.js')],
  nim: [[], () => import('prismjs/components/prism-nim.js')],
  r: [[], () => import('prismjs/components/prism-r.js')],
  julia: [[], () => import('prismjs/components/prism-julia.js')],
  lua: [[], () => import('prismjs/components/prism-lua.js')],
  perl: [[], () => import('prismjs/components/prism-perl.js')],
  solidity: [[], () => import('prismjs/components/prism-solidity.js')],
  verilog: [[], () => import('prismjs/components/prism-verilog.js')],
  wasm: [[], () => import('prismjs/components/prism-wasm.js')],
  bash: [[], () => import('prismjs/components/prism-bash.js')],
  powershell: [[], () => import('prismjs/components/prism-powershell.js')],
  vim: [[], () => import('prismjs/components/prism-vim.js')],
  json: [[], () => import('prismjs/components/prism-json.js')],
  yaml: [[], () => import('prismjs/components/prism-yaml.js')],
  toml: [[], () => import('prismjs/components/prism-toml.js')],
  ini: [[], () => import('prismjs/components/prism-ini.js')],
  hcl: [[], () => import('prismjs/components/prism-hcl.js')],
  nix: [[], () => import('prismjs/components/prism-nix.js')],
  markdown: [[], () => import('prismjs/components/prism-markdown.js')],
  latex: [[], () => import('prismjs/components/prism-latex.js')],
  scss: [[], () => import('prismjs/components/prism-scss.js')],
  sql: [[], () => import('prismjs/components/prism-sql.js')],
  graphql: [[], () => import('prismjs/components/prism-graphql.js')],
  protobuf: [[], () => import('prismjs/components/prism-protobuf.js')],
  docker: [[], () => import('prismjs/components/prism-docker.js')],
  makefile: [[], () => import('prismjs/components/prism-makefile.js')],
  cmake: [[], () => import('prismjs/components/prism-cmake.js')],
  diff: [[], () => import('prismjs/components/prism-diff.js')],
};

const EXT: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', svelte: 'markup', vue: 'markup', astro: 'markup',
  css: 'css', scss: 'scss', sass: 'scss', less: 'scss',
  py: 'python', pyi: 'python', rs: 'rust', go: 'go', java: 'java',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', m: 'objectivec', mm: 'objectivec',
  glsl: 'glsl', vert: 'glsl', frag: 'glsl', cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift',
  kt: 'kotlin', kts: 'kotlin', scala: 'scala', sc: 'scala', groovy: 'groovy', gradle: 'groovy', dart: 'dart',
  hs: 'haskell', lhs: 'haskell', idr: 'idris', purs: 'purescript', agda: 'agda',
  ml: 'ocaml', mli: 'ocaml', mll: 'ocaml', mly: 'ocaml', sml: 'sml', sig: 'sml', fs: 'fsharp', fsi: 'fsharp', fsx: 'fsharp',
  v: 'coq', elm: 'elm', lisp: 'lisp', el: 'lisp', smt2: 'lisp', scm: 'scheme', ss: 'scheme', rkt: 'racket',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure', edn: 'clojure', ex: 'elixir', exs: 'elixir', erl: 'erlang', hrl: 'erlang',
  zig: 'zig', nim: 'nim', r: 'r', jl: 'julia', lua: 'lua', pl: 'perl', pm: 'perl', sol: 'solidity',
  sv: 'verilog', svh: 'verilog', vh: 'verilog', wat: 'wasm',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ps1: 'powershell', vim: 'vim',
  json: 'json', jsonc: 'json', json5: 'json', webmanifest: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  ini: 'ini', cfg: 'ini', conf: 'ini', tf: 'hcl', hcl: 'hcl', nix: 'nix',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown', tex: 'latex', sty: 'latex', cls: 'latex', bib: 'latex',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'protobuf', cmake: 'cmake',
  diff: 'diff', patch: 'diff', mk: 'makefile',
};

const NAMES: Record<string, string> = {
  Dockerfile: 'docker', Containerfile: 'docker', Makefile: 'makefile', GNUmakefile: 'makefile',
  'CMakeLists.txt': 'cmake', Gemfile: 'ruby', Rakefile: 'ruby', '.bashrc': 'bash', '.zshrc': 'bash',
  '.gitconfig': 'ini', '.editorconfig': 'ini', dune: 'lisp', 'dune-project': 'lisp', 'Cargo.lock': 'toml',
};

export function language(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (NAMES[base]) return NAMES[base];
  if (base.startsWith('Dockerfile')) return 'docker';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? (EXT[base.slice(dot + 1).toLowerCase()] ?? null) : null;
}

let prism: Promise<Prism> | null = null;
function core(): Promise<Prism> {
  prism ??= (async () => {
    // Don't let Prism scan the page on its own.
    (globalThis as any).Prism = { manual: true, disableWorkerMessageHandler: true };
    const P = (await import('prismjs')).default;
    (globalThis as any).Prism = P; // grammars register themselves on the global
    return P;
  })();
  return prism;
}

const loading = new Map<string, Promise<void>>();
function load(lang: string): Promise<void> {
  if (BUILTIN.has(lang)) return core().then(() => {});
  let p = loading.get(lang);
  if (!p) {
    const [deps, imp] = LANGS[lang];
    p = (async () => {
      await core();
      for (const d of deps) await load(d);
      await imp();
    })();
    loading.set(lang, p);
  }
  return p;
}

function flatten(stream: TokenStream, cls: string, out: Seg[]) {
  if (typeof stream === 'string') {
    out.push({ t: stream, c: cls });
    return;
  }
  if (!Array.isArray(stream)) stream = [stream];
  for (const tok of stream as (string | Token)[]) {
    if (typeof tok === 'string') {
      out.push({ t: tok, c: cls });
      continue;
    }
    const alias = tok.alias ? ([] as string[]).concat(tok.alias) : [];
    const c = [cls, ...[tok.type, ...alias].map((x) => `t-${x}`)].filter(Boolean).join(' ');
    flatten(tok.content, c, out);
  }
}

/** Tokenize a block of text into per-line segments. */
function tokenizeLines(P: Prism, text: string, grammar: import('prismjs').Grammar): Seg[][] {
  const segs: Seg[] = [];
  flatten(P.tokenize(text, grammar), '', segs);
  const lines: Seg[][] = [[]];
  for (const s of segs) {
    const parts = s.t.split('\n');
    parts.forEach((t, i) => {
      if (i > 0) lines.push([]);
      if (t) lines[lines.length - 1].push({ t, c: s.c });
    });
  }
  return lines;
}

const MAX_CHARS = 400_000;
const MAX_LINE = 2_000;
const cache = new Map<string, FileTokens | null>();

/** Token segments for every line of a file's hunks, or null if it isn't highlighted. */
export async function highlight(sha: string, f: FileDiff): Promise<FileTokens | null> {
  const key = `${sha}\0${f.path}`;
  if (cache.has(key)) return cache.get(key)!;
  const lang = language(f.path);
  let chars = 0;
  let long = false;
  for (const h of f.hunks) {
    for (const l of h.lines) {
      chars += l.s.length;
      if (l.s.length > MAX_LINE) long = true;
    }
  }
  let result: FileTokens | null = null;
  if (lang && !f.binary && !long && chars <= MAX_CHARS) {
    await load(lang);
    const P = await core();
    const grammar = P.languages[lang];
    if (grammar) {
      result = f.hunks.map((h) => {
        const old = tokenizeLines(P, h.lines.filter((l) => l.t !== '+').map((l) => l.s).join('\n'), grammar);
        const neu = tokenizeLines(P, h.lines.filter((l) => l.t !== '-').map((l) => l.s).join('\n'), grammar);
        let o = 0;
        let n = 0;
        return h.lines.map((l) => {
          if (l.t === '-') return old[o++];
          if (l.t === '+') return neu[n++];
          o++;
          return neu[n++];
        });
      });
    }
  }
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
}
