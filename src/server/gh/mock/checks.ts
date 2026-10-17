// Fake CI for the demo repo's pushed branches: feature/parser all green (and codecov's statuses),
// feature/parser-errors with a failing test job and a lint job that finishes a minute in,
// feature/pretty-errors queued for a few minutes. Jobs run on the clock: each has a start and an
// end, and its status is whatever the time says, so polling sees them progress. A commit pushed
// later gets a fresh run, and re-running a job starts it again (it passes the second time).

import { GithubError } from '../client.ts';
import { db, onGraphql, onRest } from './registry.ts';

type Kind = 'build' | 'test' | 'lint';
type Conclusion = 'success' | 'failure' | 'cancelled';

interface Job {
  id: number;
  name: Kind;
  queuedAt: number;
  startAt: number;
  endAt: number;
  conclusion: Conclusion;
  cancelledAt?: number;
}

interface Run {
  id: number;
  runNumber: number;
  attempt: number;
  event: string;
  sha: string;
  jobs: Job[];
}

interface Status {
  context: string;
  state: 'SUCCESS' | 'PENDING' | 'FAILURE';
  description: string;
  targetUrl: string;
  createdAt: string;
}

const checks = (db.checks = {
  runs: [] as Run[],
  statuses: {} as Record<string, Status[]>,
  /** SHAs already given their fixtures; null until the first call snapshots origin's tips. */
  seen: null as Set<string> | null,
  nextRun: 11_420_000_000,
  nextJob: 31_870_000_000,
  runNumber: 44,
});

const S = 1000;
const MIN = 60 * S;
const KINDS: Kind[] = ['build', 'test', 'lint'];
const LENGTH: Record<Kind, number> = { build: 48 * S, test: 72 * S, lint: 31 * S };

function newRun(sha: string, event: string, runNumber: number, jobs: Omit<Job, 'id'>[]): Run {
  const run = { id: checks.nextRun++, runNumber, attempt: 1, event, sha, jobs: jobs.map((j) => ({ ...j, id: checks.nextJob++ })) };
  checks.runs.push(run);
  return run;
}

/** A job that queued `ago` ms ago, waited `wait`, and runs for its usual length. */
const timed = (name: Kind, ago: number, wait: number, conclusion: Conclusion = 'success', length = LENGTH[name]): Omit<Job, 'id'> => {
  const queuedAt = Date.now() - ago;
  return { name, queuedAt, startAt: queuedAt + wait, endAt: queuedAt + wait + length, conclusion };
};

const status = (context: string, state: Status['state'], description: string, ago: number): Status => ({
  context,
  state,
  description,
  targetUrl: 'https://app.codecov.io/gh/acme/widgets/pull/12',
  createdAt: new Date(Date.now() - ago).toISOString(),
});

/** Give the demo's pushed tips their fixtures the first time any is asked about; later pushes a fresh run. */
function ensure() {
  const tips = db.tips as Record<string, string>;
  const origin = (b: string) => tips[`origin/${b}`];
  if (!checks.seen) {
    checks.seen = new Set();
    if (origin('main')) newRun(origin('main'), 'push', 38, KINDS.map((k) => timed(k, 3 * 60 * MIN, 4 * S)));
    if (origin('feature/parser')) {
      newRun(origin('feature/parser'), 'pull_request', 41, KINDS.map((k) => timed(k, 42 * MIN, 6 * S)));
      checks.statuses[origin('feature/parser')] = [
        status('codecov/patch', 'SUCCESS', '92.31% of diff hit (target 80.00%)', 39 * MIN),
        status('codecov/project', 'SUCCESS', '87.40% (+0.52%) compared to 8e5bc2d', 39 * MIN),
      ];
    }
    if (origin('feature/parser-errors')) {
      newRun(origin('feature/parser-errors'), 'pull_request', 43, [
        timed('build', 9 * MIN, 5 * S),
        timed('test', 9 * MIN, 5 * S, 'failure', 64 * S),
        timed('lint', 20 * S, 5 * S, 'success', 70 * S),
      ]);
    }
    if (origin('feature/pretty-errors')) {
      newRun(origin('feature/pretty-errors'), 'pull_request', 44, KINDS.map((k) => timed(k, 30 * S, 3 * MIN)));
    }
    for (const [ref, sha] of Object.entries(tips)) if (ref.startsWith('origin/')) checks.seen.add(sha);
  }
  for (const [ref, sha] of Object.entries(tips)) {
    if (!ref.startsWith('origin/') || ref === 'origin/HEAD' || checks.seen.has(sha)) continue;
    checks.seen.add(sha);
    newRun(sha, 'pull_request', ++checks.runNumber, KINDS.map((k, i) => timed(k, 0, 5 * S + i * 2 * S)));
  }
}

