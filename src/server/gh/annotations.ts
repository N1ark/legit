// CI's annotations on a commit's lines (a pull request's head): its check runs (REST, so polling
// it again costs a 304), then the annotations of each run that has any. A finished run's never
// change, so they're kept rather than asked for again.

import { GithubError, MOCK, rest } from './client.ts';
import { needGhRepos } from './context.ts';
import { db } from './mock/registry.ts';
import type { GetRoute } from './routes.ts';
import type { Annotation, AnnotationLevel, CommitAnnotations } from '../../shared/gh-files.ts';
import type { Repo } from '../repo.ts';

/** A commit's runs past this many, or a run's annotations, aren't looked at. */
const MAX_RUNS = 300;
const MAX_NOTES = 500;

const LEVELS: Record<string, AnnotationLevel> = { notice: 'notice', warning: 'warning', failure: 'failure' };

/** A REST check run annotation as the UI shows it; null for one not on a file's lines. */
export function toAnnotation(a: any, run: { id: number; name: string; url: string | null }, k: number): Annotation | null {
  const start = Number(a.start_line);
  if (typeof a.path !== 'string' || !a.path || !Number.isInteger(start) || start < 1) return null;
  const end = Number(a.end_line);
  return {
    key: `${run.id}:${k}`,
    path: a.path,
    startLine: start,
    endLine: Number.isInteger(end) && end >= start ? end : start,
    level: LEVELS[a.annotation_level] ?? 'notice',
    title: a.title || null,
    message: a.message ?? '',
    details: a.raw_details || null,
    check: run.name,
    url: run.url,
  };
}

const done = new Map<string, Annotation[]>();

async function runNotes(base: string, run: any): Promise<Annotation[]> {
  const count = Math.min(MAX_NOTES, run.output?.annotations_count ?? 0);
  const info = { id: run.id as number, name: String(run.name ?? ''), url: run.html_url ?? run.details_url ?? null };
  // A run that's re-run gets a new id; while it's going on, its count says whether there are more.
  const key = `${base}#${run.id}:${count}`;
  const hit = done.get(key);
  if (hit) return hit;
  const raw: any[] = [];
  for (let page = 1; raw.length < count; page++) {
    const got = await rest<any[]>('GET', `/repos/${base}/check-runs/${run.id}/annotations?per_page=100&page=${page}`);
    raw.push(...got);
    if (got.length < 100) break;
  }
  const out = raw.slice(0, count).flatMap((a, k) => toAnnotation(a, info, k) ?? []);
  if (run.status === 'completed') {
    done.set(key, out);
    if (done.size > 200) done.delete(done.keys().next().value!);
  }
  return out;
}

async function annotations(repo: Repo, sha: string): Promise<CommitAnnotations> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new GithubError(`Not a full commit SHA: ${sha}`, 400);
  const r = await needGhRepos(repo);
  if (MOCK) db.reviewGit = repo.git;
  const runs: any[] = [];
  for (let page = 1; runs.length < MAX_RUNS; page++) {
    const got = await rest<{ total_count: number; check_runs: any[] }>('GET', `/repos/${r.base}/commits/${sha}/check-runs?per_page=100&page=${page}`);
    runs.push(...got.check_runs);
    if (got.check_runs.length < 100 || runs.length >= got.total_count) break;
  }
  const noted = runs.filter((run) => (run.output?.annotations_count ?? 0) > 0);
  const lists = await Promise.all(noted.map((run) => runNotes(r.base, run)));
  return { sha, annotations: lists.flat() };
}

export const annotationsGet: Record<string, GetRoute> = {
  annotations: (repo, q) => annotations(repo, q.get('sha') ?? ''),
};
