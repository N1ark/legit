// Stacked pull requests: one whose base is another's head is stacked on it. Pure, to be tested alone.

import type { PullRequest } from '../../shared/github.ts';

const live = (p: PullRequest) => p.state === 'open' || p.state === 'draft';

/** Each head branch's pull request: an open one, else the first listed (the newest). */
export function byHead(prs: PullRequest[]): Map<string, PullRequest> {
  const out = new Map<string, PullRequest>();
  for (const p of prs) {
    const had = out.get(p.head);
    if (!had || (!live(had) && live(p))) out.set(p.head, p);
  }
  return out;
}

/** The pull requests `head`'s is stacked on, nearest first, down to the one on `trunk` (or the lowest known). */
export function ancestors(heads: Map<string, PullRequest>, head: string, trunk: string): PullRequest[] {
  const out: PullRequest[] = [];
  const seen = new Set([head]);
  let p = heads.get(head);
  while (p && p.base !== trunk && !seen.has(p.base)) {
    seen.add(p.base);
    p = heads.get(p.base);
    if (p) out.push(p);
  }
  return out;
}

/** The branch below the lowest pull request known under `head`'s, when it isn't the trunk: the next to look up. */
export function missingBase(prs: PullRequest[], head: string, trunk: string): string | null {
  const heads = byHead(prs);
  const own = heads.get(head);
  const last = own ? [own, ...ancestors(heads, head, trunk)].at(-1)! : null;
  return last && last.base !== trunk && !heads.has(last.base) ? last.base : null;
}

export interface Placed {
  pr: PullRequest;
  indent: number;
}

/**
 * The stack `head` is in, top first, the way `gt log` draws it: from the lowest pull request under
 * `head`'s, every open one stacked on it (recursively), with each one's descendants right above it.
 * A branch's first descendant (the one leading to `head`, if any) stays in its column; others are
 * indented. Empty when `head` has no pull request.
 */
export function stackAround(prs: PullRequest[], head: string, trunk: string): Placed[] {
  const heads = byHead(prs);
  const own = heads.get(head);
  if (!own) return [];
  const chain = [own, ...ancestors(heads, head, trunk)];
  const onChain = new Set(chain);
  const kids = new Map<string, PullRequest[]>();
  for (const p of heads.values()) {
    if (p === chain.at(-1) || !(live(p) || onChain.has(p))) continue;
    kids.set(p.base, [...(kids.get(p.base) ?? []), p]);
  }
  const out: Placed[] = [];
  const seen = new Set<string>();
  const walk = (p: PullRequest, indent: number) => {
    if (seen.has(p.head)) return;
    seen.add(p.head);
    out.push({ pr: p, indent });
    const next = (kids.get(p.head) ?? []).sort((a, b) => Number(onChain.has(b)) - Number(onChain.has(a)) || a.number - b.number);
    next.forEach((k, i) => walk(k, indent + (i ? 1 : 0)));
  };
  walk(chain.at(-1)!, 0);
  return out.reverse();
}