function jobStatus(j: Job, now = Date.now()): { status: string; conclusion: string | null } {
  if (j.cancelledAt !== undefined && j.cancelledAt <= now) return { status: 'completed', conclusion: 'cancelled' };
  if (now < j.startAt) return { status: 'queued', conclusion: null };
  if (now < j.endAt) return { status: 'in_progress', conclusion: null };
  return { status: 'completed', conclusion: j.conclusion };
}

const iso = (ms: number) => new Date(ms).toISOString();
const findJob = (id: string) => {
  for (const run of checks.runs) for (const job of run.jobs) if (job.id === Number(id)) return { run, job };
  throw new GithubError('GitHub: Not Found', 404);
};
const findRun = (id: string) => {
  const run = checks.runs.find((r) => r.id === Number(id));
  if (!run) throw new GithubError('GitHub: Not Found', 404);
  return run;
};

function checkRunNode(run: Run, j: Job, required: boolean | undefined) {
  const s = jobStatus(j);
  const ended = s.status === 'completed' ? Math.min(j.cancelledAt ?? Infinity, j.endAt) : null;
  return {
    __typename: 'CheckRun',
    databaseId: j.id,
    name: j.name,
    status: s.status.toUpperCase(),
    conclusion: s.conclusion?.toUpperCase() ?? null,
    startedAt: iso(s.status === 'queued' ? j.queuedAt : j.startAt),
    completedAt: ended === null ? null : iso(ended),
    detailsUrl: `https://github.com/acme/widgets/actions/runs/${run.id}/job/${j.id}`,
    ...(required === undefined ? {} : { isRequired: required }),
    checkSuite: {
      app: { name: 'GitHub Actions', slug: 'github-actions' },
      workflowRun: {
        databaseId: run.id,
        runNumber: run.runNumber,
        url: `https://github.com/acme/widgets/actions/runs/${run.id}`,
        event: run.event,
        workflow: { name: 'CI' },
      },
    },
  };
}

/** The commit's statusCheckRollup; `isRequired` only when asked for (a pull request's head), where build and test are. */
function rollup(sha: string, withRequired = false) {
  const nodes = [
    ...checks.runs.filter((r) => r.sha === sha).flatMap((r) => r.jobs.map((j) => checkRunNode(r, j, withRequired ? j.name !== 'lint' : undefined))),
    ...(checks.statuses[sha] ?? []).map((s) => ({ __typename: 'StatusContext', ...s, ...(withRequired ? { isRequired: false } : {}) })),
  ];
  if (!nodes.length) return null;
  const states = nodes.map((n: any) => (n.__typename === 'StatusContext' ? n.state : n.status === 'COMPLETED' ? n.conclusion : 'PENDING'));
  const state = states.some((s) => s === 'FAILURE' || s === 'CANCELLED') ? 'FAILURE' : states.some((s) => s === 'PENDING') ? 'PENDING' : 'SUCCESS';
  return { state, contexts: { nodes } };
}

onGraphql('CommitChecks', (v) => {
  ensure();
  return { repository: { object: { statusCheckRollup: rollup(v.sha, !!v.hasPr) } } };
});

