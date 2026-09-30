import type { CommitInfo, Person } from '../../shared/types.ts';

/**
 * Message for squashing `list` (newest first): the oldest commit's message, the others'
 * appended, and every other author kept as a co-author.
 */
export function combinedMessage(list: CommitInfo[]): string {
  const chrono = list.toReversed();
  const [first, ...rest] = chrono;
  const parts = [first.subject, first.body, ...rest.map((c) => [c.subject, c.body].filter(Boolean).join('\n\n'))];
  const people = new Map<string, Person>();
  for (const c of chrono) {
    for (const p of [c.author, ...c.coauthors]) {
      const key = p.email.toLowerCase();
      if (key !== first.author.email.toLowerCase() && !people.has(key)) people.set(key, p);
    }
  }
  const trailers = [...people.values()].map((p) => `Co-authored-by: ${p.name} <${p.email}>`).join('\n');
  return [...parts.filter(Boolean), trailers].filter(Boolean).join('\n\n');
}
