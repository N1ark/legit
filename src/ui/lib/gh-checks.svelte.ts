// CI state for the views: each pushed commit's combined state (the commit list batches its rows'
// SHAs into one request), the full checks of the commits being looked at, jobs' steps, and which
// popover or log is open. ChecksChip drives the refreshes and hosts the popover and the log.

import { toast } from 'purr';
import { gh, ghPost, ghRequest } from './github.svelte.ts';
import type { CommitChecks, JobInfo, RollupState } from '../../shared/gh-checks.ts';

/** Commits whose state may still change get asked about again for this long after they first show. */
const RECENT = 10 * 60_000;

export interface LogTarget {
  jobId: number;
  name: string;
  url: string | null;
  /** The step to open on; null for the one the log suggests (the failed one). */
  step: number | null;
}

class Checks {
  /** Each commit's combined state (null: no checks); missing until asked. */
  rollups = $state.raw<Record<string, RollupState | null>>({});
  /** Full checks of the commits looked at. */
  details = $state.raw<Record<string, CommitChecks>>({});
  /** Steps of the jobs expanded in the popover. */
  jobs = $state.raw<Record<number, JobInfo>>({});
  expanded = $state.raw<ReadonlySet<number>>(new Set());
  /** The checks popover: which commit, hung off what. */
  open = $state<{ sha: string; anchor: HTMLElement } | null>(null);
  log = $state<LogTarget | null>(null);
  /** Opens the header chip's popover; set by the chip while it shows (a notification about this branch's CI uses it). */
  showHead: (() => void) | null = null;

  private wanted = new Map<string, { rows: number; since: number }>();
  private queued = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loads = new Map<string, number>();
  /** The pull request a commit heads, for which of its checks are required. */
  private prs = new Map<string, number>();

  /** A commit list row shows `sha`; returns what to call when it stops. */
  want(sha: string): () => void {
    const w = this.wanted.get(sha);
    if (w) w.rows++;
    else {
      this.wanted.set(sha, { rows: 1, since: Date.now() });
      if (!(sha in this.rollups)) this.queue([sha]);
    }
    return () => {
      const v = this.wanted.get(sha);
      if (v && --v.rows === 0) this.wanted.delete(sha);
    };
  }

  /** Ask again about the rows that may have changed: still running, or recent and without checks yet. */
  refreshRows() {
    const now = Date.now();
    this.queue(
      [...this.wanted].filter(([sha, w]) => !(sha in this.rollups) || this.rollups[sha] === 'pending' || (this.rollups[sha] === null && now - w.since < RECENT)).map(([sha]) => sha),
    );
  }

  private queue(shas: string[]) {
    for (const s of shas) this.queued.add(s);
    this.timer ??= setTimeout(() => this.flush(), 50);
  }

  private async flush() {
    this.timer = null;
    // Not signed in yet (or at all): the next refresh asks again.
    if (!gh.ready || !this.queued.size) return;
    const shas = [...this.queued];
    this.queued.clear();
    for (let i = 0; i < shas.length; i += 100) {
      try {
        const got = await ghRequest<Record<string, RollupState | null>>('checksRollups', { shas: shas.slice(i, i + 100).join(',') });
        this.rollups = { ...this.rollups, ...got };
      } catch {
        // Background: the dots stay as they were.
      }
    }
  }

  /** The full checks of `sha`; `quiet` for background refreshes, which don't toast. */
  async load(sha: string, opts: { pr?: number | null; quiet?: boolean } = {}) {
    if (!gh.ready) return;
    this.loads.set(sha, Date.now());
    if (opts.pr) this.prs.set(sha, opts.pr);
    try {
      const c = await ghRequest<CommitChecks>('checks', { sha, pr: opts.pr ?? this.prs.get(sha) });
      this.details = { ...this.details, [sha]: c };
      this.rollups = { ...this.rollups, [sha]: c.state };
    } catch (e) {
      if (!opts.quiet) toast.error(e);
    }
  }

  /** When `sha`'s checks were last asked for (0: never). */
  loadedAt(sha: string) {
    return this.loads.get(sha) ?? 0;
  }

  /** Anything of `sha`'s still queued or running. */
  active(sha: string) {
    const c = this.details[sha]?.counts;
    return !!c && c.running + c.pending > 0;
  }

  show(sha: string, anchor: HTMLElement) {
    if (this.open?.sha === sha) {
      this.open = null;
      return;
    }
    this.open = { sha, anchor };
    this.load(sha);
  }

  async loadJob(jobId: number, quiet = false) {
    try {
      const j = await ghRequest<JobInfo>('checksJob', { job: jobId });
      this.jobs = { ...this.jobs, [jobId]: j };
    } catch (e) {
      if (!quiet) toast.error(e);
    }
  }

  toggleJob(jobId: number) {
    const next = new Set(this.expanded);
    if (next.delete(jobId)) {
      this.expanded = next;
      return;
    }
    next.add(jobId);
    this.expanded = next;
    this.loadJob(jobId);
  }

  /** Steps of expanded jobs still going, again. */
  refreshJobs() {
    for (const id of this.expanded) {
      const j = this.jobs[id];
      if (j && (j.state === 'running' || j.state === 'pending')) this.loadJob(id, true);
    }
  }

  /** Re-run or cancel (`checksRerunFailed`, `checksRerun`, `checksRerunJob`, `checksCancel`), then look again. */
  async act(sha: string, route: string, body: { run?: number; job?: number }, done: string) {
    try {
      await ghPost(route, body);
      toast(done);
    } catch (e) {
      toast.error(e);
    }
    await this.load(sha, { quiet: true });
  }
}

export const checks = new Checks();
