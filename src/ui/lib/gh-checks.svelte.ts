// CI state for the views: each pushed commit's combined state (the commit list batches its rows'
// SHAs into one request), the full checks of the commits being looked at, jobs' steps, and which
// popover or log is open. ChecksChip drives the refreshes and hosts the popover and the log.

import { toast } from 'purr';
import { gh, ghPost, ghRequest } from './github.svelte.ts';
import { type CommitChecks, FINISHED, type JobInfo, type JobLog, type RollupState } from '../../shared/gh-checks.ts';

/** Commits whose state may still change get asked about again for this long after they first show. */
const RECENT = 10 * 60_000;
/** Full checks kept, of the commits looked at last: another's are asked for again when it's looked at. */
const KEEP_DETAILS = 30;
/** Logs of finished jobs kept (they don't change; a re-run is a new job), so opening one again is instant. */
const KEEP_LOGS = 3;

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
  /** Asked about, no answer yet. */
  private asking = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loads = new Map<string, number>();
  private rowsAt = 0;
  /** The pull request a commit heads, for which of its checks are required. */
  private prs = new Map<string, number>();
  private logs = new Map<number, Promise<JobLog>>();

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
    if (now - this.rowsAt < 15_000) return;
    this.rowsAt = now;
    this.queue(
      [...this.wanted].filter(([sha, w]) => !(sha in this.rollups) || this.rollups[sha] === 'pending' || (this.rollups[sha] === null && now - w.since < RECENT)).map(([sha]) => sha),
    );
  }

  private queue(shas: string[]) {
    for (const s of shas) if (!this.asking.has(s)) this.queued.add(s);
    // Rows mount a few at a time as the list renders: gather them into one request.
    if (this.queued.size) this.timer ??= setTimeout(() => this.flush(), 250);
  }

  private async flush() {
    this.timer = null;
    // Not signed in yet (or at all): the next refresh asks again.
    if (!gh.ready || !this.queued.size) return;
    const shas = [...this.queued];
    this.queued.clear();
    for (const s of shas) this.asking.add(s);
    for (let i = 0; i < shas.length; i += 100) {
      const chunk = shas.slice(i, i + 100);
      try {
        const got = await ghRequest<Record<string, RollupState | null>>('checksRollups', { shas: chunk.join(',') });
        this.rollups = { ...this.rollups, ...got };
      } catch {
        // Background: the dots stay as they were.
      } finally {
        for (const s of chunk) this.asking.delete(s);
      }
    }
  }

  /** The full checks of `sha`; `quiet` for background refreshes, which don't toast. */
  async load(sha: string, opts: { pr?: number | null; quiet?: boolean } = {}) {
    if (!gh.ready) return;
    // Most recent last, for `prune`.
    this.loads.delete(sha);
    this.loads.set(sha, Date.now());
    if (opts.pr) this.prs.set(sha, opts.pr);
    try {
      const c = await ghRequest<CommitChecks>('checks', { sha, pr: opts.pr ?? this.prs.get(sha) });
      this.details = { ...this.prune(), [sha]: c };
      this.rollups = { ...this.rollups, [sha]: c.state };
    } catch (e) {
      if (!opts.quiet) toast.error(e);
    }
  }

  /** `details` without the commits looked at longest ago, past the last few (their dots stay). */
  private prune(): Record<string, CommitChecks> {
    if (this.loads.size <= KEEP_DETAILS) return this.details;
    const details = { ...this.details };
    for (const sha of this.loads.keys()) {
      if (this.loads.size <= KEEP_DETAILS) break;
      if (sha === this.open?.sha) continue;
      this.loads.delete(sha);
      this.prs.delete(sha);
      delete details[sha];
    }
    return details;
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

  show(sha: string, anchor: HTMLElement, pr?: number) {
    if (this.open?.sha === sha) {
      this.open = null;
      return;
    }
    this.open = { sha, anchor };
    // What the chip shows was just asked for: open with it, else look again.
    if (Date.now() - this.loadedAt(sha) > 5_000 || (pr && pr !== this.prs.get(sha))) this.load(sha, { pr });
  }

  /** Job `jobId`'s log; a finished one's is kept, a failed load isn't. */
  loadLog(jobId: number): Promise<JobLog> {
    const hit = this.logs.get(jobId);
    if (hit) {
      this.logs.delete(jobId);
      this.logs.set(jobId, hit);
      return hit;
    }
    const value = ghRequest<JobLog>('checksLog', { job: jobId });
    this.logs.set(jobId, value);
    value.then(
      (l) => FINISHED.has(l.state) || this.logs.delete(jobId),
      () => this.logs.delete(jobId),
    );
    while (this.logs.size > KEEP_LOGS) this.logs.delete(this.logs.keys().next().value!);
    return value;
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
