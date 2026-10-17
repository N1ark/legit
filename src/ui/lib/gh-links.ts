// GitHub URLs (pages of a repository, permalinks to lines) and `#123` references: what one's state
// is called, and the `#text` being typed in a message, to suggest issues for.

import type { IssueRef } from '../../shared/gh-issues.ts';

/** A repository's page on GitHub, or one of its tabs. */
export const repoUrl = (repo: string, tab?: 'issues' | 'pulls' | 'actions') => `https://github.com/${repo}${tab ? `/${tab}` : ''}`;

/** The first and last of some line numbers (0s, lines a side doesn't have, are ignored); null if none. */
export function lineSpan(lines: Iterable<number>): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of lines) {
    if (n <= 0) continue;
    lo = Math.min(lo, n);
    hi = Math.max(hi, n);
  }
  return lo === Infinity ? null : [lo, hi];
}

/** A permalink to `path` as of commit `sha`, at a line or a span of lines (`#L10-L14`). */
export function blobUrl(repo: string, sha: string, path: string, span?: [number, number] | null): string {
  const file = path.split('/').map(encodeURIComponent).join('/');
  const at = !span ? '' : span[0] === span[1] ? `#L${span[0]}` : `#L${span[0]}-L${span[1]}`;
  return `https://github.com/${repo}/blob/${sha}/${file}${at}`;
}

/** A reference's state in words: "Open issue", "Merged pull request"… */
export function refStateWords(r: Pick<IssueRef, 'state' | 'isPullRequest' | 'notPlanned'>): string {
  if (!r.isPullRequest) return r.state === 'open' ? 'Open issue' : r.notPlanned ? 'Closed issue (not planned)' : 'Closed issue';
  return `${{ open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' }[r.state]} pull request`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A reference's hover card, as HTML with every part escaped: its title, its state in words and author, and `hint`. */
export function refCard(r: IssueRef, hint?: string): string {
  const by = r.author ? ` by ${esc(r.author.login)}` : '';
  return `<b>${esc(r.title)}</b> #${r.number}<br>${refStateWords(r)}${by}${hint ? `<br>${esc(hint)}` : ''}`;
}

/** The `#text` the caret is in (typing a reference), as where it starts and ends; null when it isn't in one. */
export function refAt(text: string, caret: number): { from: number; to: number; query: string } | null {
  const m = /(?:^|[\s([{,;])#([\w-]{0,40})$/.exec(text.slice(0, caret));
  if (!m) return null;
  const from = caret - m[1].length - 1;
  const rest = /^[\w-]*/.exec(text.slice(caret))![0];
  return { from, to: caret + rest.length, query: m[1] + rest };
}

/** The key a reference is looked up by: `owner/repo#123`, lowercased. */
export const refKey = (repo: string, number: number | string) => `${repo.toLowerCase()}#${number}`;
