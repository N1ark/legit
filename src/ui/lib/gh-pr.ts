// Pure helpers for pull requests in the UI: how a state is said, and what a new one starts as.

import type { PrState } from '../../shared/github.ts';

export const STATE_LABEL: Record<PrState, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };

/** `feature/parser-errors` → "Parser errors". */
export function humanize(branch: string): string {
  const words = (branch.split('/').filter(Boolean).pop() ?? '').replace(/[-_.\s]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : branch;
}

/**
 * A new pull request's title and description: one commit's own subject and body, or for several,
 * the branch's name as a title and their subjects as a list.
 */
export function prDraft(branch: string, commits: { subject: string; body: string }[]): { title: string; body: string } {
  if (commits.length === 1) return { title: commits[0].subject, body: commits[0].body };
  return { title: humanize(branch), body: commits.map((c) => `- ${c.subject}`).join('\n') };
}
