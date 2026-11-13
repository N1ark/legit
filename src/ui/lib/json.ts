// A JSON text read lazily, as a tree view opens it: a container's members are found when it's
// opened, by scanning its own text, so a big file shows at once and costs only what's shown. Each
// value keeps where it is (offsets and lines), to mark what a diff changed. Lenient where config
// files are (tsconfig.json, VS Code's settings): comments and trailing commas are passed over.

export type JsonKind = 'object' | 'array' | 'string' | 'number' | 'true' | 'false' | 'null';

export interface JsonNode {
  /** Its key in its object, or its index in its array; null for the top value. */
  key: string | number | null;
  kind: JsonKind;
  /** Its value's text: [start, end), and its first and last lines (1-based). */
  start: number;
  end: number;
  line: number;
  last: number;
}

export class JsonError extends Error {
  /** The line it's on (1-based). */
  line: number;
  constructor(message: string, line: number) {
    super(message);
    this.line = line;
  }
}

const NL = 10;

/** Past whitespace and comments from i: where the next token is, and its line. */
function skip(text: string, i: number, line: number): [number, number] {
  for (;;) {
    const c = text.charCodeAt(i);
    if (c === NL) line++;
    else if (c === 32 || c === 9 || c === 13 || c === 0xfeff) {
      // Whitespace.
    } else if (c === 47 && text.charCodeAt(i + 1) === 47) {
      const e = text.indexOf('\n', i);
      if (e < 0) return [text.length, line];
      i = e - 1;
    } else if (c === 47 && text.charCodeAt(i + 1) === 42) {
      const e = text.indexOf('*/', i + 2);
      if (e < 0) throw new JsonError('Unclosed comment', line);
      for (let k = text.indexOf('\n', i); k >= 0 && k < e; k = text.indexOf('\n', k + 1)) line++;
      i = e + 1;
    } else return [i, line];
    i++;
  }
}

/** The end of the string whose opening quote is at i (past its closing one). */
function stringEnd(text: string, i: number, line: number): number {
  for (let k = i + 1; k < text.length; k++) {
    const c = text.charCodeAt(k);
    if (c === 34) return k + 1;
    if (c === 92) k++;
    else if (c === NL) break;
  }
  throw new JsonError('Unclosed string', line);
}

const LITERAL = /[-+0-9.eEa-zA-Z]/y;

/** The value starting at i: its kind, end and last line. */
function value(text: string, i: number, line: number): { kind: JsonKind; end: number; last: number } {
  const c = text[i];
  if (c === '"') return { kind: 'string', end: stringEnd(text, i, line), last: line };
  if (c === '{' || c === '[') {
    // Matched bracket by bracket, past strings and comments, counting lines.
    const closers: number[] = [];
    let last = line;
    for (let k = i; k < text.length; k++) {
      const ch = text.charCodeAt(k);
      if (ch === 34) k = stringEnd(text, k, last) - 1;
      else if (ch === 47 && (text.charCodeAt(k + 1) === 47 || text.charCodeAt(k + 1) === 42)) {
        [k, last] = skip(text, k, last);
        k--;
      } else if (ch === NL) last++;
      else if (ch === 123) closers.push(125);
      else if (ch === 91) closers.push(93);
      else if (ch === 125 || ch === 93) {
        if (closers.pop() !== ch) throw new JsonError(`Unexpected ${text[k]}`, last);
        if (!closers.length) return { kind: c === '{' ? 'object' : 'array', end: k + 1, last };
      }
    }
    throw new JsonError(`Unclosed ${c === '{' ? 'object' : 'array'}`, line);
  }
  let end = i;
  LITERAL.lastIndex = i;
  while (LITERAL.test(text)) end = LITERAL.lastIndex;
  const word = text.slice(i, end);
  if (word === 'true' || word === 'false' || word === 'null') return { kind: word, end, last: line };
  if (word && /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(word)) return { kind: 'number', end, last: line };
  throw new JsonError(i >= text.length ? 'Unexpected end' : `Unexpected ${JSON.stringify(word || text[i])}`, line);
}

/** The text's one value; a JsonError when it has none, or more after it. */
export function readJson(text: string): JsonNode {
  const [i, line] = skip(text, 0, 1);
  const v = value(text, i, line);
  const [after, at] = skip(text, v.end, v.last);
  if (after < text.length) throw new JsonError('Unexpected text after the value', at);
  return { key: null, kind: v.kind, start: i, end: v.end, line, last: v.last };
}

export const isContainer = (n: JsonNode) => n.kind === 'object' || n.kind === 'array';

/** A container's members, in order; a JsonError where they don't read. */
export function members(text: string, node: JsonNode): JsonNode[] {
  const out: JsonNode[] = [];
  const object = node.kind === 'object';
  const close = object ? '}' : ']';
  let [i, line] = skip(text, node.start + 1, node.line);
  for (;;) {
    if (text[i] === close) return out;
    let key: string | number = out.length;
    if (object) {
      if (text[i] !== '"') throw new JsonError('Expected a key', line);
      const e = stringEnd(text, i, line);
      key = JSON.parse(text.slice(i, e)) as string;
      [i, line] = skip(text, e, line);
      if (text[i] !== ':') throw new JsonError('Expected :', line);
      [i, line] = skip(text, i + 1, line);
    }
    const v = value(text, i, line);
    out.push({ key, kind: v.kind, start: i, end: v.end, line, last: v.last });
    [i, line] = skip(text, v.end, v.last);
    if (text[i] === ',') [i, line] = skip(text, i + 1, line);
    else if (text[i] !== close) throw new JsonError(`Expected , or ${close}`, line);
  }
}

/** A scalar as it reads: a string's text unquoted, else its literal. */
export function scalar(text: string, node: JsonNode): string {
  const raw = text.slice(node.start, node.end);
  return node.kind === 'string' ? (JSON.parse(raw) as string) : raw;
}

/** The value as JSON, indented two spaces: numbers and strings as written, comments and trailing commas left out. */
export function pretty(text: string, node: JsonNode, indent = ''): string {
  if (!isContainer(node)) return text.slice(node.start, node.end);
  const [open, close] = node.kind === 'object' ? ['{', '}'] : ['[', ']'];
  const list = members(text, node);
  if (!list.length) return open + close;
  const inner = indent + '  ';
  const parts = list.map((m) => inner + (node.kind === 'object' ? JSON.stringify(m.key) + ': ' : '') + pretty(text, m, inner));
  return `${open}\n${parts.join(',\n')}\n${indent}${close}`;
}

/** A member's path from the top, as JavaScript reads it: `$.compilerOptions.paths["@/*"][0]`. */
export function pathOf(keys: (string | number)[]): string {
  let out = '$';
  for (const k of keys) out += typeof k === 'number' ? `[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`;
  return out;
}
