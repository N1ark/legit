// GitHub's check runs and commit statuses, as the UI shows them: grouped by workflow run (other
// apps' checks by app, statuses together), each with one normalized state.

import type { CheckCounts, CheckGroup, CheckJob, CheckState, CommitChecks, JobInfo, RollupState } from '../../shared/gh-checks.ts';
import { FINISHED, overall } from '../../shared/gh-checks.ts';

/** A check run's (or Actions job's) status and conclusion, in GraphQL's or REST's case. */
export function runState(status: string | null | undefined, conclusion: string | null | undefined): CheckState {
  const s = (status ?? '').toUpperCase();
  if (s === 'IN_PROGRESS') return 'running';
  if (s && s !== 'COMPLETED') return 'pending';
  switch ((conclusion ?? '').toUpperCase()) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'TIMED_OUT':
    case 'STARTUP_FAILURE':
      return 'failure';
    case 'CANCELLED':
      return 'cancelled';
    case 'ACTION_REQUIRED':
      return 'action_required';
    case 'SKIPPED':
      return 'skipped';
    default:
      return 'neutral';
  }
}

/** A commit status's state. */
export function statusState(state: string | null | undefined): CheckState {
  const s = (state ?? '').toUpperCase();
  return s === 'SUCCESS' ? 'success' : s === 'FAILURE' || s === 'ERROR' ? 'failure' : 'pending';
}

export function rollupState(state: string | null | undefined): RollupState | null {
  const s = (state ?? '').toUpperCase();
  return s === 'SUCCESS' ? 'success' : s === 'FAILURE' || s === 'ERROR' ? 'failure' : s ? 'pending' : null;
}

export function countStates(jobs: { state: CheckState }[]): CheckCounts {
  const c: CheckCounts = { total: 0, done: 0, success: 0, failure: 0, running: 0, pending: 0 };
  for (const { state } of jobs) {
    c.total++;
    if (FINISHED.has(state)) c.done++;
    if (state === 'success') c.success++;
    else if (state === 'failure' || state === 'action_required') c.failure++;
    else if (state === 'running') c.running++;
    else if (state === 'pending') c.pending++;
  }
  return c;
}

/** `repository.object(oid:)` of the CommitChecks query (a Commit, or null) as the UI's checks. */
export function toCommitChecks(sha: string, commit: any): CommitChecks {
  const rollup = commit?.statusCheckRollup ?? null;
  const groups = new Map<string, CheckGroup>();
  const group = (key: string, init: () => Omit<CheckGroup, 'key' | 'state' | 'jobs'>) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, ...init(), state: 'neutral', jobs: [] }));
    return g;
  };
  for (const n of rollup?.contexts?.nodes ?? []) {
    if (!n) continue;
    if (n.__typename === 'StatusContext') {
      const g = group('statuses', () => ({ name: 'Statuses', kind: 'statuses', runId: null, runNumber: null, event: null, url: null }));
      g.jobs.push({
        key: `status:${n.context}`,
        jobId: null,
        name: n.context,
        state: statusState(n.state),
        startedAt: n.createdAt ?? null,
        completedAt: null,
        url: n.targetUrl || null,
        description: n.description || null,
        required: !!n.isRequired,
      });
      continue;
    }
    const run = n.checkSuite?.workflowRun ?? null;
    const app = n.checkSuite?.app ?? null;
    const g = run
      ? group(`run:${run.databaseId}`, () => ({
          name: run.workflow?.name ?? app?.name ?? 'Workflow',
          kind: 'workflow',
          runId: run.databaseId ?? null,
          runNumber: run.runNumber ?? null,
          event: run.event ?? null,
          url: run.url ?? null,
        }))
      : group(`app:${app?.slug ?? app?.name ?? '?'}`, () => ({
          name: app?.name ?? 'Checks',
          kind: 'app',
          runId: null,
          runNumber: null,
          event: null,
          url: null,
        }));
    const job: CheckJob = {
      key: `run:${n.databaseId}`,
      jobId: run ? (n.databaseId ?? null) : null,
      name: n.name,
      state: runState(n.status, n.conclusion),
      startedAt: n.startedAt ?? null,
      completedAt: n.completedAt ?? null,
      url: n.detailsUrl ?? null,
      description: null,
      required: !!n.isRequired,
    };
    // A re-run job is a new check run with the same name: the newest one counts.
    const same = g.jobs.findIndex((j) => j.name === job.name);
    if (same < 0) g.jobs.push(job);
    else if ((n.databaseId ?? 0) > idOf(g.jobs[same])) g.jobs[same] = job;
  }
  const list = [...groups.values()];
  for (const g of list) g.state = overall(g.jobs.map((j) => j.state));
  // Workflows first, by name; then other apps; statuses last.
  const rank = { workflow: 0, app: 1, statuses: 2 };
  list.sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name) || (a.runId ?? 0) - (b.runId ?? 0));
  return { sha, state: rollupState(rollup?.state), groups: list, counts: countStates(list.flatMap((g) => g.jobs)) };
}

const idOf = (job: CheckJob) => Number(job.key.split(':')[1]) || 0;

/** REST's `GET /actions/jobs/{id}`. */
export function toJobInfo(j: any): JobInfo {
  return {
    id: j.id,
    runId: j.run_id,
    name: j.name,
    state: runState(j.status, j.conclusion),
    url: j.html_url,
    steps: (j.steps ?? []).map((s: any) => ({
      number: s.number,
      name: s.name,
      state: runState(s.status, s.conclusion),
      startedAt: s.started_at ?? null,
      completedAt: s.completed_at ?? null,
    })),
  };
}
