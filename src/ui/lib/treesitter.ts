// Tree-sitter highlighting, for files the settings give a grammar (loaded by
// the highlight worker only then). The grammar and its highlights query come from the server;
// capture names (`keyword`, `type.builtin`...) map onto the theme's Prism token classes.

import { Language, Parser, Query } from 'web-tree-sitter';
import runtime from 'web-tree-sitter/web-tree-sitter.wasm?url';

export interface Seg {
  len: number;
  c: string;
}

/** Capture name -> Prism token type; a name without an entry falls back to its prefix (`type.qualifier` -> `type`). */
const TYPES: Record<string, string> = {
  keyword: 'keyword',
  string: 'string',
  'string.escape': 'regex',
  'string.regex': 'regex',
  'string.special': 'regex',
  character: 'char',
  number: 'number',
  float: 'number',
  boolean: 'boolean',
  constant: 'constant',
  comment: 'comment',
  'comment.doc': 'doc-comment',
  function: 'function',
  'function.method': 'method',
  method: 'method',
  'function.macro': 'macro',
  constructor: 'class-name',
  type: 'type',
  'type.builtin': 'builtin-type',
  namespace: 'namespace',
  module: 'namespace',
  'variable.parameter': 'parameter',
  'variable.builtin': 'builtin',
  'variable.member': 'property',
  property: 'property',
  field: 'property',
  attribute: 'annotation',
  label: 'symbol',
  lifetime: 'lifetime-annotation',
  tag: 'tag',
  'tag.attribute': 'attr-name',
  operator: 'operator',
  punctuation: 'punctuation',
  emphasis: 'italic',
  'emphasis.strong': 'bold',
  title: 'title',
  link_uri: 'url',
};

function classOf(capture: string): string {
  for (let n = capture; n; n = n.slice(0, Math.max(0, n.lastIndexOf('.')))) {
    if (n in TYPES) return `t-${TYPES[n]}`;
  }
  return '';
}

let ready: Promise<void> | null = null;
const grammars = new Map<string, Promise<{ parser: Parser; query: Query }>>();

async function get(url: string, what: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${what}: ${((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? res.statusText}`);
  return res;
}

/** Grammar `name`, loaded once (a failure is remembered too, so it isn't retried for every file). */
function grammar(name: string) {
  let g = grammars.get(name);
  if (!g) {
    g = (async () => {
      ready ??= Parser.init({ locateFile: () => runtime });
      await ready;
      const url = (part: string) => `/api/grammar?name=${encodeURIComponent(name)}&part=${part}`;
      const [wasm, scm] = await Promise.all([
        get(url('wasm'), name).then((r) => r.arrayBuffer()),
        get(url('highlights'), name).then((r) => r.text()),
      ]);
      const language = await Language.load(new Uint8Array(wasm));
      const parser = new Parser();
      parser.setLanguage(language);
      return { parser, query: new Query(language, scm) };
    })();
    g.catch((e) => console.warn(`legit: grammar "${name}" didn't load:`, e));
    grammars.set(name, g);
  }
  return g;
}

/**
 * Highlight a block of lines with grammar `name`, as per-line runs. Where captures overlap, the
 * innermost node wins, and for the same node the first pattern in the query (as Zed reads them).
 */
export async function tokenize(name: string, lines: string[]): Promise<Seg[][]> {
  const { parser, query } = await grammar(name);
  const text = lines.join('\n');
  const tree = parser.parse(text);
  if (!tree) throw new Error(`grammar "${name}" didn't parse`);
  const classes = [''];
  const ids = new Map([['', 0]]);
  const paint = new Uint16Array(text.length);
  try {
    const caps = query.captures(tree.rootNode).map((c) => ({
      a: c.node.startIndex,
      b: c.node.endIndex,
      pattern: c.patternIndex,
      c: classOf(c.name),
    }));
    caps.sort((x, y) => y.b - y.a - (x.b - x.a) || y.pattern - x.pattern);
    for (const cap of caps) {
      if (!cap.c) continue;
      let id = ids.get(cap.c);
      if (id === undefined) {
        id = classes.push(cap.c) - 1;
        ids.set(cap.c, id);
      }
      paint.fill(id, cap.a, cap.b);
    }
  } finally {
    tree.delete();
  }
  const out: Seg[][] = [];
  let pos = 0;
  for (const line of lines) {
    const segs: Seg[] = [];
    for (let k = pos; k < pos + line.length; ) {
      let e = k + 1;
      while (e < pos + line.length && paint[e] === paint[k]) e++;
      segs.push({ len: e - k, c: classes[paint[k]] });
      k = e;
    }
    out.push(segs);
    pos += line.length + 1;
  }
  return out;
}
