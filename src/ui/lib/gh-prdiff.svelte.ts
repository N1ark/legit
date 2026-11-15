// Pull requests read without checking them out: each one's head and base fetched into hidden refs
// (server/gh/prdiff.ts) once per head, all its commits, and the views of its diffs (gh/PrDiffView),
// shown in place of a commit as the overview is. `reviews.pr` is the shown one's meanwhile.

import { app } from './app.svelte.ts';
import { gh, ghPost, ghRequest } from './github.svelte.ts';
import type { PrDiffShow, PrFetched } from '../../shared/gh-prdiff.ts';
import type { PrCommit, PrOverview } from '../../shared/gh-prview.ts';
import type { PullRequest } from '../../shared/github.ts';

/** Where fetching a pull request's current head stands. */
export type Fetched = { head: string; got: PrFetched | null; error: string | null };

class PrDiffs {
  /** By pull request number, for the head last asked for. */
  fetched = $state.raw<Record<number, Fetched>>({});
  /** All of a pull request's commits (oldest first), when the overview lists only its last ones. */
  commits = $state.raw<Record<number, { head: string; list: PrCommit[] }>>({});

  private loads = new Map<string, Promise<PrFetched>>();
  /** Pull requests whose hidden refs this page keeps, until it leaves them (`showing`). */
  private held = new Set<number>();
  private lists = new Map<string, Promise<PrCommit[]>>();

  /** `f`, unless it's the answer for a head older than the one asked for since. */
  private note(number: number, f: Fetched, answer = true) {
    if (!answer || this.fetched[number]?.head === f.head) this.fetched = { ...this.fetched, [number]: f };
  }

  /** Fetch `pr`, unless its head is fetched or on its way; `again` after a failure. */
  ensure(pr: PrOverview, again = false): Promise<PrFetched> {
    const key = `${pr.number}@${pr.headSha}@${pr.base}`;
    let p = again ? undefined : this.loads.get(key);
    if (p) return p;
    this.note(pr.number, { head: pr.headSha, got: null, error: null }, false);
    const hold = !this.held.has(pr.number);
    this.held.add(pr.number);
    p = ghPost<PrFetched>('prFetch', { number: pr.number, head: pr.headSha, base: pr.base, hold });
    this.loads.set(key, p);
    p.then(
      (got) => this.note(pr.number, { head: pr.headSha, got, error: null }),
      (e) => {
        if (this.loads.get(key) === p) this.loads.delete(key);
        this.note(pr.number, { head: pr.headSha, got: null, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return p;
  }

  /** Let go of every pull request but `number`, the one shown (none: null), so its hidden refs go. */
  showing(number: number | null) {
    for (const n of [...this.held]) if (n !== number) this.release(n);
  }

  /** Let go of all of them, as the page goes; `keepalive` sees the request out. */
  leave() {
    for (const n of this.held) void fetch(`/api/gh/prRelease`, { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', 'x-legit': '1' }, body: JSON.stringify({ number: n }) }).catch(() => {});
    this.held.clear();
    this.loads.clear();
    this.fetched = {};
  }

  private release(n: number) {
    this.held.delete(n);
    for (const k of [...this.loads.keys()]) if (k.startsWith(`${n}@`)) this.loads.delete(k);
    const { [n]: _, ...rest } = this.fetched;
    this.fetched = rest;
    ghPost('prRelease', { number: n }).catch(() => {});
  }

  /** Every commit of `pr` as far as it's loaded (see `loadCommits`), oldest first. */
  allCommits(pr: PrOverview): PrCommit[] {
    const have = this.commits[pr.number];
    return pr.commitCount <= pr.commits.length ? pr.commits : have?.head === pr.headSha ? have.list : pr.commits;
  }

  /** Ask for every commit of `pr` when its overview lists only its last ones (once per head). */
  loadCommits(pr: PrOverview) {
    const key = `${pr.number}@${pr.headSha}`;
    if (pr.commitCount <= pr.commits.length || this.lists.has(key)) return;
    const p = ghRequest<PrCommit[]>('prCommits', { number: pr.number, head: pr.headSha });
    this.lists.set(key, p);
    p.then(
      (list) => (this.commits = { ...this.commits, [pr.number]: { head: pr.headSha, list } }),
      () => this.lists.delete(key),
    );
  }

  /** Show `what` of pull request `pr` in place of a commit. */
  show(pr: PrOverview, what: PrDiffShow) {
    app.stash = null;
    app.ghView = { kind: 'prdiff', number: pr.number, pr: asPullRequest(pr), show: what };
  }

  /** Back to the overview. */
  back(number: number) {
    gh.showPr(number);
  }
}

export const prDiffs = new PrDiffs();

export function asPullRequest(pr: PrOverview): PullRequest {
  const repo = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pr.url)?.[1] ?? gh.status?.repo ?? '';
  return { number: pr.number, title: pr.title, url: pr.url, state: pr.state, base: pr.base, head: pr.head, headSha: pr.headSha, author: pr.author, repo };
}

/** What a diff view of a pull request is called. */
export function showTitle(what: PrDiffShow): string {
  return what.kind === 'files' ? 'Files changed' : what.kind === 'since' ? 'Changes since your review' : what.kind === 'compare' ? what.label : 'Commit';
}
