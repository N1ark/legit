// Fake review threads on the demo repo's pull requests #12 and #13 (scripts/gh-demo.ts). Commits
// are looked up in the local repo (its origin/ branches are what "GitHub" has), so the fixtures
// survive the demo being regenerated; diff hunks come from `git diff base...commit` as GitHub's do.

import { GithubError } from '../client.ts';
import type { Git } from '../../git.ts';
import { db, onGraphql, onRest } from './registry.ts';

interface MockComment {
  id: string;
  databaseId: number;
  author: string;
  body: string;
  createdAt: string;
  lastEditedAt?: string;
  /** Set while it's part of a pending review. */
  review?: string;
  reactions: Record<string, string[]>;
}

interface MockThread {
  id: string;
  pr: number;
  path: string;
  side: 'LEFT' | 'RIGHT';
  line: number | null;
  startLine?: number;
  /** Index into the pull request's commits (oldest first), or a commit GitHub has that the repo doesn't. */
  commit: number | string;
  /** Where it was made, when that's not where it is now. */
  originalLine?: number;
  originalStartLine?: number;
  outdated?: boolean;
  /** For a commit the repo doesn't have, the hunk as GitHub kept it. */
  hunk?: string;
  file?: boolean;
  resolvedBy?: string;
  comments: MockComment[];
}

let next = 4000;
const ago = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
const say = (author: string, hours: number, body: string, more: Partial<MockComment> = {}): MockComment => {
  const n = next++;
  return { id: `PRRC_${n}`, databaseId: n, author, body, createdAt: ago(hours), reactions: {}, ...more };
};

const OLD = 'c0ffee'.repeat(6) + 'beef';

db.threads = [
  {
    id: 'PRRT_1', pr: 13, path: 'src/errors.ts', side: 'RIGHT', line: 3, commit: 0,
    comments: [
      say('hubot', 50, 'Should the message carry the column too? Editors jump straight to `line:col`.', { reactions: { THUMBS_UP: ['monalisa'] } }),
      say('octocat', 47, "Tokens don't track columns yet. I'll add them in a follow-up and change this then."),
      say('hubot', 30, 'Sounds good :+1:'),
    ],
  },
  {
    id: 'PRRT_2', pr: 13, path: 'src/parser.ts', side: 'RIGHT', line: 16, commit: 1,
    comments: [
      say(
        'monalisa', 26,
        "When the brace is missing this points at the name's line, but the token we tripped on is the useful one:\n\n" +
          "```suggestion\n    if (tokens[i]?.text !== '{') throw new ParseError(`expected { after ${name}`, (tokens[i] ?? tokens[i - 1]).line);\n```",
      ),
    ],
  },
  {
    id: 'PRRT_3', pr: 13, path: 'src/parser.ts', side: 'RIGHT', startLine: 18, line: 22, commit: 1,
    comments: [
      say(
        'hubot', 25,
        "This loop assumes every prop is `key: value;`. A missing `:` or `;` silently shifts everything after it by one token.\n\n" +
          'Worth a `ParseError` here too? Something like:\n\n```ts\nif (tokens[i + 1]?.text !== \':\') throw new ParseError(`expected : after ${key}`, tokens[i].line);\n```',
      ),
    ],
  },
  {
    id: 'PRRT_4', pr: 13, path: 'src/parser.ts', side: 'RIGHT', line: 1, commit: 1, resolvedBy: 'octocat',
    comments: [
      say('monalisa', 28, 'Nit: we usually sort imports.'),
      say('octocat', 27, 'They are sorted: `errors` comes before `tokenizer`.'),
    ],
  },
  {
    id: 'PRRT_5', pr: 13, path: 'src/parser.ts', side: 'RIGHT', line: null, originalLine: 16, commit: OLD, outdated: true,
    hunk:
      "@@ -12,7 +13,7 @@ export function parse(src: string): Spec[] {\n   while (i < tokens.length) {\n     const name = tokens[i++].text;\n" +
      "     const props: Record<string, string> = {};\n-    i++; // '{'\n+    if (tokens[i].text !== '{') throw new Error('expected {');",
    comments: [say('hubot', 70, 'Throw a `ParseError` here, so the line number shows up.'), say('octocat', 69, 'Done, thanks!')],
  },
  {
    id: 'PRRT_6', pr: 13, path: 'src/parser.ts', side: 'RIGHT', line: 23, originalLine: 22, commit: OLD,
    hunk:
      "@@ -16,9 +16,10 @@ export function parse(src: string): Spec[] {\n     while (tokens[i] && tokens[i].text !== '}') {\n" +
      '       const key = tokens[i].text;\n       props[key] = tokens[i + 2].text;\n       i += 4;\n     }\n' +
      "+    if (!tokens[i]) throw new ParseError(`unclosed ${name}`, tokens[i - 1].line);",
    comments: [say('monalisa', 68, 'Nice, this is the case that used to loop forever on `a {`.', { reactions: { HEART: ['hubot', 'octocat'] } })],
  },
  {
    id: 'PRRT_7', pr: 13, path: 'src/errors.ts', side: 'RIGHT', line: null, commit: 0, file: true,
    comments: [say('monalisa', 24, 'Could this file say, in a line, when a `ParseError` is thrown and what `line` counts from?')],
  },
  {
    id: 'PRRT_8', pr: 12, path: 'src/tokenizer.ts', side: 'RIGHT', line: 6, commit: 0,
    comments: [say('hubot', 90, '`12abc` comes out as a number and then a word. Is that what we want, or should it be an error?')],
  },
  {
    id: 'PRRT_9', pr: 12, path: 'src/build.ts', side: 'RIGHT', line: 6, commit: 1,
    comments: [say('monalisa', 80, 'Files we write should end with a newline:\n\n```suggestion\n  return JSON.stringify(specs, null, 2) + \'\\n\';\n```')],
  },
] satisfies MockThread[];

