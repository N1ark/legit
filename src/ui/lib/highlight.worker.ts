// Web worker: syntax-highlights a file's hunks with Prism, off the main thread.
//
// In: { id, path, hunks: HunkData[], syntax? }. Out: { id, tokens } where tokens encodes, for
// every row of the file (hunk headers included, empty), runs of [length, class id] over the
// text. Each side (old/new) of a hunk is tokenized as one block so multi-line strings and
// comments come out right. A file with a tree-sitter grammar (`syntax`) uses that instead of
// Prism, falling back to Prism if it can't load. Buffers are transferred, not copied.

import type { Grammar, Token, TokenStream } from 'prismjs';
import type { HunkData } from '../../shared/types.ts';
import { BUILTIN, LANGS, language } from './languages.ts';

type Prism = typeof import('prismjs');

const MAX_CHARS = 2_000_000;
const MAX_LINE = 3_000;

let prism: Promise<Prism> | null = null;
function core(): Promise<Prism> {
  prism ??= (async () => {
    // Don't let Prism install its own worker message handler.
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

interface Seg {
  len: number;
  c: string;
}

function flatten(stream: TokenStream, cls: string, out: { t: string; c: string }[]) {
  if (typeof stream === 'string') {
    out.push({ t: stream, c: cls });
    return;
  }
  for (const tok of (Array.isArray(stream) ? stream : [stream]) as (string | Token)[]) {
    if (typeof tok === 'string') {
      out.push({ t: tok, c: cls });
      continue;
    }
    const alias = tok.alias ? ([] as string[]).concat(tok.alias) : [];
    const c = [cls, ...[tok.type, ...alias].map((x) => `t-${x}`)].filter(Boolean).join(' ');
    flatten(tok.content, c, out);
  }
}

/** Tokenize a block of lines into per-line runs. */
function tokenizeLines(P: Prism, lines: string[], grammar: Grammar): Seg[][] {
  const flat: { t: string; c: string }[] = [];
  flatten(P.tokenize(lines.join('\n'), grammar), '', flat);
  const out: Seg[][] = [[]];
  for (const s of flat) {
    const parts = s.t.split('\n');
    for (let k = 0; k < parts.length; k++) {
      if (k > 0) out.push([]);
      if (parts[k]) out[out.length - 1].push({ len: parts[k].length, c: s.c });
    }
  }
  return out;
}

/** A block of lines with grammar `syntax`, or null when it can't be used. */
async function treeSitter(syntax: string, lines: string[]): Promise<Seg[][] | null> {
  try {
    return await (await import('./treesitter.ts')).tokenize(syntax, lines);
  } catch {
    return null;
  }
}

async function highlight(path: string, hunks: HunkData[], syntax?: string) {
  const lang = language(path);
  if (!lang && !syntax) return null;
  let chars = 0;
  for (const h of hunks) {
    for (const t of h.text) {
      if (t.length > MAX_LINE) return null;
      chars += t.length;
    }
  }
  if (chars > MAX_CHARS) return null;
  // Tree-sitter when the file has a grammar and it loads (tried on the first hunk), else Prism.
  let tokenizeSide: (lines: string[]) => Promise<Seg[][]> | Seg[][];
  const first = syntax && hunks.length ? await treeSitter(syntax, hunks[0].text.filter((_, k) => hunks[0].types[k] !== '-')) : null;
  if (first) tokenizeSide = async (lines) => (await treeSitter(syntax!, lines)) ?? lines.map(() => []);
  else {
    if (!lang) return null;
    await load(lang);
    const P = await core();
    const grammar = P.languages[lang];
    if (!grammar) return null;
    tokenizeSide = (lines) => tokenizeLines(P, lines, grammar);
  }

  const classes = [''];
  const ids = new Map([['', 0]]);
  const rows = hunks.reduce((n, h) => n + h.text.length + 1, 0);
  const offsets = new Uint32Array(rows + 1);
  const data: number[] = [];
  let r = 0;
  for (const h of hunks) {
    offsets[r++] = data.length; // hunk header: no tokens
    const oldSide = await tokenizeSide(h.text.filter((_, k) => h.types[k] !== '+'));
    const newSide = await tokenizeSide(h.text.filter((_, k) => h.types[k] !== '-'));
    let o = 0;
    let n = 0;
    for (let k = 0; k < h.text.length; k++) {
      offsets[r++] = data.length;
      const t = h.types[k];
      const segs = t === '-' ? oldSide[o++] : t === '+' ? newSide[n++] : (o++, newSide[n++]);
      for (const s of segs ?? []) {
        let id = ids.get(s.c);
        if (id === undefined) {
          id = classes.push(s.c) - 1;
          ids.set(s.c, id);
        }
        data.push(s.len, id);
      }
    }
  }
  offsets[r] = data.length;
  return { classes, offsets, data: Uint32Array.from(data) };
}

self.onmessage = async (e: MessageEvent<{ id: number; path: string; hunks: HunkData[]; syntax?: string }>) => {
  const { id, path, hunks, syntax } = e.data;
  let tokens = null;
  try {
    tokens = await highlight(path, hunks, syntax);
  } catch {
    // Unhighlighted is fine.
  }
  (self as unknown as Worker).postMessage({ id, tokens }, tokens ? [tokens.offsets.buffer, tokens.data.buffer] : []);
};
