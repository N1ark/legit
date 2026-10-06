import type { CommitInfo, Person } from '../../shared/types.ts';

export interface SquashFields {
  subject: string;
  body: string;
  coauthors: Person[];
}

/**
 * Proposed message for squashing `list` (newest first): the oldest commit's title, its
 * description followed by the other commits' messages, and every other author (plus all
 * existing co-authors) as co-authors.
 */
export function squashFields(list: CommitInfo[]): SquashFields {
  const [first, ...rest] = list.toReversed();
  const body = [first.body, ...rest.map((c) => [c.subject, c.body].filter(Boolean).join('\n\n'))]
    .filter(Boolean)
    .join('\n\n');
  const people = new Map<string, Person>();
  for (const c of [first, ...rest]) {
    for (const p of [c.author, ...c.coauthors]) {
      const key = p.email.toLowerCase();
      if (key !== first.author.email.toLowerCase() && !people.has(key)) people.set(key, p);
    }
  }
  return { subject: first.subject, body, coauthors: [...people.values()] };
}

/**
 * Diff key of what squashing `list` would make (see the server's `Repo.squashDiff`): its runs of
 * consecutive commits in `all`, both newest first.
 */
export function squashDiffKey(list: CommitInfo[], all: CommitInfo[]): string {
  const at = new Map(all.map((c, i) => [c.sha, i]));
  const runs: string[][] = [];
  let prev = -2;
  for (const c of list) {
    const i = at.get(c.sha) ?? -2;
    if (i === prev + 1 && runs.length) runs[runs.length - 1].push(c.sha);
    else runs.push([c.sha]);
    prev = i;
  }
  return 'q' + runs.map((r) => (r.length > 1 ? `${r[0]}-${r[r.length - 1]}` : r[0])).join('.');
}