onGraphql('ChecksRollups', (v) => {
  ensure();
  const repository: Record<string, unknown> = {};
  for (const [k, sha] of Object.entries(v)) {
    const m = /^s(\d+)$/.exec(k);
    if (!m) continue;
    const r = rollup(sha as string);
    repository[`c${m[1]}`] = { statusCheckRollup: r && { state: r.state } };
  }
  return { repository };
});

// ---- steps and logs ----

const STEPS = ['Set up job', 'Run actions/checkout@v4', 'Run actions/setup-node@v4', 'Run npm ci', '', 'Post Run actions/setup-node@v4', 'Post Run actions/checkout@v4', 'Complete job'];
const WEIGHTS = [2, 1, 3, 8, 12, 1, 1, 1];
const COMMAND: Record<Kind, string> = { build: 'npm run build', test: 'npm test', lint: 'npm run lint' };

/** Each step's [start, end], spread over the job's time by weight. */
function stepTimes(j: Job): [number, number][] {
  const total = WEIGHTS.reduce((a, b) => a + b, 0);
  let at = j.startAt;
  return WEIGHTS.map((w) => {
    const from = at;
    at += ((j.endAt - j.startAt) * w) / total;
    return [Math.round(from), Math.round(at)];
  });
}

function jobJson(run: Run, j: Job) {
  const s = jobStatus(j);
  const now = Date.now();
  const times = stepTimes(j);
  const cut = j.cancelledAt ?? Infinity;
  const steps =
    s.status === 'queued'
      ? []
      : STEPS.map((name, i) => {
          const [from, to] = times[i];
          const label = name || `Run ${COMMAND[j.name]}`;
          const base = { name: label, number: i + 1 };
          if (from >= cut) return { ...base, status: 'completed', conclusion: 'skipped', started_at: iso(cut), completed_at: iso(cut) };
          if (now < from) return { ...base, status: 'queued', conclusion: null, started_at: null, completed_at: null };
          if (now < to && to <= cut) return { ...base, status: 'in_progress', conclusion: null, started_at: iso(from), completed_at: null };
          if (to > cut) return { ...base, status: 'completed', conclusion: 'cancelled', started_at: iso(from), completed_at: iso(cut) };
          const failed = j.conclusion === 'failure' && i === 4;
          return { ...base, status: 'completed', conclusion: failed ? 'failure' : 'success', started_at: iso(from), completed_at: iso(to) };
        });
  return {
    id: j.id,
    run_id: run.id,
    run_attempt: run.attempt,
    head_sha: run.sha,
    name: j.name,
    workflow_name: 'CI',
    status: s.status,
    conclusion: s.conclusion,
    created_at: iso(j.queuedAt),
    started_at: iso(j.startAt),
    completed_at: s.status === 'completed' ? iso(Math.min(cut, j.endAt)) : null,
    html_url: `https://github.com/acme/widgets/actions/runs/${run.id}/job/${j.id}`,
    runner_name: 'GitHub Actions 41',
    labels: ['ubuntu-latest'],
    steps,
  };
}

const E = '\x1b[';
const c = (code: string, text: string) => `${E}${code}m${text}${E}0m`;

