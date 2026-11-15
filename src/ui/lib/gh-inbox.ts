// Pure helpers for the pull request inbox: which list a pull request is in, and what typed in its
// filter names one (`#12`, `12`, `owner/repo#12`, or its URL on GitHub).

import type { CheckoutPlan, InboxList, InboxPage, InboxPr, PrInbox } from '../../shared/gh-inbox.ts';

export const LISTS: { id: InboxList; label: string }[] = [
  { id: 'review', label: 'Review requested' },
  { id: 'mine', label: 'Yours' },
  { id: 'assigned', label: 'Assigned' },
  { id: 'open', label: 'All open' },
];

/** `inbox` with a list's next page (`list`, which ended at `cursor`) taken in: each pull request once, in every list it's in. */
export function addPage(inbox: PrInbox, list: InboxList, page: InboxPage): PrInbox {
  const by = new Map(inbox.items.map((p) => [p.number, p]));
  for (const p of page.items) {
    const had = by.get(p.number);
    by.set(p.number, had ? { ...p, requested: had.requested ?? p.requested, mine: had.mine || p.mine, assigned: had.assigned || p.assigned } : p);
  }
  const items = [...by.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { ...inbox, items, cursors: { ...inbox.cursors, [list]: page.cursor } };
}

export function inboxList(items: InboxPr[], list: InboxList): InboxPr[] {
  if (list === 'open') return items;
  return items.filter((p) => (list === 'review' ? p.requested !== null : list === 'mine' ? p.mine : p.assigned));
}

/** The pull request `query` names, in `repo` unless it says another; null when it names none. */
export function parsePrRef(query: string, repo: string): { number: number; repo: string } | null {
  const q = query.trim();
  const m =
    /^#?(\d+)$/.exec(q) ??
    /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(q) ??
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(q);
  if (!m) return null;
  const [other, n] = m.length === 3 ? [m[1], m[2]] : [null, m[1]];
  const number = Number(n);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { number, repo: !other || other.toLowerCase() === repo.toLowerCase() ? repo : other };
}

const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;

/** What checking out the pull request did, once `plan` has been carried out on `branch`. */
export function checkedOut(plan: CheckoutPlan, branch: string): string {
  const pr = `#${plan.number}`;
  if (branch !== plan.branch || plan.relation === 'new') {
    const up = branch === plan.branch && plan.upstream ? `, tracking ${plan.upstream.remote}/${plan.upstream.branch}${plan.addRemote ? ` (the fork, added as the remote ${plan.addRemote.name})` : ''}` : '';
    return `${pr} is on a new branch, ${branch}${up}.`;
  }
  if (plan.relation === 'behind') return `Fast-forwarded ${branch} to ${pr} (${commits(plan.behind)}).`;
  if (plan.relation === 'diverged') return `Reset ${branch} to ${pr}, setting aside its ${commits(plan.ahead)} only there (in Backups).`;
  if (plan.relation === 'ahead') return `${branch} has ${commits(plan.ahead)} ${pr} doesn't have yet.`;
  return `${branch} is ${pr}, up to date.`;
}
