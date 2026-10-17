// CI on GitHub (server/gh/checks.ts): a commit's checks, grouped by workflow run, and a job's steps and log.

/** A check's state, from a check run's status and conclusion or a commit status's state. */
export type CheckState = 'success' | 'failure' | 'cancelled' | 'action_required' | 'running' | 'pending' | 'neutral' | 'skipped';

/** A commit's combined state, as GitHub rolls it up; null when it has no checks. */
export type RollupState = 'success' | 'failure' | 'pending';

export interface CheckJob {
  /** Unique within the commit. */
  key: string;
  /** The Actions job's id (its check run's id), for its steps, log and re-run; null for other apps' checks and statuses. */
  jobId: number | null;
  name: string;
  state: CheckState;
  startedAt: string | null;
  completedAt: string | null;
  url: string | null;
  /** A commit status's description, or nothing. */
  description: string | null;
  /** Required by the base branch's protection, when that was asked for (a pull request's head). */
  required: boolean;
}

export interface CheckGroup {
  key: string;
  /** The workflow's name, the app's, or "Statuses". */
  name: string;
  kind: 'workflow' | 'app' | 'statuses';
  /** The workflow run, for re-running or cancelling it. */
  runId: number | null;
  runNumber: number | null;
  event: string | null;
  url: string | null;
  state: CheckState;
  jobs: CheckJob[];
}

export interface CheckCounts {
  total: number;
  /** Finished, whatever the outcome. */
  done: number;
  success: number;
  failure: number;
  running: number;
  pending: number;
}

export interface CommitChecks {
  sha: string;
  state: RollupState | null;
  groups: CheckGroup[];
  counts: CheckCounts;
}

export interface JobStep {
  number: number;
  name: string;
  state: CheckState;
  startedAt: string | null;
  completedAt: string | null;
}

export interface JobInfo {
  id: number;
  runId: number;
  name: string;
  state: CheckState;
  url: string;
  steps: JobStep[];
}

export type LogLineKind = 'group' | 'error' | 'warning' | 'notice' | 'command' | 'debug';

export interface LogLine {
  /** The text, ANSI escapes kept, without its timestamp or `##[…]` marker. */
  t: string;
  k?: LogLineKind;
}

export interface LogStep {
  number: number;
  name: string;
  state: CheckState;
  lines: LogLine[];
  /** Lines left out before the first one kept (long logs keep their end). */
  skipped: number;
  /** Index in `lines` of the first `##[error]`, or -1. */
  firstError: number;
}

export interface JobLog {
  jobId: number;
  name: string;
  url: string;
  state: CheckState;
  steps: LogStep[];
  /** The step to open on: the first that failed, else the last with lines. */
  open: number | null;
}

/** States that are over. */
export const FINISHED: ReadonlySet<CheckState> = new Set(['success', 'failure', 'cancelled', 'action_required', 'neutral', 'skipped']);

const ORDER: CheckState[] = ['failure', 'action_required', 'running', 'pending', 'cancelled', 'success', 'neutral', 'skipped'];

/** What a set of checks amounts to: a failure wins, then anything still going. */
export function overall(states: CheckState[]): CheckState {
  for (const s of ORDER) if (states.includes(s)) return s;
  return 'neutral';
}