function mainStepLines(j: Job): string[] {
  const head = [`##[group]Run ${COMMAND[j.name]}`, c('36;1', COMMAND[j.name]), 'shell: /usr/bin/bash -e {0}', '##[endgroup]', ''];
  if (j.name === 'build') {
    return [
      ...head,
      '> widgets@0.3.0 build',
      '> tsc -p tsconfig.json && vite build',
      '',
      `${E}36mvite v5.4.10 ${E}32mbuilding for production...${E}39m`,
      'transforming...',
      `${E}32m✓${E}39m 48 modules transformed.`,
      'rendering chunks...',
      'computing gzip size...',
      `${E}2mdist/${E}22m${E}36mwidgets.js  ${E}39m${E}1m${E}2m 41.27 kB${E}22m${E}1m${E}22m${E}2m │ gzip: 12.04 kB${E}22m`,
      `${E}2mdist/${E}22m${E}36mwidgets.cjs ${E}39m${E}1m${E}2m 41.80 kB${E}22m${E}1m${E}22m${E}2m │ gzip: 12.11 kB${E}22m`,
      `${E}32m✓ built in 1.84s${E}39m`,
    ];
  }
  if (j.name === 'lint') {
    return [...head, '> widgets@0.3.0 lint', '> eslint . && prettier --check .', '', 'Checking formatting...', 'All matched files use Prettier code style!'];
  }
  const failed = j.conclusion === 'failure';
  const suites = [
    ['test/tokenizer.test.ts', 14, 12],
    ['test/spec.test.ts', 22, 31],
    ['test/cache.test.ts', 6, 9],
    ['test/cli.test.ts', 11, 140],
  ] as const;
  const out = [...head, '> widgets@0.3.0 test', '> vitest run --reporter=default --reporter=github-actions', '', ` ${c('7;1;36', ' RUN ')} ${c('36', 'v2.1.4 ')}${c('90', '/home/runner/work/widgets/widgets')}`, ''];
  for (const [file, n, ms] of suites) out.push(` ${c('32', '✓')} ${file} ${E}2m(${E}22m${E}2m${n} tests${E}22m${E}2m)${E}22m${c('90', ` ${ms}ms`)}`);
  if (!failed) {
    out.push(` ${c('32', '✓')} test/parser.test.ts ${E}2m(${E}22m${E}2m9 tests${E}22m${E}2m)${E}22m${c('90', ' 21ms')}`);
    out.push('', `${c('2', ' Test Files ')} ${c('1;32', '5 passed')}${c('90', ' (5)')}`, `${c('2', '      Tests ')} ${c('1;32', '62 passed')}${c('90', ' (62)')}`);
    out.push(`${c('2', '   Start at ')} ${iso(j.startAt).slice(11, 19)}`, `${c('2', '   Duration ')} 1.62s`, '');
    return out;
  }
  for (const t of ['tokenizes nested braces', 'parses a widget with no fields', 'parses numeric fields', 'keeps field order']) out.push(`   ${c('32', '✓')} parser ${c('2', '>')} ${t}`);
  out.push(
    ` ${c('31', '❯')} test/parser.test.ts ${E}2m(${E}22m${E}2m9 tests${E}22m${E}2m | ${E}22m${c('31', '1 failed')}${E}2m)${E}22m${c('90', ' 21ms')}`,
    `   ${c('31', '×')} parser ${c('2', '>')} reports the line of a missing brace${c('90', ' 7ms')}`,
    `${c('31', "     → expected 'line 1' to be 'line 3' // Object.is equality")}`,
    '',
    c('31', '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'),
    '',
    `${c('41;1', ' FAIL ')} test/parser.test.ts ${c('2', '>')} parser ${c('2', '>')} reports the line of a missing brace`,
    `${c('31;1', 'AssertionError')}${c('31', ": expected 'line 1' to be 'line 3' // Object.is equality")}`,
    '',
    `${c('32', '- Expected')}`,
    `${c('31', '+ Received')}`,
    '',
    `${c('32', '- line 3')}`,
    `${c('31', '+ line 1')}`,
    '',
    `${c('36', ` ${c('2', '❯')} test/parser.test.ts:${c('2', '42:31')}`)}`,
    `    ${c('90', ' 40|')}   ${c('35', 'const')} err ${c('33', '=')} ${c('34', 'catchError')}(() ${c('33', '=>')} ${c('34', 'parse')}(${c('32', '"widget {\\n  size: 3\\n"')}))`,
    `    ${c('90', ' 41|')}   ${c('34', 'expect')}(err)${c('33', '.')}${c('34', 'toBeInstanceOf')}(ParseError)`,
    `    ${c('90', ' 42|')}   ${c('34', 'expect')}(err${c('33', '.')}where)${c('33', '.')}${c('34', 'toBe')}(${c('32', "'line 3'")})`,
    `    ${c('90', '   |')}                               ${c('31', '^')}`,
    `    ${c('90', ' 43|')} })`,
    `    ${c('90', ' 44|')}`,
    '',
    c('31', '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯'),
    '',
    "##[error]AssertionError: expected 'line 1' to be 'line 3' // Object.is equality",
    '',
    `${c('2', ' Test Files ')} ${c('1;31', '1 failed')}${c('2', ' | ')}${c('1;32', '4 passed')}${c('90', ' (5)')}`,
    `${c('2', '      Tests ')} ${c('1;31', '1 failed')}${c('2', ' | ')}${c('1;32', '61 passed')}${c('90', ' (62)')}`,
    `${c('2', '   Start at ')} ${iso(j.startAt).slice(11, 19)}`,
    `${c('2', '   Duration ')} 1.71s ${c('2', '(transform 312ms, setup 0ms, collect 1.02s, tests 219ms, environment 1ms, prepare 1.12s)')}`,
    '',
    '##[error]Process completed with exit code 1.',
  );
  return out;
}

