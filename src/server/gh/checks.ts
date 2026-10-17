// CI on GitHub: a commit's checks (one GraphQL query), many commits' combined states at once (for
// the commit list), an Actions job's steps and log, and re-running or cancelling a workflow run.

import { GithubError, graphql, rest } from './client.ts';
import { needGhRepos } from './context.ts';
import { toCommitChecks, rollupState, toJobInfo } from './checks-map.ts';
import { parseJobLog } from './joblog.ts';
import type { GetRoute, PostRoute } from './routes.ts';
import type { CommitChecks, JobInfo, JobLog, RollupState } from '../../shared/gh-checks.ts';
import type { Repo } from '../repo.ts';

const SHA = /^[0-9a-f]{40}$/;

function sha(value: unknown): string {
  const s = String(value ?? '');
  if (!SHA.test(s)) throw new GithubError(`Not a full commit SHA: ${s}`, 400);
  return s;
}

function id(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new GithubError(`Not an id: ${value}`, 400);
  return n;
}

const CHECKS_QUERY = `query CommitChecks($owner: String!, $name: String!, $sha: GitObjectID!, $pr: Int = 0, $hasPr: Boolean = false) {
  repository(owner: $owner, name: $name) {
    object(oid: $sha) {
      ... on Commit {
        statusCheckRollup {
          state
          contexts(first: 100) {
            nodes {
              __typename
              ... on CheckRun {
                databaseId name status conclusion startedAt completedAt detailsUrl
                isRequired(pullRequestNumber: $pr) @include(if: $hasPr)
                checkSuite { app { name slug } workflowRun { databaseId runNumber url event workflow { name } } }
              }
              ... on StatusContext {
                context state description targetUrl createdAt
                isRequired(pullRequestNumber: $pr) @include(if: $hasPr)
              }
            }
          }
        }
      }
    }
  }
}`;

/** A commit's checks; `pr` (the pull request it heads) also says which are required. */
export async function commitChecks(repo: Repo, commit: string, pr?: number): Promise<CommitChecks> {
  const r = await needGhRepos(repo);
  const d = await graphql(CHECKS_QUERY, { owner: r.owner, name: r.name, sha: commit, pr: pr ?? 0, hasPr: !!pr });
  return toCommitChecks(commit, d.repository?.object ?? null);
}

/** Combined states of many commits, 50 aliases per query; a commit GitHub doesn't have is null. */
export async function rollups(repo: Repo, shas: string[]): Promise<Record<string, RollupState | null>> {
  const r = await needGhRepos(repo);
  const out: Record<string, RollupState | null> = {};
  for (let i = 0; i < shas.length; i += 50) {
    const chunk = shas.slice(i, i + 50);
    const vars = chunk.map((_, j) => `$s${j}: GitObjectID!`).join(', ');
    const fields = chunk.map((_, j) => `c${j}: object(oid: $s${j}) { ... on Commit { statusCheckRollup { state } } }`).join('\n');
    const d = await graphql(
      `query ChecksRollups($owner: String!, $name: String!, ${vars}) { repository(owner: $owner, name: $name) { ${fields} } }`,
      { owner: r.owner, name: r.name, ...Object.fromEntries(chunk.map((s, j) => [`s${j}`, s])) },
    );
    chunk.forEach((s, j) => (out[s] = rollupState(d.repository?.[`c${j}`]?.statusCheckRollup?.state)));
  }
  return out;
}

async function job(repo: Repo, jobId: number): Promise<JobInfo> {
  const r = await needGhRepos(repo);
  return toJobInfo(await rest('GET', `/repos/${r.base}/actions/jobs/${jobId}`));
}

/** The job's log, split into its steps; GitHub only has it once the job is over. */
async function jobLog(repo: Repo, jobId: number): Promise<JobLog> {
  const r = await needGhRepos(repo);
  const info = await job(repo, jobId);
  let text: string;
  try {
    text = await rest<string>('GET', `/repos/${r.base}/actions/jobs/${jobId}/logs`, undefined, { text: true });
  } catch (e) {
    if (e instanceof GithubError && (e.status === 404 || e.status === 410)) {
      throw new GithubError(
        info.state === 'running' || info.state === 'pending'
          ? 'GitHub has the log once the job finishes; until then, see it on GitHub.'
          : "GitHub doesn't have this job's log any more (logs expire).",
        e.status,
      );
    }
    throw e;
  }
  return parseJobLog(text, info);
}

/** Re-run or cancel: GitHub answers 201/202 with an empty object, read as text and dropped. */
const post = async (repo: Repo, path: string) => {
  const r = await needGhRepos(repo);
  await rest('POST', `/repos/${r.base}/actions/${path}`, undefined, { text: true });
  return null;
};

export const checksGet: Record<string, GetRoute> = {
  checks: (repo, q) => commitChecks(repo, sha(q.get('sha')), q.get('pr') ? id(q.get('pr')) : undefined),
  checksRollups: (repo, q) => rollups(repo, [...new Set((q.get('shas') ?? '').split(',').filter(Boolean).map(sha))]),
  checksJob: (repo, q) => job(repo, id(q.get('job'))),
  checksLog: (repo, q) => jobLog(repo, id(q.get('job'))),
};

export const checksPost: Record<string, PostRoute> = {
  checksRerunFailed: (repo, b) => post(repo, `runs/${id(b.run)}/rerun-failed-jobs`),
  checksRerun: (repo, b) => post(repo, `runs/${id(b.run)}/rerun`),
  checksRerunJob: (repo, b) => post(repo, `jobs/${id(b.job)}/rerun`),
  checksCancel: (repo, b) => post(repo, `runs/${id(b.run)}/cancel`),
};
