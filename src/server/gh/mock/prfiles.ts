// Fake per-file "Viewed" marks for the demo's pull requests. A pull request's files
// are `git diff base...head` of origin's branches; a mark keeps the file's blob it was made on, and
// reads DISMISSED once the head's differs. #13 starts with src/errors.ts viewed and src/parser.ts
// viewed before its last push.

import { GithubError } from '../client.ts';
import type { Git } from '../../git.ts';
import { db, onGraphql } from './registry.ts';

/** By pull request, each viewed file's blob when it was marked ('head': whatever the head has, the first time it's asked). */
db.viewed ??= { 13: { 'src/errors.ts': 'head', 'src/parser.ts': '0'.repeat(40) } } as Record<number, Record<string, string>>;
/** Files per page, as tests set it; GitHub's is the query's `first`. */
db.filesPage = 100;

const git = (): Git | undefined => db.reviewGit;
const tip = (b: string): string | undefined => db.tips[`origin/${b}`] ?? db.tips[b];
const pull = (n: number) => db.pulls.find((p: any) => p.number === n);

async function blob(head: string, path: string): Promise<string> {
  return (await git()?.text(['rev-parse', '--verify', '-q', `${head}:${path}`], { allowFail: true })) ?? '';
}

async function prPaths(p: any): Promise<string[]> {
  const g = git();
  const [base, head] = [tip(p.baseRefName), tip(p.headRefName)];
  if (!g || !base || !head) return [];
  const out = await g.text(['diff', '--name-only', '-M', `${base}...${head}`], { allowFail: true });
  return out ? out.split('\n') : [];
}

onGraphql('PrFiles', async (v) => {
  const p = pull(v.number);
  if (!p) return { viewer: { login: db.viewer }, repository: { pullRequest: null } };
  const head = tip(p.headRefName) ?? p.headRefOid;
  const marks: Record<string, string> = (db.viewed[p.number] ??= {});
  const paths = await prPaths(p);
  const from = v.after ? Number(v.after) : 0;
  const page = paths.slice(from, from + db.filesPage);
  const nodes = await Promise.all(
    page.map(async (path) => {
      if (!marks[path]) return { path, viewerViewedState: 'UNVIEWED' };
      const now = await blob(head, path);
      if (marks[path] === 'head') marks[path] = now;
      return { path, viewerViewedState: marks[path] === now ? 'VIEWED' : 'DISMISSED' };
    }),
  );
  const next = from + page.length;
  return {
    ...(v.first ? { viewer: { login: db.viewer } } : {}),
    repository: {
      pullRequest: {
        id: `PR_${p.number}`,
        headRefOid: head,
        files: { pageInfo: { hasNextPage: next < paths.length, endCursor: String(next) }, nodes },
      },
    },
  };
});

async function mark(v: Record<string, any>, on: boolean) {
  const n = Number(String(v.pr).replace('PR_', ''));
  const p = pull(n);
  if (!p) throw new GithubError('GitHub: Could not resolve to a node with the global id.', 200);
  if (!(await prPaths(p)).includes(v.path)) throw new GithubError(`GitHub: Path ${v.path} is not part of the pull request.`, 200);
  const marks: Record<string, string> = (db.viewed[n] ??= {});
  if (on) marks[v.path] = await blob(tip(p.headRefName) ?? '', v.path);
  else delete marks[v.path];
  return { pullRequest: { id: v.pr } };
}

onGraphql('MarkFileViewed', async (v) => ({ markFileAsViewed: await mark(v, true) }));
onGraphql('UnmarkFileViewed', async (v) => ({ unmarkFileAsViewed: await mark(v, false) }));
