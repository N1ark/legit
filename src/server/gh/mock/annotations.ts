// Fake check run annotations for the demo's CI (mock/checks.ts): once a job is over, lint warns of
// parser.ts's unused import and notes its loop's complexity, a failed test job fails on the line it
// tripped on, and the build notes a deprecation on the workflow. Each is put on the line that reads
// so at the run's commit, so a push that fixes it makes it go.

import { GithubError } from '../client.ts';
import type { Git } from '../../git.ts';
import { type Job, type Run, ensure, jobStatus } from './checks.ts';
import { db, onRest } from './registry.ts';

interface Fixture {
  job: Job['name'];
  failed?: boolean;
  path: string;
  /** The first line containing this, else `line`. */
  find?: string;
  line?: number;
  span?: number;
  level: 'notice' | 'warning' | 'failure';
  title: string;
  message: string;
}

const FIXTURES: Fixture[] = [
  {
    job: 'test', failed: true, path: 'src/parser.ts', find: 'throw new ParseError(`expected {', level: 'failure',
    title: 'parser > reports the line of a missing brace',
    message: "AssertionError: expected 'line 1' to be 'line 3' // Object.is equality\n\n- Expected\n+ Received\n\n- line 3\n+ line 1\n\n ❯ src/parser.ts:16:84\n ❯ test/parser.test.ts:42:31",
  },
  { job: 'test', failed: true, path: 'test/parser.test.ts', line: 42, level: 'failure', title: 'parser > reports the line of a missing brace', message: "AssertionError: expected 'line 1' to be 'line 3'" },
  { job: 'lint', path: 'src/parser.ts', find: 'type Token', level: 'warning', title: '@typescript-eslint/no-unused-vars', message: "'Token' is defined but never used." },
  {
    job: 'lint', path: 'src/parser.ts', find: "while (tokens[i] && tokens[i].text !== '}')", span: 5, level: 'notice', title: 'complexity',
    message: 'This loop takes four tokens per property without looking at them: a missing `:` or `;` shifts every property after it.',
  },
  { job: 'build', path: '.github', line: 1, level: 'notice', title: 'Deprecation', message: 'Node.js 16 actions are deprecated. Please update the following actions to use Node.js 20: actions/cache@v3.' },
];

const git = (): Git | undefined => db.reviewGit;

async function notes(run: Run, j: Job) {
  const s = jobStatus(j);
  if (s.status !== 'completed') return [];
  const out = [];
  for (const f of FIXTURES) {
    if (f.job !== j.name || (f.failed && s.conclusion !== 'failure')) continue;
    let line = f.line ?? 0;
    if (f.find) {
      const text = await git()?.text(['show', `${run.sha}:${f.path}`], { allowFail: true });
      line = (text ?? '').split('\n').findIndex((l) => l.includes(f.find!)) + 1;
    }
    if (line < 1) continue;
    out.push({
      path: f.path,
      blob_href: `https://github.com/acme/widgets/blob/${run.sha}/${f.path}`,
      start_line: line,
      end_line: line + (f.span ?? 1) - 1,
      start_column: null,
      end_column: null,
      annotation_level: f.level,
      title: f.title,
      message: f.message,
      raw_details: null,
    });
  }
  return out;
}

const runOf = (sha: string) => (db.checks.runs as Run[]).filter((r) => r.sha === sha);

onRest('GET /repos/:owner/:repo/commits/:sha/check-runs', async (p) => {
  ensure();
  const check_runs = [];
  for (const run of runOf(p.sha)) {
    for (const j of run.jobs) {
      const s = jobStatus(j);
      check_runs.push({
        id: j.id,
        name: j.name,
        head_sha: run.sha,
        status: s.status,
        conclusion: s.conclusion,
        html_url: `https://github.com/acme/widgets/actions/runs/${run.id}/job/${j.id}`,
        details_url: `https://github.com/acme/widgets/actions/runs/${run.id}/job/${j.id}`,
        output: { title: null, summary: null, annotations_count: (await notes(run, j)).length },
      });
    }
  }
  return { total_count: check_runs.length, check_runs };
});

onRest('GET /repos/:owner/:repo/check-runs/:id/annotations', async (p, q) => {
  for (const run of db.checks.runs as Run[]) {
    const j = run.jobs.find((x) => x.id === Number(p.id));
    if (!j) continue;
    const page = Number(q.get('page') ?? 1);
    const per = Number(q.get('per_page') ?? 30);
    return (await notes(run, j)).slice((page - 1) * per, page * per);
  }
  throw new GithubError('GitHub: Not Found', 404);
});