/**
 * The viewer's reviews in progress by pull request, shared with the PR overview's mock (which submits
 * them by deleting the entry): `{ id, comments }`, comments a list or a count. A comment of ours is
 * pending while its `review` is the entry's id.
 */
db.pending ??= {};
type Pending = { id: string; comments: unknown[] | number; commit?: string };
const pendingOf = (n: number): Pending | undefined => db.pending[n];
const pendingCount = (r: Pending) => (Array.isArray(r.comments) ? r.comments.length : Number(r.comments) || 0);
const addPending = (r: Pending, c: MockComment, path: string, line: number | null) => {
  if (Array.isArray(r.comments)) r.comments.push({ id: c.id, path, line, body: c.body });
  else r.comments = pendingCount(r) + 1;
};

const threads = (): MockThread[] => db.threads;
const pull = (n: number) => db.pulls.find((p: any) => p.number === n);
const git = (): Git | undefined => db.reviewGit;
const tip = (b: string) => db.tips[`origin/${b}`] ?? db.tips[b];

/** The pull request's commits, oldest first, as GitHub has them (origin's branches). */
async function prCommits(n: number): Promise<string[]> {
  const p = pull(n);
  const g = git();
  if (!p || !g || !tip(p.headRefName) || !tip(p.baseRefName)) return [];
  const out = await g.text(['rev-list', '--reverse', `${tip(p.baseRefName)}..${tip(p.headRefName)}`], { allowFail: true });
  return out ? out.split('\n') : [];
}

/** GitHub's `diff_hunk`: the hunk of `base...commit` holding the line, up to it; null when it isn't in the diff. */
async function hunkFor(base: string, commit: string, path: string, side: 'LEFT' | 'RIGHT', line: number): Promise<string | null> {
  const g = git();
  if (!g) return null;
  const diff = await g.text(['diff', '-U3', '--no-color', '--no-ext-diff', `${base}...${commit}`, '--', path], { allowFail: true });
  let hunk: string[] | null = null;
  let o = 0;
  let n = 0;
  for (const l of diff.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      hunk = [l];
      o = +h[1];
      n = +h[2];
      continue;
    }
    if (!hunk || !/^[ +-]/.test(l)) continue;
    hunk.push(l);
    const at = l[0] === '+' ? (side === 'RIGHT' ? n : -1) : l[0] === '-' ? (side === 'LEFT' ? o : -1) : side === 'RIGHT' ? n : o;
    if (at === line) return hunk.join('\n');
    if (l[0] !== '+') o++;
    if (l[0] !== '-') n++;
  }
  return null;
}

const user = (login: string) => ({ login, avatarUrl: `https://github.com/${login}.png` });

