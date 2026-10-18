// The GitHub side of the current repo: who's signed in, and the current branch's pull request.
// Views reach GitHub through `ghRequest` (server/gh/routes.ts) and refresh with `gh.refresh()`.

import { toast } from 'purr';
import { app, request } from './app.svelte.ts';
import type { GithubStatus, PullRequest } from '../../shared/github.ts';

/**
 * GitHub reads sent at once; the others wait their turn. The page gets six connections to the
 * server, one of them the event stream: slow GitHub calls holding all the others made local ones
 * (the branch list) wait for GitHub.
 */
const MAX_READS = 3;
let reading = 0;
const waiting: (() => void)[] = [];

async function readSlot<T>(read: () => Promise<T>): Promise<T> {
  if (reading < MAX_READS) reading++;
  // The slot is handed over by the read that ends, so `reading` stays counted.
  else await new Promise<void>((go) => waiting.push(go));
  try {
    return await read();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else reading--;
  }
}

/** GET `/api/gh/<name>?query`, or POST `body` to it. */
export function ghRequest<T>(name: string, query?: Record<string, string | number | boolean | null | undefined>, body?: unknown): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== null && v !== undefined) q.set(k, String(v));
  const qs = q.size ? `?${q}` : '';
  if (body !== undefined) return request<T>(`/api/gh/${name}${qs}`, body);
  return readSlot(() => request<T>(`/api/gh/${name}${qs}`));
}

/** POST `body` to `/api/gh/<name>`. */
export const ghPost = <T,>(name: string, body: unknown = {}) => ghRequest<T>(name, undefined, body);

/** What the main area shows instead of a commit, when not null. */
export type GhView = { kind: 'pr'; number: number };

class Github {
  status = $state<GithubStatus | null>(null);
  /** The current branch's pull request (null: none, or not on GitHub); undefined until looked up. */
  pr = $state<PullRequest | null | undefined>(undefined);
  /** Bumped by `refresh()`, for views that keep their own GitHub data to reload it. */
  tick = $state(0);

  /** On GitHub and signed in. */
  ready = $derived(!!this.status?.repo && !!this.status.login);

  private branch: string | null = null;
  private lastAt = 0;
  private statusAt = 0;
  private statusLoad: Promise<void> | null = null;
  private gen = 0;

  /**
   * Look again: who's signed in (once it's known, else every so often, or now with `retry`), and
   * the current branch's pull request. A failure keeps what's shown, and the next refresh (focus,
   * the poll, any change to the repo) tries again.
   */
  async refresh(opts: { fresh?: boolean; retry?: boolean } = {}) {
    const gen = ++this.gen;
    const branch = app.repo?.branch ?? null;
    if (branch !== this.branch) this.pr = undefined;
    this.branch = branch;
    this.lastAt = Date.now();
    try {
      // Not signed in may only mean GitHub was out of reach when this window loaded (just woken up,
      // say): ask again, or the pull request would stay gone until a reload.
      if (this.statusLoad || !this.status || opts.retry || (!this.ready && Date.now() - this.statusAt > 15_000)) {
        await this.loadStatus(opts.retry);
      }
      if (!this.ready || !branch) {
        if (gen === this.gen) this.pr = null;
        return;
      }
      const pr = await ghRequest<PullRequest | null>('pr', { branch, fresh: opts.fresh ? 1 : null });
      if (gen === this.gen) {
        this.pr = pr;
        this.tick++;
      }
    } catch (e) {
      if (gen === this.gen && opts.fresh) toast.error(e);
    }
  }

  /** Ask who's signed in; refreshes meanwhile wait for the same answer, and only the last one asked is kept. */
  private loadStatus(retry = false): Promise<void> {
    if (this.statusLoad && !retry) return this.statusLoad;
    this.statusAt = Date.now();
    const load: Promise<void> = ghRequest<GithubStatus>('status', { retry: retry ? 1 : null })
      .then((s) => {
        if (this.statusLoad === load) this.status = s;
      })
      .finally(() => {
        if (this.statusLoad === load) this.statusLoad = null;
      });
    this.statusLoad = load;
    return load;
  }

  /** Refresh unless that happened in the last `ms`. */
  refreshIfOlder(ms: number) {
    if (Date.now() - this.lastAt > ms || (app.repo?.branch ?? null) !== this.branch) this.refresh();
  }

  /** What the main area shows instead of a commit, if anything. */
  get view() {
    return app.ghView;
  }

  showPr(number: number) {
    app.stash = null;
    app.ghView = { kind: 'pr', number };
  }

  /** The overview of the current branch's pull request, or back to the commits if it's already shown. */
  togglePr() {
    const pr = this.pr;
    if (!pr) return toast(this.ready ? `${app.repo?.branch ?? 'HEAD'} has no pull request.` : (this.status?.error ?? 'This repository is not on GitHub.'));
    if (this.view?.kind === 'pr' && this.view.number === pr.number) this.close();
    else this.showPr(pr.number);
  }

  close() {
    app.ghView = null;
  }
}

export const gh = new Github();
