import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countStates, rollupState, runState, statusState, toCommitChecks, toJobInfo } from '../src/server/gh/checks-map.ts';
import { logLine, parseJobLog } from '../src/server/gh/joblog.ts';
import { overall } from '../src/shared/gh-checks.ts';
import { ansiRuns, describeCounts, duration, formatDuration, stripAnsi } from '../src/ui/lib/gh-checks.ts';

const SHA = 'a'.repeat(40);

const actions = (run: number, workflow: string) => ({
  app: { name: 'GitHub Actions', slug: 'github-actions' },
  workflowRun: { databaseId: run, runNumber: 7, url: `https://github.com/o/r/actions/runs/${run}`, event: 'pull_request', workflow: { name: workflow } },
});

const checkRun = (id: number, name: string, status: string, conclusion: string | null, suite: unknown) => ({
  __typename: 'CheckRun',
  databaseId: id,
  name,
  status,
  conclusion,
  startedAt: '2026-01-01T10:00:00Z',
  completedAt: status === 'COMPLETED' ? '2026-01-01T10:01:30Z' : null,
  detailsUrl: `https://github.com/o/r/runs/${id}`,
  checkSuite: suite,
});

test('check run and status states', () => {
  assert.equal(runState('COMPLETED', 'SUCCESS'), 'success');
  assert.equal(runState('COMPLETED', 'TIMED_OUT'), 'failure');
  assert.equal(runState('COMPLETED', 'STARTUP_FAILURE'), 'failure');
  assert.equal(runState('COMPLETED', 'CANCELLED'), 'cancelled');
  assert.equal(runState('COMPLETED', 'SKIPPED'), 'skipped');
  assert.equal(runState('COMPLETED', 'ACTION_REQUIRED'), 'action_required');
  assert.equal(runState('COMPLETED', 'STALE'), 'neutral');
  assert.equal(runState('IN_PROGRESS', null), 'running');
  assert.equal(runState('QUEUED', null), 'pending');
  assert.equal(runState('WAITING', null), 'pending');
  // REST's lower case.
  assert.equal(runState('completed', 'failure'), 'failure');
  assert.equal(runState('in_progress', null), 'running');
  assert.equal(statusState('ERROR'), 'failure');
  assert.equal(statusState('EXPECTED'), 'pending');
  assert.equal(rollupState('ERROR'), 'failure');
  assert.equal(rollupState('EXPECTED'), 'pending');
  assert.equal(rollupState(null), null);
  assert.equal(overall(['success', 'running', 'failure']), 'failure');
  assert.equal(overall(['success', 'pending', 'running']), 'running');
  assert.equal(overall(['skipped', 'success']), 'success');
  assert.equal(overall([]), 'neutral');
});

test('checks are grouped by workflow run, other apps, then statuses', () => {
  const c = toCommitChecks(SHA, {
    statusCheckRollup: {
      state: 'FAILURE',
      contexts: {
        nodes: [
          { __typename: 'StatusContext', context: 'codecov/patch', state: 'SUCCESS', description: '92% hit', targetUrl: 'https://codecov.io/x', createdAt: '2026-01-01T10:00:00Z' },
          checkRun(5, 'test', 'COMPLETED', 'FAILURE', actions(100, 'CI')),
          checkRun(4, 'build', 'COMPLETED', 'SUCCESS', actions(100, 'CI')),
          checkRun(9, 'Vercel', 'IN_PROGRESS', null, { app: { name: 'Vercel', slug: 'vercel' }, workflowRun: null }),
          checkRun(6, 'docs', 'QUEUED', null, actions(101, 'Docs')),
          // A re-run of test: same name, newer id, wins whatever order it comes in.
          checkRun(8, 'test', 'IN_PROGRESS', null, actions(100, 'CI')),
        ],
      },
    },
  });
  assert.equal(c.state, 'failure');
  assert.deepEqual(c.groups.map((g) => [g.name, g.kind, g.state]), [
    ['CI', 'workflow', 'running'],
    ['Docs', 'workflow', 'pending'],
    ['Vercel', 'app', 'running'],
    ['Statuses', 'statuses', 'success'],
  ]);
  const ci = c.groups[0];
  assert.equal(ci.runId, 100);
  assert.deepEqual(ci.jobs.map((j) => [j.name, j.jobId, j.state]), [['test', 8, 'running'], ['build', 4, 'success']]);
  assert.equal(c.groups[2].jobs[0].jobId, null, "another app's check has no Actions job");
  assert.equal(c.groups[3].jobs[0].description, '92% hit');
  assert.deepEqual(c.counts, { total: 5, done: 2, success: 2, failure: 0, running: 2, pending: 1 });
});

test('a commit without checks, or unknown to GitHub', () => {
  assert.deepEqual(toCommitChecks(SHA, null), { sha: SHA, state: null, groups: [], counts: countStates([]) });
  assert.deepEqual(toCommitChecks(SHA, { statusCheckRollup: null }).groups, []);
});

test("a job's steps from REST", () => {
  const j = toJobInfo({
    id: 3,
    run_id: 1,
    name: 'test',
    status: 'completed',
    conclusion: 'failure',
    html_url: 'https://github.com/o/r/actions/runs/1/job/3',
    steps: [{ number: 1, name: 'Set up job', status: 'completed', conclusion: 'success', started_at: 'a', completed_at: 'b' }],
  });
  assert.equal(j.state, 'failure');
  assert.deepEqual(j.steps, [{ number: 1, name: 'Set up job', state: 'success', startedAt: 'a', completedAt: 'b' }]);
});