async function threadNode(t: MockThread, commits: string[], head: string) {
  const p = pull(t.pr);
  const original = typeof t.commit === 'number' ? (commits[t.commit] ?? null) : t.commit;
  const hunk = t.hunk ?? (original && t.line && (await hunkFor(tip(p.baseRefName), original, t.path, t.side, t.originalLine ?? t.line))) ?? '';
  const pending = pendingOf(t.pr)?.id;
  const isPending = (c: MockComment) => !!c.review && c.review === pending;
  return {
    id: t.id,
    isResolved: !!t.resolvedBy,
    resolvedBy: t.resolvedBy ? user(t.resolvedBy) : null,
    isOutdated: !!t.outdated,
    path: t.path,
    line: t.outdated ? null : t.line,
    startLine: t.outdated ? null : (t.startLine ?? null),
    originalLine: t.originalLine ?? t.line,
    originalStartLine: t.originalStartLine ?? t.startLine ?? null,
    diffSide: t.side,
    startDiffSide: t.startLine ? t.side : null,
    subjectType: t.file ? 'FILE' : 'LINE',
    viewerCanResolve: !t.resolvedBy && t.comments.some((c) => !isPending(c)),
    viewerCanUnresolve: !!t.resolvedBy,
    viewerCanReply: true,
    comments: {
      nodes: t.comments.map((c) => ({
        id: c.id,
        databaseId: c.databaseId,
        body: c.body,
        createdAt: c.createdAt,
        lastEditedAt: c.lastEditedAt ?? null,
        url: `https://github.com/acme/widgets/pull/${t.pr}#discussion_r${c.databaseId}`,
        diffHunk: hunk,
        viewerCanUpdate: c.author === db.viewer,
        viewerCanDelete: c.author === db.viewer,
        author: user(c.author),
        originalCommit: original ? { oid: original } : null,
        commit: t.outdated ? null : { oid: head },
        pullRequestReview: { id: c.review ?? `PRR_${c.databaseId}`, state: isPending(c) ? 'PENDING' : 'COMMENTED' },
        reactionGroups: Object.entries(c.reactions).map(([content, who]) => ({
          content,
          viewerHasReacted: who.includes(db.viewer),
          reactors: { totalCount: who.length },
        })),
      })),
    },
  };
}

onGraphql('ReviewThreads', async (v) => {
  const p = pull(v.number);
  if (!p) return { viewer: { login: db.viewer }, repository: { pullRequest: null } };
  const commits = await prCommits(p.number);
  const head = tip(p.headRefName) ?? p.headRefOid;
  const pending = pendingOf(p.number);
  const nodes = await Promise.all(threads().filter((t) => t.pr === p.number).map((t) => threadNode(t, commits, head)));
  return {
    viewer: { login: db.viewer },
    repository: {
      pullRequest: {
        id: `PR_${p.number}`,
        number: p.number,
        headRefOid: head,
        baseRefOid: tip(p.baseRefName) ?? '0'.repeat(40),
        commits: { nodes: commits.map((oid) => ({ commit: { oid } })) },
        reviews: {
          nodes: pending
            ? [{ id: pending.id, viewerDidAuthor: true, comments: { totalCount: pendingCount(pending) } }]
            : [],
        },
        reviewThreads: { nodes: nodes.filter((t) => t.comments.nodes.length) },
      },
    },
  };
});

/** A new thread at `commit`'s diff, refused the way GitHub refuses a line that isn't in it. */
async function newThread(pr: number, commit: string, c: { path: string; line: number; side: 'LEFT' | 'RIGHT'; startLine?: number | null; body: string }, review?: string) {
  const p = pull(pr);
  if (!p) throw new GithubError('GitHub: Not Found', 404);
  const commits = await prCommits(pr);
  if (!commits.includes(commit)) throw new GithubError('GitHub: Validation Failed: commit_id is not part of the pull request', 422);
  const base = tip(p.baseRefName);
  if (!(await hunkFor(base, commit, c.path, c.side, c.line)) || (c.startLine && !(await hunkFor(base, commit, c.path, c.side, c.startLine)))) {
    throw new GithubError('GitHub: Validation Failed: pull_request_review_thread.line must be part of the diff', 422);
  }
  const t: MockThread = {
    id: `PRRT_${next++}`, pr, path: c.path, side: c.side, line: c.line, startLine: c.startLine ?? undefined,
    commit: commits.indexOf(commit), comments: [say(db.viewer, 0, c.body, { review })],
  };
  threads().push(t);
  return t;
}

