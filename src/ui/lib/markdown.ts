// Commit messages as markdown, plus `#123`-style references to GitHub issues and pull requests,
// and markdown files as GitHub shows them. Only lexed here: Markdown.svelte (a file's, md-dom.ts) builds
// elements from the tokens, so a message's or a file's HTML is never injected, it shows as text. A file is lexed
// a section at a time (DocLexer), so a big one never holds the thread for long.

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
  const lexer = new DocLexer(text);
  lexer.step(() => true);
  return lexer.tokens;
}

/** A line that may define a link reference (`[x]: url`), maybe in a quote or a list: then a section's
 *  links can't be resolved until the whole file's blocks are lexed. */
const DEF = /^[ \t>*+\-\d.)]*\[(?:\\.|[^\\\]\n])*\]:/m;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const RAW_HTML = /^ {0,3}(?:<(script|pre|style|textarea)(?=[\s>]|$)|(<!--)|(<\?)|(<!\[CDATA\[)|(<![a-z]))/i;
/** A section may start with a line that can't continue anything above it across a blank line. */
const SECTION = /^[a-z#]/i;

/** Where `src` can be cut so its parts lex as the whole does: before a line that starts a heading or a
 *  paragraph after a blank line, outside fences and raw HTML, the parts `size` characters or more. Which of
 *  those lines a cut is at goes by the line (one in 8 will do, up to 2 × `size`), not by where the last cut
 *  was: past an edit, another version of the file is cut at the same lines again, so its parts are the same. */
export function sections(src: string, size: number): number[] {
  const cuts: number[] = [];
  let from = 0;
  let blank = true;
  let fence: RegExp | null = null;
  let html: string | null = null;
  for (let at = 0; at < src.length; ) {
    let end = src.indexOf('\n', at);
    if (end < 0) end = src.length;
    const line = src.slice(at, end);
    if (fence) {
      if (fence.test(line)) fence = null;
    } else if (html) {
      if (line.toLowerCase().includes(html)) html = null;
    } else {
      const f = FENCE.exec(line);
      const h = f ? null : RAW_HTML.exec(line);
      if (f && !(f[1][0] === '`' && f[2].includes('`'))) fence = new RegExp(`^ {0,3}${f[1][0]}{${f[1].length},}[ \\t]*$`);
      else if (h) {
        const close = h[1] ? `</${h[1].toLowerCase()}>` : h[2] ? '-->' : h[3] ? '?>' : h[4] ? ']]>' : '>';
        if (!line.slice(h[0].length).toLowerCase().includes(close)) html = close;
      } else if (blank && at - from >= size && SECTION.test(line) && (at - from >= 2 * size || picked(line))) {
        cuts.push(at);
        from = at;
      }
    }
    blank = !fence && !html && /^[ \t]*$/.test(line);
    at = end + 1;
  }
  return cuts;
}

/** One line in 8 or so, by its text. */
function picked(line: string): boolean {
  let h = 0;
  for (let k = 0; k < line.length && k < 32; k++) h = (Math.imul(h, 31) + line.charCodeAt(k)) | 0;
  return ((h ^ (h >>> 7)) & 7) === 0;
}

/** Lexes a file in steps, a section at a time, so a big one never holds the thread for long; the blocks
 *  come out as `lexDocument`'s would. Each section's links are resolved as soon as it's lexed, unless the
 *  file may define link references: then once all the blocks are. A section another version of the file
 *  lexed already (`share`) is taken as it is: an edit leaves all but a section or two the same. */
export class DocLexer {
  /** The top-level blocks lexed so far, in order. */
  readonly tokens: Token[] = [];
  done = false;
  private lexer = new Lexer(files.defaults);
  private parts: string[];
  private next = 0;
  /** Sections whose blocks are lexed, with where their inline work ends in the lexer's queue. */
  private blocked: { tokens: Token[]; queued: number; shared?: boolean }[] = [];
  /** Another version's lexer, to take sections it lexed from. */
  private donor: DocLexer | null = null;
  /** Its sections by length, and those taken. */
  private donated: Map<number, number[]> | null = null;
  private taken = new Set<number>();
  private emitted = 0;
  private inlined = 0;
  private defer: boolean;

  constructor(text: string, size = 16384) {
    const src = text.replace(/\r\n/g, '\n');
    const front = FRONT_MATTER.exec(src);
    if (front) this.tokens.push({ type: 'code', raw: front[0], text: front[1], lang: 'yaml' } satisfies Tokens.Code);
    const body = (front ? src.slice(front[0].length) : src).replace(/\r/g, '\n');
    const cuts = sections(body, size);
    this.parts = [0, ...cuts].map((at, k) => body.slice(at, cuts[k] ?? body.length));
    this.defer = DEF.test(body);
  }

  /** Take sections `other` (a lexer of another version of this file) has lexed rather than lex them again, when
   *  neither file defines link references (which any section's links may use). */
  share(other: DocLexer) {
    if (other === this || this.defer || other.defer || other === this.donor) return;
    this.donor = other;
    this.taken = new Set();
  }

  /** The blocks of a section of text `part`, if this lexer has it lexed, and once only; never twice to the same `taker`. */
  private lexed(part: string, taker: DocLexer): Token[] | null {
    if (!this.donated) {
      this.donated = new Map();
      this.parts.forEach((p, k) => {
        const same = this.donated!.get(p.length);
        if (same) same.push(k);
        else this.donated!.set(p.length, [k]);
      });
    }
    const like = this.donated.get(part.length)?.filter((k) => this.parts[k] === part) ?? [];
    const k = like.length === 1 ? like[0] : -1;
    if (k < 0 || k >= this.emitted || taker.taken.has(k)) return null;
    taker.taken.add(k);
    return this.blocked[k].tokens;
  }

  /** Lex more while `more()` says so; whether it's all lexed. */
  step(more: () => boolean): boolean {
    const queue = this.lexer.inlineQueue;
    while (!this.done && more()) {
      const b = this.blocked[this.emitted];
      if (b && this.inlined >= b.queued) {
        for (const t of b.tokens) this.tokens.push(b.shared ? t : alert(t));
        this.emitted++;
      } else if (this.inlined < queue.length && (!this.defer || this.next === this.parts.length)) {
        // A few paragraphs before asking again whether there's time: they're quick.
        const end = Math.min(b ? b.queued : queue.length, this.inlined + 8);
        while (this.inlined < end) {
          const q = queue[this.inlined++];
          this.lexer.inlineTokens(q.src, q.tokens);
        }
      } else if (this.next < this.parts.length) {
        const part = this.parts[this.next++];
        const had = this.donor?.lexed(part, this);
        if (had) this.blocked.push({ tokens: had, queued: queue.length, shared: true });
        else {
          const tokens: Token[] = [];
          this.lexer.blockTokens(part, tokens);
          this.blocked.push({ tokens, queued: queue.length });
        }
      } else {
        this.lexer.inlineQueue = [];
        this.done = true;
      }
    }
    return this.done;
  }
}

/** A file's text lexed as far as it got, with each block's lines and anchors: shared by every view of that text. */
export class DocModel {
  readonly text: string;
  private lexer: DocLexer;
  /** Each top-level block's first and last line. */
  readonly lines: [number, number][] = [];
  /** The line each top-level block's raw text starts at, blank lines before it included. */
  readonly from: number[] = [];
  /** Every heading's anchor, as GitHub makes them. */
  readonly slugs = new Map<Token, string>();
  /** The top-level block each anchor is in. */
  readonly anchors = new Map<string, number>();
  private seen = new Set<string>();
  /** The line the next block lexed starts at. */
  private at = 1;

  constructor(text: string) {
    this.text = text;
    this.lexer = new DocLexer(text);
    this.sync();
  }

  /** The top-level blocks lexed so far. */
  get tokens(): readonly Token[] {
    return this.lexer.tokens;
  }

  get length() {
    return this.lexer.tokens.length;
  }

  token(k: number): Token {
    return this.lexer.tokens[k];
  }

  /** The first line of block k. */
  line(k: number): number {
    return this.lines[k][0];
  }

  /** The line block k's text starts at, blank lines before it included. */
  start(k: number): number {
    return this.from[k];
  }

  get done() {
    return this.lexer.done;
  }

  /** Lex more while `more()` says so; whether it's all lexed. */
  step(more: () => boolean): boolean {
    this.lexer.step(more);
    this.sync();
    return this.lexer.done;
  }

  /** Take what `other` (another version of the file) lexed already, where it reads the same. */
  share(other: DocModel) {
    this.lexer.share(other.lexer);
  }

  /** Lines and anchors for the blocks just lexed. */
  private sync() {
    const all = this.lexer.tokens;
    if (this.lines.length < all.length) {
      for (let k = this.lines.length; k < all.length; k++) {
        const t = all[k];
        this.from.push(this.at);
        this.lines.push(blockLines([t], this.at)[0]);
        this.at += newlines(t.raw);
        for (const [h, slug] of headingSlugs([t], new Map(), this.seen)) {
          this.slugs.set(h, slug);
          this.anchors.set(slug, k);
        }
      }
    }
  }

  /** The blocks of block `k` (it, or its list items or table rows) that lines `changed` touch. */
  changed(k: number, changed: ReadonlySet<number>): Set<object> {
    return changedBlocks([this.lexer.tokens[k]], changed, this.from[k]);
  }

  /** Files lexed lately, by text: a few, 3 MB of it in all. */
  private static kept = new Lru<string, DocModel>(8, 3 << 20);

  /** The model of `text`, lexed as far as any view got. */
  static of(text: string): DocModel {
    let m = DocModel.kept.get(text);
    if (!m) DocModel.kept.set(text, (m = new DocModel(text)), text.length);
    return m;
  }

  /** The model of `text`, all of it lexed. */
  static whole(text: string): DocModel {
    const m = DocModel.of(text);
    m.step(() => true);
    return m;
  }
}

/** A `> [!NOTE]` blockquote as an alert, its text lexed again without the marker. */
function alert(t: Token): Token {
  if (t.type !== 'blockquote') return t;
  const a = ALERT.exec(t.text);
  if (a) Object.assign(t, { alert: a[1].toLowerCase(), tokens: files.lexer(t.text.slice(a[0].length)) });
  return t;
}

/** How many line breaks `s` has. */
export const newlines = (s: string) => {
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
export function changedBlocks(tokens: Token[], changed: ReadonlySet<number>, first = 1): Set<object> {
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
  if (changed.size) walk(tokens, first, null);
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

/** GitHub's anchor for each heading (`## Getting started` → `getting-started`, repeats numbered `-1`, `-2`);
 *  given the anchors of the blocks before (`out`, and the anchors taken in `seen`), the next blocks'. */
export function headingSlugs(tokens: readonly Token[], out = new Map<Token, string>(), seen = new Set<string>()): Map<Token, string> {
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
