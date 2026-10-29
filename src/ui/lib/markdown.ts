// Commit messages as markdown, plus `#123`-style references to GitHub issues and pull requests,
// and markdown files as GitHub shows them. Only lexed here: Markdown.svelte builds elements from
// the tokens, so a message's or a file's HTML is never injected, it shows as text.

import { Lexer, Marked, type Token, type Tokens, type TokenizerExtension } from 'marked';
import { Lru } from './cache.ts';

export interface RefToken {
  type: 'ref';
  raw: string;
  /** `owner/repo` when the reference names one, else the current repository's. */
  repo?: string;
  number: string;
}

/** `#123`, `GH-123` or `owner/repo#123`, not inside a word (`abc#1`) or an entity (`&#123;`). */
const REF = /^(?:([\w.-]+\/[\w.-]+)#|#|GH-)(\d+)(?![\w-])/;
const REF_START = /(?<![\w&/.-])(?:[\w.-]+\/[\w.-]+#|#|GH-)\d/;

const ref: TokenizerExtension = {
  name: 'ref',
  level: 'inline',
  start: (src) => {
    const i = src.search(REF_START);
    return i < 0 ? undefined : i;
  },
  tokenizer(src) {
    const m = REF.exec(src);
    if (m) return { type: 'ref', raw: m[0], repo: m[1], number: m[2] } satisfies RefToken;
  },
};

const marked = new Marked({ gfm: true, breaks: false, extensions: [ref] });

/** A whole message: paragraphs, lists, code blocks... */
export const lexBlocks = (text: string): Token[] => marked.lexer(text);

/** Titles lexed lately: a list row lexes its commit's title again each time it scrolls into view. */
const inline = new Lru<string, Token[]>(2000);

/** A title: inline markdown only, so "1. Fix it" or "# Notes" stays text. The tokens are shared: read them, don't change them. */
export function lexInline(text: string): Token[] {
  let t = inline.get(text);
  if (!t) inline.set(text, (t = Lexer.lexInline(text, marked.defaults)));
  return t;
}

/** The issue URL a reference points at; null when the repository isn't known. */
export function refUrl(t: RefToken, github: string | null | undefined): string | null {
  const repo = t.repo ?? github;
  return repo ? `https://github.com/${repo}/issues/${t.number}` : null;
}

/** Links worth following from a message: web pages and mail, never `javascript:` or files. */
export function safeHref(href: string): string | null {
  // Without a scheme it's relative: no URL, and throwing to say so is slow (a file has hundreds).
  if (!/^(https?|mailto):/i.test(href)) return null;
  try {
    const u = new URL(href);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

// ---- Files -------------------------------------------------------------------------------------

/** A file's markdown: no issue references (GitHub doesn't link them in files). */
const files = new Marked({ gfm: true, breaks: false });

export type AlertKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';

/** A `> [!NOTE]` blockquote, lexed without its marker line. */
export interface Alert extends Tokens.Blockquote {
  alert: AlertKind;
}

const FRONT_MATTER = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;
const ALERT = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i;

/** A markdown file's blocks: YAML front matter as a code block, GitHub's alerts marked as such. */
export function lexDocument(text: string): Token[] {
  const src = text.replace(/\r\n/g, '\n');
  const front = FRONT_MATTER.exec(src);
  const tokens = files.lexer(front ? src.slice(front[0].length) : src);
  for (const t of tokens) {
    if (t.type !== 'blockquote') continue;
    const q = t as Tokens.Blockquote;
    const a = ALERT.exec(q.text);
    if (a) Object.assign(q, { alert: a[1].toLowerCase(), tokens: files.lexer(q.text.slice(a[0].length)) });
  }
  if (front) tokens.unshift({ type: 'code', raw: front[0], text: front[1], lang: 'yaml' } satisfies Tokens.Code);
  return tokens;
}

const newlines = (s: string) => {
  let n = 0;
  for (let k = s.indexOf('\n'); k >= 0; k = s.indexOf('\n', k + 1)) n++;
  return n;
};

/** Each token's first and last line (1-based, from `first`), counting the newlines of the tokens before it. */
export function blockLines(tokens: readonly { raw: string }[], first = 1): [number, number][] {
  let line = first;
  return tokens.map(({ raw }) => {
    const body = raw.replace(/^\n+/, '');
    const start = line + raw.length - body.length;
    line += newlines(raw);
    return [start, start + newlines(body.replace(/\n+$/, ''))];
  });
}

/** What a diff changed, as the blocks to mark: top-level blocks with a changed line, but in a list
 *  the items with one (in their own text, a nested list marking its own items) and in a table the
 *  rows (the header's cells, or a row's, which are one line each). */
export function changedBlocks(tokens: Token[], changed: ReadonlySet<number>): Set<object> {
  const out = new Set<object>();
  const hit = (s: number, e: number) => {
    for (let l = s; l <= e; l++) if (changed.has(l)) return true;
    return false;
  };
  const walk = (list: Token[], first: number, item: Tokens.ListItem | null) => {
    blockLines(list, first).forEach(([s, e], k) => {
      const t = list[k];
      if (t.type === 'list') {
        const items = (t as Tokens.List).items;
        blockLines(items, s).forEach(([from], j) => walk(items[j].tokens, from, items[j]));
      } else if (t.type === 'table' && !item) {
        const tb = t as Tokens.Table;
        if (hit(s, s + 1)) out.add(tb.header);
        tb.rows.forEach((row, j) => hit(s + 2 + j, s + 2 + j) && out.add(row));
      } else if (t.type !== 'space' && t.type !== 'def' && hit(s, e)) out.add(item ?? t);
    });
  };
  if (changed.size) walk(tokens, 1, null);
  return out;
}

/** Text without its markup, as a heading's anchor is made from. */
export function plainText(tokens: readonly Token[]): string {
  let out = '';
  for (const t of tokens) {
    if ('tokens' in t && t.tokens) out += plainText(t.tokens);
    else if (t.type === 'text' || t.type === 'codespan' || t.type === 'escape') out += t.text;
    else if (t.type === 'image') out += (t as Tokens.Image).text;
  }
  return out;
}

/** GitHub's anchor for each heading (`## Getting started` → `getting-started`, repeats numbered `-1`, `-2`). */
export function headingSlugs(tokens: Token[]): Map<Token, string> {
  const out = new Map<Token, string>();
  const seen = new Set<string>();
  const walk = (list: readonly Token[]) => {
    for (const t of list) {
      if (t.type === 'heading') {
        const base = plainText((t as Tokens.Heading).tokens)
          .toLowerCase()
          .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
          .replace(/ /g, '-');
        let slug = base;
        for (let n = 1; seen.has(slug); n++) slug = `${base}-${n}`;
        seen.add(slug);
        out.set(t, slug);
      } else if (t.type === 'blockquote') walk((t as Tokens.Blockquote).tokens);
      else if (t.type === 'list') for (const item of (t as Tokens.List).items) walk(item.tokens);
    }
  };
  walk(tokens);
  return out;
}

export type DocLink = { kind: 'url'; href: string } | { kind: 'anchor'; slug: string } | { kind: 'file'; path: string };

const decodeUri = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Where a link in the file at `path` goes: a web page, one of the file's headings, or a file of
 *  the repository, resolved from the file's folder; null for anything else (`javascript:`, `file:`). */
export function docLink(href: string, path: string): DocLink | null {
  if (href.startsWith('#')) return { kind: 'anchor', slug: decodeUri(href.slice(1)).toLowerCase() };
  const url = safeHref(href);
  if (url) return { kind: 'url', href: url };
  const file = href.replace(/[?#].*$/, '');
  if (!file || /^([a-z][\w+.-]*:|\/\/)/i.test(file)) return null;
  const parts = file.startsWith('/') ? [] : path.split('/').slice(0, -1);
  for (const p of decodeUri(file).split('/')) {
    if (p === '..') parts.pop();
    else if (p && p !== '.') parts.push(p);
  }
  return { kind: 'file', path: parts.join('/') };
}

export type { Token, Tokens };
