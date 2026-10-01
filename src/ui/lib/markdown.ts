// Commit messages as markdown, plus `#123`-style references to GitHub issues and pull requests.
// Only lexed here: Markdown.svelte builds elements from the tokens, so a message's HTML is never
// injected, it shows as text.

import { Lexer, Marked, type Token, type Tokens, type TokenizerExtension } from 'marked';

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

/** A title: inline markdown only, so "1. Fix it" or "# Notes" stays text. */
export const lexInline = (text: string): Token[] => Lexer.lexInline(text, marked.defaults);

/** The issue URL a reference points at; null when the repository isn't known. */
export function refUrl(t: RefToken, github: string | null | undefined): string | null {
  const repo = t.repo ?? github;
  return repo ? `https://github.com/${repo}/issues/${t.number}` : null;
}

/** Links worth following from a message: web pages and mail, never `javascript:` or files. */
export function safeHref(href: string): string | null {
  try {
    const u = new URL(href);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

export type { Token, Tokens };
