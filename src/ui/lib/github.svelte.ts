// The GitHub side of the current repo: who's signed in, and the current branch's pull request.
// Views reach GitHub through `ghRequest` (server/gh/routes.ts) and refresh with `gh.refresh()`.

import { toast } from 'purr';
import { app, request } from './app.svelte.ts';
import type { GithubStatus, PullRequest } from '../../shared/github.ts';

/** GET `/api/gh/<name>?query`, or POST `body` to it. */
export function ghRequest<T>(name: string, query?: Record<string, string | number | boolean | null | undefined>, body?: unknown): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== null && v !== undefined) q.set(k, String(v));
  const qs = q.size ? `?${q}` : '';
  return request<T>(`/api/gh/${name}${qs}`, body);
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
  private gen = 0;

  /** Look again: who's signed in (once, or with `retry`), and the current branch's pull request. */
  async refresh(opts: { fresh?: boolean; retry?: boolean } = {}) {
    const gen = ++this.gen;
    const branch = app.repo?.branch ?? null;
    if (branch !== this.branch) this.pr = undefined;
    this.branch = branch;
    this.lastAt = Date.now();
    try {
      if (!this.status || opts.retry) this.status = await ghRequest<GithubStatus>('status', { retry: opts.retry ? 1 : null });
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

  close() {
    app.ghView = null;
  }
}

export const gh = new Github();