function stepLines(i: number, j: Job, run: Run): string[] {
  switch (i) {
    case 0:
      return [
        "Current runner version: '2.320.0'",
        '##[group]Operating System',
        'Ubuntu',
        '22.04.5',
        'LTS',
        '##[endgroup]',
        '##[group]Runner Image',
        'Image: ubuntu-22.04',
        'Version: 20241013.1.0',
        '##[endgroup]',
        '##[group]GITHUB_TOKEN Permissions',
        'Contents: read',
        'Metadata: read',
        'PullRequests: read',
        '##[endgroup]',
        'Secret source: Actions',
        'Prepare workflow directory',
        'Prepare all required actions',
        'Getting action download info',
        "Download action repository 'actions/checkout@v4' (SHA:11bd71901bbe5b1630ceea73d27597364c9af683)",
        "Download action repository 'actions/setup-node@v4' (SHA:39370e3970a6d050c480ffad4ff0ed4d3fdee5af)",
        `Complete job name: ${j.name}`,
      ];
    case 1:
      return [
        '##[group]Run actions/checkout@v4',
        'with:',
        '  repository: acme/widgets',
        '  token: ***',
        '  fetch-depth: 1',
        '##[endgroup]',
        'Syncing repository: acme/widgets',
        '##[group]Getting Git version info',
        "Working directory is '/home/runner/work/widgets/widgets'",
        '##[command]/usr/bin/git version',
        'git version 2.47.0',
        '##[endgroup]',
        '##[group]Fetching the repository',
        `##[command]/usr/bin/git -c protocol.version=2 fetch --no-tags --prune --no-recurse-submodules --depth=1 origin +${run.sha}:refs/remotes/origin/head`,
        `From https://github.com/acme/widgets`,
        ` * [new ref]         ${run.sha} -> origin/head`,
        '##[endgroup]',
        '##[group]Checking out the ref',
        '##[command]/usr/bin/git checkout --progress --force refs/remotes/origin/head',
        `HEAD is now at ${run.sha.slice(0, 7)}`,
        '##[endgroup]',
        `##[command]/usr/bin/git log -1 --format=%H`,
        run.sha,
      ];
    case 2:
      return [
        '##[group]Run actions/setup-node@v4',
        'with:',
        '  node-version: 22',
        '  cache: npm',
        '##[endgroup]',
        'Found in cache @ /opt/hostedtoolcache/node/22.11.0/x64',
        '##[group]Environment details',
        'node: v22.11.0',
        'npm: 10.9.0',
        'yarn: 1.22.22',
        '##[endgroup]',
        '##[command]/opt/hostedtoolcache/node/22.11.0/x64/bin/npm config get cache',
        '/home/runner/.npm',
        'Cache hit for: node-cache-Linux-x64-npm-5d0bd5d1c6a5c2f2e8a1b3f4c7d9e0a1',
        'Received 21734512 of 21734512 (100.0%), 41.2 MBs/sec',
        'Cache Size: ~21 MB (21734512 B)',
        'Cache restored successfully',
      ];
    case 3:
      return [
        '##[group]Run npm ci',
        c('36;1', 'npm ci'),
        'shell: /usr/bin/bash -e {0}',
        '##[endgroup]',
        '',
        'added 312 packages, and audited 313 packages in 6s',
        '',
        '84 packages are looking for funding',
        '  run `npm fund` for details',
        '',
        `found ${E}32m${E}1m0${E}22m${E}39m vulnerabilities`,
      ];
    case 4:
      return mainStepLines(j);
    case 5:
      return ['Post job cleanup.', 'Cache hit occurred on the primary key node-cache-Linux-x64-npm-5d0bd5d1c6a5c2f2e8a1b3f4c7d9e0a1, not saving cache.'];
    case 6:
      return [
        'Post job cleanup.',
        '##[command]/usr/bin/git version',
        'git version 2.47.0',
        '##[command]/usr/bin/git config --local --name-only --get-regexp core\\.sshCommand',
        "##[command]/usr/bin/git submodule foreach --recursive sh -c \"git config --local --name-only --get-regexp 'core\\.sshCommand' && git config --local --unset-all 'core.sshCommand' || :\"",
      ];
    default:
      return ['Cleaning up orphan processes'];
  }
}

