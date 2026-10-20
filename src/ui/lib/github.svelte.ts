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

/** How often a refresh that found the same pull request still has the views reload theirs. */
const TICK_EVERY = 30_000;

class Github {
  status = $state<GithubStatus | null>(null);
  /** The current branch's pull request (null: none, or not on GitHub); undefined until looked up. */
  pr = $state<PullRequest | null | undefined>(undefined);
  /** Bumped by `refresh()`, for views that keep their own GitHub data to reload it. */
  tick = $state(0);
  /** The branch `pr` is for: until it's the current one, `pr` is the previous branch's. */
  branch = $state<string | null>(null);

  /** On GitHub and signed in. */
  ready = $derived(!!this.status?.repo && !!this.status.login);

  private lastAt = 0;
  private tickAt = 0;
  private statusAt = 0;
  private statusLoad: Promise<{ status: GithubStatus; n: number; branch: string | null }> | null = null;
  private statusN = 0;
  private gen = 0;
  private followed: string | null = null;
  /** Each branch's pull request as last looked up. */
  private seen = new Map<string, PullRequest | null>();

  /**
   * Look again: who's signed in (once it's known, else every so often, or now with `retry`), and
   * the current branch's pull request. A failure keeps what's shown, and the next refresh (focus,
   * the poll, any change to the repo) tries again.
   */
  async refresh(opts: { fresh?: boolean; retry?: boolean } = {}) {
    const gen = ++this.gen;
    const branch = app.repo?.branch ?? null;
    // Back on a branch: its pull request as last seen, until GitHub's answer replaces it.
    if (branch !== this.branch) this.pr = branch ? (this.seen.get(branch) ?? undefined) : undefined;
    this.branch = branch;
    this.lastAt = Date.now();
    const ask = (b: string) => ghRequest<PullRequest | null>('pr', { branch: b, fresh: opts.fresh ? 1 : null });
    try {
      // Not signed in may only mean GitHub was out of reach when this window loaded (just woken up,
      // say): ask again, or the pull request would stay gone until a reload.
      const asking = !!this.statusLoad || !this.status || !!opts.retry || (!this.ready && Date.now() - this.statusAt > 15_000);
      const status = asking ? this.loadStatus(opts.retry, branch) : null;
      // Asked alongside the status rather than after it (dropped if that says signed out). When the
      // server has it at hand the status brings it, and both show at once, so the views that follow
      // them ask about the pull request's head once.
      const early = branch && (status ? !!app.repo?.github : this.ready) ? ask(branch) : null;
      early?.catch(() => {});
      let pr: PullRequest | null | undefined;
      if (status) {
        const s = await status;
        if (s.n === this.statusN) this.status = s.status;
        if (s.branch === branch && !opts.fresh) pr = s.status.pr;
      }
      if (!this.ready || !branch) {
        if (gen === this.gen) this.pr = null;
        return;
      }
      if (pr === undefined) pr = await (early ?? ask(branch));
      this.seen.set(branch, pr);
      if (gen === this.gen) {
        const changed = JSON.stringify(pr) !== JSON.stringify(this.pr);
        this.pr = pr;
        // Every edit here refreshes, but GitHub hasn't changed because of it: the views reload
        // their own data when the pull request did, when asked to, and otherwise at most this often.
        if (changed || opts.fresh || Date.now() - this.tickAt > TICK_EVERY) {
          this.tickAt = Date.now();
          this.tick++;
        }
      }
    } catch (e) {
      if (gen === this.gen && opts.fresh) toast.error(e);
    }
  }

  /** Ask who's signed in; refreshes meanwhile wait for the same answer, and only the last one asked is kept. */
  private loadStatus(retry: boolean | undefined, branch: string | null): Promise<{ status: GithubStatus; n: number; branch: string | null }> {
    if (this.statusLoad && !retry) return this.statusLoad;
    this.statusAt = Date.now();
    const n = ++this.statusN;
    const load = ghRequest<GithubStatus>('status', { retry: retry ? 1 : null, branch })
      .then((status) => ({ status, n, branch }))
      .finally(() => {
        if (this.statusLoad === load) this.statusLoad = null;
      });
    this.statusLoad = load;
    return load;
  }

  /** After the repo's state reloads: refresh if the branch, its tip or what was fetched of it moved. */
  follow() {
    const r = app.repo;
    const key = `${r?.branch}\0${r?.head}\0${r?.push?.tip}`;
    if (key === this.followed) return;
    this.followed = key;
    this.refresh();
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
