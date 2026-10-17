// What `#123` references point at, for their state icons and hover cards: every reference shown is
// asked for in one batched request (the server splits it into queries of 50), then kept.

import { gh, ghRequest } from './github.svelte.ts';
import { refKey } from './gh-links.ts';
import type { IssueRef } from '../../shared/gh-issues.ts';

class Refs {
  /** By `refKey`; null for a number that's no issue (or out of reach). */
  private known = $state.raw<Record<string, IssueRef | null>>({});
  private asked = new Set<string>();
  private queue = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private at = 0;

  /** What `repo#number` is; undefined until known. Asks for it, along with every other reference shown meanwhile. */
  get(repo: string | null | undefined, number: string | number): IssueRef | null | undefined {
    if (!repo || !gh.ready) return undefined;
    const key = refKey(repo, number);
    const v = this.known[key];
    if (v === undefined && !this.asked.has(key)) {
      // Called while rendering: the state changes later, from the request.
      this.asked.add(key);
      this.queue.add(key);
      this.timer ??= setTimeout(() => this.flush(), 30);
    }
    return v;
  }

  private async flush() {
    this.timer = null;
    const keys = [...this.queue];
    this.queue.clear();
    this.at = Date.now();
    try {
      const got = await ghRequest<Record<string, IssueRef | null>>('issuesRefs', { refs: keys.join(',') });
      this.known = { ...this.known, ...got };
    } catch {
      // Quiet: asked again next time they're shown after a refresh.
      for (const k of keys) this.asked.delete(k);
    }
  }

  /** After a GitHub refresh: ask again for what's shown, at most every couple of minutes. */
  stale() {
    if (Date.now() - this.at < 120_000) return;
    this.asked.clear();
    for (const k of Object.keys(this.known)) {
      this.queue.add(k);
      this.asked.add(k);
    }
    if (this.queue.size) this.timer ??= setTimeout(() => this.flush(), 30);
  }

  /** References learnt otherwise (a search, an issue just made). */
  put(list: IssueRef[]) {
    if (list.length) this.known = { ...this.known, ...Object.fromEntries(list.map((r) => [refKey(r.repo, r.number), r])) };
  }
}

export const refs = new Refs();

const searches = new Map<string, { at: number; value: Promise<IssueRef[]> }>();

/** Issues and pull requests to suggest for `#query`, kept briefly so typing back and forth asks once. */
export function searchRefs(query: string): Promise<IssueRef[]> {
  const hit = searches.get(query);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = ghRequest<IssueRef[]>('issuesSearch', { q: query });
  searches.set(query, { at: Date.now(), value });
  value.then((list) => refs.put(list), () => searches.delete(query));
  return value;
}
