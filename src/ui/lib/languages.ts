// Which Prism grammar highlights which file, and how to load it (used by the highlight worker).

// Bundled with Prism's core: markup, css, clike, javascript.
export const BUILTIN = new Set(['markup', 'css', 'clike', 'javascript']);

// language -> [dependencies not in core, loader]
export const LANGS: Record<string, [string[], () => Promise<unknown>]> = {
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