const step = (number: number, name: string, from: string, to: string, state: 'success' | 'failure' = 'success') => ({
  number,
  name,
  state,
  startedAt: `2026-01-01T10:00:${from}Z`,
  completedAt: `2026-01-01T10:00:${to}Z`,
});

test('a job log is split into its steps by time and by where each step starts', () => {
  const job = {
    id: 3,
    runId: 1,
    name: 'test',
    state: 'failure' as const,
    url: 'u',
    steps: [
      step(1, 'Set up job', '00', '01'),
      // Starts in the same second as the setup ends: the `Run` header says where.
      step(2, 'Run actions/checkout@v4', '01', '02'),
      step(3, 'Test', '05', '09', 'failure'),
      step(4, 'Post Run actions/checkout@v4', '09', '09'),
      step(5, 'Complete job', '10', '10'),
    ],
  };
  const t = (s: string, line: string) => `2026-01-01T10:00:${s}.1234567Z ${line}`;
  const log = [
    `﻿${t('00', 'Current runner version')}`,
    t('00', '##[group]Operating System'),
    t('01', 'Ubuntu'),
    t('01', '##[endgroup]'),
    t('01', '##[group]Run actions/checkout@v4'),
    t('01', 'with:'),
    t('01', '##[endgroup]'),
    t('02', '##[command]/usr/bin/git version'),
    t('05', '##[group]Run npm test'),
    t('05', '\x1b[36;1mnpm test\x1b[0m'),
    t('05', '##[endgroup]'),
    t('07', ' ✓ passes'),
    t('08', '##[error]AssertionError: expected 1 to be 2'),
    t('09', '##[error]Process completed with exit code 1.'),
    t('09', 'Post job cleanup.'),
    t('09', '##[command]/usr/bin/git version'),
    t('10', 'Cleaning up orphan processes'),
    '',
  ].join('\n');
  const parsed = parseJobLog(log, job);
  assert.deepEqual(
    parsed.steps.map((s) => s.lines.map((l) => (l.k ? `${l.k}:${l.t}` : l.t))),
    [
      ['Current runner version', 'group:Operating System', 'Ubuntu'],
      ['group:Run actions/checkout@v4', 'with:', 'command:/usr/bin/git version'],
      ['group:Run npm test', '\x1b[36;1mnpm test\x1b[0m', ' ✓ passes', 'error:AssertionError: expected 1 to be 2', 'error:Process completed with exit code 1.'],
      ['Post job cleanup.', 'command:/usr/bin/git version'],
      ['Cleaning up orphan processes'],
    ],
  );
  assert.equal(parsed.open, 3);
  assert.equal(parsed.steps[2].firstError, 3);
  assert.equal(parsed.steps[0].firstError, -1);
});

test('long steps keep their end; a log without steps is one', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
  const parsed = parseJobLog(lines, { id: 1, runId: 1, name: 'x', state: 'success', url: 'u', steps: [] }, 4);
  assert.equal(parsed.steps.length, 1);
  assert.deepEqual(parsed.steps[0].lines.map((l) => l.t), ['line 6', 'line 7', 'line 8', 'line 9']);
  assert.equal(parsed.steps[0].skipped, 6);
  assert.equal(parsed.open, 1);
  assert.equal(logLine('##[endgroup]'), null);
  assert.deepEqual(logLine('##[warning]careful'), { t: 'careful', k: 'warning' });
  assert.deepEqual(logLine('plain ##[error] mid-line'), { t: 'plain ##[error] mid-line' });
});

test('ANSI colours become styled runs', () => {
  assert.deepEqual(ansiRuns('plain'), [{ text: 'plain' }]);
  assert.deepEqual(ansiRuns('\x1b[31mred\x1b[39m and \x1b[1;32mbold green\x1b[0m'), [
    { text: 'red', fg: 1 },
    { text: ' and ' },
    { text: 'bold green', fg: 2, bold: true },
  ]);
  assert.deepEqual(ansiRuns('\x1b[90mgrey\x1b[2m dim\x1b[22m\x1b[39m!'), [{ text: 'grey', fg: 8 }, { text: ' dim', fg: 8, dim: true }, { text: '!' }]);
  assert.deepEqual(ansiRuns('\x1b[41;1m FAIL \x1b[22m\x1b[49m x'), [{ text: ' FAIL ', bg: 1, bold: true }, { text: ' x' }]);
  assert.deepEqual(ansiRuns('\x1b[7m RUN \x1b[27m'), [{ text: ' RUN ', inverse: true }]);
  assert.deepEqual(ansiRuns('\x1b[38;5;196mred\x1b[38;2;1;2;3mtrue\x1b[0m'), [{ text: 'red', fg: 1 }, { text: 'true' }]);
  // Cursor moves and erases are dropped.
  assert.equal(stripAnsi('\x1b[2K\x1b[1Gdone \x1b[32m✓\x1b[39m'), 'done ✓');
});

test('durations and counts', () => {
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(192_000), '3m 12s');
  assert.equal(formatDuration(3_840_000), '1h 4m');
  const now = Date.parse('2026-01-01T10:02:00Z');
  assert.equal(duration('running', '2026-01-01T10:00:00Z', null, now), 120_000);
  assert.equal(duration('success', '2026-01-01T10:00:00Z', '2026-01-01T10:00:30Z', now), 30_000);
  assert.equal(duration('pending', '2026-01-01T10:00:00Z', null, now), null);
  assert.equal(describeCounts({ total: 5, done: 3, success: 2, failure: 1, running: 1, pending: 1 }), '1 failed, 1 running, 1 queued, 2 passed');
  assert.equal(describeCounts(countStates([{ state: 'skipped' }, { state: 'success' }])), '1 passed, 1 skipped or cancelled');
});