onRest('POST /repos/:owner/:repo/pulls/:number/comments', async (params, _q, b) => {
  const t = await newThread(+params.number, b.commit_id, { path: b.path, line: b.line, side: b.side, startLine: b.start_line, body: b.body });
  return { id: t.comments[0].databaseId, body: b.body };
});

onRest('POST /repos/:owner/:repo/pulls/:number/comments/:id/replies', (params, _q, b) => {
  const t = threads().find((x) => x.pr === +params.number && x.comments.some((c) => c.databaseId === +params.id));
  if (!t) throw new GithubError('GitHub: Not Found', 404);
  const c = say(db.viewer, 0, b.body);
  t.comments.push(c);
  return { id: c.databaseId, body: c.body };
});

onGraphql('StartReview', (v) => {
  const n = Number(String(v.pr).replace('PR_', ''));
  if (pendingOf(n)) throw new GithubError('GitHub: You can only have one pending review per pull request.', 200);
  db.pending[n] = { id: `PRR_pending_${next++}`, comments: [], commit: v.commit } satisfies Pending;
  return { addPullRequestReview: { pullRequestReview: { id: db.pending[n].id } } };
});

const pendingById = (id: string) => Object.entries(db.pending as Record<string, Pending>).find(([, r]) => r?.id === id);

onGraphql('AddReviewThread', async (v) => {
  const found = pendingById(v.review);
  if (!found) throw new GithubError('GitHub: Could not resolve to a node with the global id.', 200);
  const n = +found[0];
  const t = await newThread(n, found[1].commit ?? tip(pull(n).headRefName), v as any, v.review);
  addPending(found[1], t.comments[0], t.path, t.line);
  return { addPullRequestReviewThread: { thread: { id: t.id } } };
});

onGraphql('ReplyInReview', (v) => {
  const t = threads().find((x) => x.id === v.thread);
  const found = pendingById(v.review);
  if (!t || !found) throw new GithubError('GitHub: Could not resolve to a node with the global id.', 200);
  const c = say(db.viewer, 0, v.body, { review: v.review });
  addPending(found[1], c, t.path, t.line);
  t.comments.push(c);
  return { addPullRequestReviewThreadReply: { comment: { id: c.id } } };
});

const resolve = (id: string, by: string | undefined) => {
  const t = threads().find((x) => x.id === id);
  if (!t) throw new GithubError('GitHub: Could not resolve to a node with the global id.', 200);
  t.resolvedBy = by;
  return { thread: { id, isResolved: !!by } };
};
onGraphql('ResolveThread', (v) => ({ resolveReviewThread: resolve(v.id, db.viewer) }));
onGraphql('UnresolveThread', (v) => ({ unresolveReviewThread: resolve(v.id, undefined) }));

const commentById = (id: string) => {
  for (const t of threads()) {
    const c = t.comments.find((x) => x.id === id);
    if (c) return { t, c };
  }
  throw new GithubError('GitHub: Could not resolve to a node with the global id.', 200);
};

onGraphql('EditReviewComment', (v) => {
  const { c } = commentById(v.id);
  c.body = v.body;
  c.lastEditedAt = new Date().toISOString();
  return { updatePullRequestReviewComment: { pullRequestReviewComment: { id: c.id } } };
});

onGraphql('DeleteReviewComment', (v) => {
  const { t, c } = commentById(v.id);
  t.comments.splice(t.comments.indexOf(c), 1);
  const r = c.review ? pendingById(c.review)?.[1] : undefined;
  if (r) r.comments = Array.isArray(r.comments) ? r.comments.filter((x: any) => x.id !== c.id) : Math.max(0, pendingCount(r) - 1);
  return { deletePullRequestReviewComment: { clientMutationId: null } };
});

const react = (v: Record<string, any>, on: boolean) => {
  const { c } = commentById(v.id);
  const who = (c.reactions[v.content] ??= []).filter((l) => l !== db.viewer);
  c.reactions[v.content] = on ? [...who, db.viewer] : who;
  if (!c.reactions[v.content].length) delete c.reactions[v.content];
  return { reaction: { content: v.content } };
};
onGraphql('AddReaction', (v) => ({ addReaction: react(v, true) }));
onGraphql('RemoveReaction', (v) => ({ removeReaction: react(v, false) }));