/** The log as GitHub serves it: every line stamped, steps one after the other. */
function jobLog(run: Run, j: Job): string {
  const times = stepTimes(j);
  const out: string[] = [];
  STEPS.forEach((_, i) => {
    const lines = stepLines(i, j, run);
    const [from, to] = times[i];
    lines.forEach((l, k) => {
      const at = from + ((to - from) * k) / lines.length;
      if (at < (j.cancelledAt ?? Infinity)) out.push(`${iso(at).replace('Z', '0000Z')} ${l}`);
    });
  });
  return `﻿${out.join('\n')}\n`;
}

onRest('GET /repos/:owner/:repo/actions/jobs/:id', (p) => {
  const { run, job } = findJob(p.id);
  return jobJson(run, job);
});

onRest('GET /repos/:owner/:repo/actions/jobs/:id/logs', (p) => {
  const { run, job } = findJob(p.id);
  if (jobStatus(job).status !== 'completed') throw new GithubError('GitHub: Not Found', 404);
  return jobLog(run, job);
});

// ---- re-running and cancelling ----

function refuseWhileRunning(run: Run) {
  if (run.jobs.some((j) => jobStatus(j).status !== 'completed')) {
    throw new GithubError(`GitHub: This workflow is already running`, 403);
  }
}

function restart(run: Run, jobs: Job[]) {
  run.attempt++;
  jobs.forEach((j, i) => {
    Object.assign(j, timed(j.name, 0, 6 * S + i * 3 * S, 'success', 35 * S));
    delete j.cancelledAt;
    j.id = checks.nextJob++;
  });
}

onRest('POST /repos/:owner/:repo/actions/runs/:id/rerun-failed-jobs', (p) => {
  const run = findRun(p.id);
  refuseWhileRunning(run);
  const failed = run.jobs.filter((j) => jobStatus(j).conclusion !== 'success');
  if (!failed.length) throw new GithubError('GitHub: This workflow run has no failed jobs', 403);
  restart(run, failed);
  return {};
});

onRest('POST /repos/:owner/:repo/actions/runs/:id/rerun', (p) => {
  const run = findRun(p.id);
  refuseWhileRunning(run);
  restart(run, run.jobs);
  return {};
});

onRest('POST /repos/:owner/:repo/actions/jobs/:id/rerun', (p) => {
  const { run, job } = findJob(p.id);
  refuseWhileRunning(run);
  restart(run, [job]);
  return {};
});

onRest('POST /repos/:owner/:repo/actions/runs/:id/cancel', (p) => {
  const run = findRun(p.id);
  const now = Date.now();
  const going = run.jobs.filter((j) => jobStatus(j, now).status !== 'completed');
  if (!going.length) throw new GithubError('GitHub: Cannot cancel a workflow run that is completed.', 409);
  for (const j of going) j.cancelledAt = now;
  return {};
});
