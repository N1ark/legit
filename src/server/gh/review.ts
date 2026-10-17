// Pull request review threads: reading them (one GraphQL query per refresh), commenting on lines
// (now, or in the viewer's pending review), replying, resolving, editing, deleting, reacting, and
// applying a suggestion to the working tree. Submitting a review is the PR overview's.

import { randomBytes } from 'node:crypto';
import { lstat, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { GitError } from '../git.ts';
import { GithubError, MOCK, cached, graphql, rest } from './client.ts';
import { needGhRepos } from './context.ts';
import { db } from './mock/registry.ts';
import type { GetRoute, PostRoute } from './routes.ts';
import type { ApplySuggestion, NewComment, PrReview, Reaction, ReviewComment, ReviewThread } from '../../shared/gh-review.ts';
import type { Repo } from '../repo.ts';

const COMMENT_FIELDS = `id databaseId body createdAt lastEditedAt url diffHunk viewerCanUpdate viewerCanDelete
  author { login avatarUrl } originalCommit { oid } commit { oid } pullRequestReview { id state }
  reactionGroups { content viewerHasReacted reactors { totalCount } }`;

const REVIEW_QUERY = `query ReviewThreads($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id number headRefOid baseRefOid
      commits(last: 100) { nodes { commit { oid } } }
      reviews(states: [PENDING], first: 5) { nodes { id viewerDidAuthor comments { totalCount } } }
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line startLine originalLine originalStartLine diffSide startDiffSide subjectType
          viewerCanResolve viewerCanUnresolve viewerCanReply resolvedBy { login }
          comments(first: 100) { nodes { ${COMMENT_FIELDS} } }
        }
      }
    }
  }
}`;

export function toComment(n: any): ReviewComment {
  return {
    id: n.id,
    databaseId: n.databaseId,
    body: n.body ?? '',
    author: n.author ? { login: n.author.login, avatar: n.author.avatarUrl } : null,
    createdAt: n.createdAt,
    lastEditedAt: n.lastEditedAt ?? null,
    url: n.url,
    diffHunk: n.diffHunk ?? '',
    originalCommit: n.originalCommit?.oid ?? null,
    commit: n.commit?.oid ?? null,
    canEdit: !!n.viewerCanUpdate,
    canDelete: !!n.viewerCanDelete,
    pending: n.pullRequestReview?.state === 'PENDING',
    reactions: (n.reactionGroups ?? [])
      .filter((g: any) => g.reactors.totalCount > 0)
      .map((g: any) => ({ content: g.content, count: g.reactors.totalCount, mine: !!g.viewerHasReacted })),
  };
}

export function toThread(n: any): ReviewThread {
  return {
    id: n.id,
    path: n.path,
    resolved: !!n.isResolved,
    outdated: !!n.isOutdated,
    line: n.line ?? null,
    startLine: n.startLine ?? null,
    originalLine: n.originalLine ?? null,
    originalStartLine: n.originalStartLine ?? null,
    side: n.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT',
    startSide: n.startDiffSide ?? null,
    subject: n.subjectType === 'FILE' ? 'FILE' : 'LINE',
    resolvedBy: n.resolvedBy?.login ?? null,
    canResolve: !!n.viewerCanResolve,
    canUnresolve: !!n.viewerCanUnresolve,
    canReply: !!n.viewerCanReply,
    comments: (n.comments?.nodes ?? []).map(toComment),
  };
}

export function toReview(viewer: string, pr: any): PrReview {
  const pending = (pr.reviews?.nodes ?? []).find((r: any) => r.viewerDidAuthor);
  return {
    number: pr.number,
    commits: (pr.commits?.nodes ?? []).map((c: any) => c.commit.oid),
    headSha: pr.headRefOid,
    baseSha: pr.baseRefOid,
    viewer,
    // Threads whose every comment was deleted linger with none.
    threads: (pr.reviewThreads?.nodes ?? []).map(toThread).filter((t: ReviewThread) => t.comments.length),
    pending: pending ? { id: pending.id, comments: pending.comments.totalCount } : null,
  };
}

interface Loaded {
  review: PrReview;
  /** The pull request's node id, for mutations. */
  prId: string;
}

const loads = new Map<string, { at: number; value: Promise<Loaded> }>();

async function load(repo: Repo, number: number, fresh = false): Promise<Loaded> {
  const r = await needGhRepos(repo);
  if (MOCK) db.reviewGit = repo.git;
  const key = `${r.base}#${number}`;
  if (fresh) loads.delete(key);
  return cached(loads, key, 10_000, async () => {
    const d = await graphql(REVIEW_QUERY, { owner: r.owner, name: r.name, number });
    const pr = d.repository?.pullRequest;
    if (!pr) throw new GithubError(`Pull request #${number} isn't on GitHub.`, 404);
    return { review: toReview(d.viewer.login, pr), prId: pr.id };
  });
}

/** GitHub's refusals, said in terms of what to do about them. */
function explain(e: unknown): never {
  if (e instanceof GithubError && /part of the diff|could not be resolved|line must be/i.test(e.message)) {
    throw new GithubError(
      `GitHub only takes comments on lines of its diff of the pull request at that commit: the changed lines and the few around them (${e.message.replace(/^GitHub: /, '')}).`,
      e.status,
    );
  }
  throw e;
}

const num = (v: unknown, what: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new GithubError(`Bad ${what}.`, 400);
  return n;
};

const text = (v: unknown) => {
  if (typeof v !== 'string' || !v.trim()) throw new GithubError('Write something first.', 400);
  return v;
};

/** After a change: the review as it is now. */
const reload = async (repo: Repo, number: number) => (await load(repo, number, true)).review;

async function comment(repo: Repo, c: NewComment): Promise<PrReview> {
  const number = num(c.number, 'pull request number');
  const body = text(c.body);
  const range = c.startLine !== undefined && c.startLine !== null && c.startLine !== c.line;
  if (!/^[0-9a-f]{40,64}$/.test(c.commitId ?? '')) throw new GithubError('Bad commit.', 400);
  try {
    if (!c.pending) {
      const r = await needGhRepos(repo);
      await rest('POST', `/repos/${r.base}/pulls/${number}/comments`, {
        body,
        commit_id: c.commitId,
        path: c.path,
        line: c.line,
        side: c.side,
        ...(range ? { start_line: c.startLine, start_side: c.startSide ?? c.side } : {}),
      });
      return reload(repo, number);
    }
    const { review, prId } = await load(repo, number, true);
    let reviewId = review.pending?.id;
    if (!reviewId) {
      const d = await graphql(
        `mutation StartReview($pr: ID!, $commit: GitObjectID) {
          addPullRequestReview(input: { pullRequestId: $pr, commitOID: $commit }) { pullRequestReview { id } }
        }`,
        { pr: prId, commit: c.commitId },
      );
      reviewId = d.addPullRequestReview.pullRequestReview.id as string;
    }
    await graphql(
      `mutation AddReviewThread($review: ID!, $path: String!, $line: Int!, $side: DiffSide!, $startLine: Int, $startSide: DiffSide, $body: String!) {
        addPullRequestReviewThread(input: {
          pullRequestReviewId: $review, path: $path, line: $line, side: $side, startLine: $startLine, startSide: $startSide, body: $body, subjectType: LINE
        }) { thread { id } }
      }`,
      {
        review: reviewId,
        path: c.path,
        line: c.line,
        side: c.side,
        startLine: range ? c.startLine : null,
        startSide: range ? (c.startSide ?? c.side) : null,
        body,
      },
    );
    return reload(repo, number);
  } catch (e) {
    explain(e);
  }
}

async function reply(repo: Repo, b: { number: number; threadId: string; commentDatabaseId: number; body: string; pending?: boolean }) {
  const number = num(b.number, 'pull request number');
  const body = text(b.body);
  if (b.pending) {
    const { review } = await load(repo, number, true);
    if (!review.pending) throw new GithubError('You have no review in progress on this pull request any more.', 409);
    await graphql(
      `mutation ReplyInReview($review: ID!, $thread: ID!, $body: String!) {
        addPullRequestReviewThreadReply(input: { pullRequestReviewId: $review, pullRequestReviewThreadId: $thread, body: $body }) { comment { id } }
      }`,
      { review: review.pending.id, thread: b.threadId, body },
    );
  } else {
    const r = await needGhRepos(repo);
    await rest('POST', `/repos/${r.base}/pulls/${number}/comments/${num(b.commentDatabaseId, 'comment')}/replies`, { body });
  }
  return reload(repo, number);
}

const REACTIONS: Reaction[] = ['THUMBS_UP', 'THUMBS_DOWN', 'LAUGH', 'HOORAY', 'CONFUSED', 'HEART', 'ROCKET', 'EYES'];

export const reviewGet: Record<string, GetRoute> = {
  reviewThreads: async (repo, q) => (await load(repo, num(q.get('number'), 'pull request number'), q.get('fresh') === '1')).review,
};

export const reviewPost: Record<string, PostRoute> = {
  reviewComment: (repo, b: NewComment) => comment(repo, b),
  reviewReply: (repo, b) => reply(repo, b),
  reviewResolve: async (repo, b: { number: number; threadId: string; resolved: boolean }) => {
    const name = b.resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    await graphql(
      `mutation ${b.resolved ? 'ResolveThread' : 'UnresolveThread'}($id: ID!) { ${name}(input: { threadId: $id }) { thread { id isResolved } } }`,
      { id: b.threadId },
    );
    return reload(repo, num(b.number, 'pull request number'));
  },
  reviewEdit: async (repo, b: { number: number; commentId: string; body: string }) => {
    await graphql(
      `mutation EditReviewComment($id: ID!, $body: String!) {
        updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $id, body: $body }) { pullRequestReviewComment { id } }
      }`,
      { id: b.commentId, body: text(b.body) },
    );
    return reload(repo, num(b.number, 'pull request number'));
  },
  reviewDelete: async (repo, b: { number: number; commentId: string }) => {
    await graphql(
      `mutation DeleteReviewComment($id: ID!) { deletePullRequestReviewComment(input: { id: $id }) { clientMutationId } }`,
      { id: b.commentId },
    );
    return reload(repo, num(b.number, 'pull request number'));
  },
  reviewReact: async (repo, b: { number: number; subjectId: string; content: Reaction; on: boolean }) => {
    if (!REACTIONS.includes(b.content)) throw new GithubError('Bad reaction.', 400);
    const name = b.on ? 'addReaction' : 'removeReaction';
    await graphql(
      `mutation ${b.on ? 'AddReaction' : 'RemoveReaction'}($id: ID!, $content: ReactionContent!) {
        ${name}(input: { subjectId: $id, content: $content }) { reaction { content } }
      }`,
      { id: b.subjectId, content: b.content },
    );
    return reload(repo, num(b.number, 'pull request number'));
  },
  reviewApply: (repo, b: ApplySuggestion) => applySuggestion(repo, b),
};

// Applying a suggestion: the commented lines are replaced in the working tree's file, only where
// they still read exactly as they did; the index is never touched.

/** The file's text with the suggestion applied, or why it can't be. Lines are compared without their `\r`. */
export function withSuggestion(file: string, s: Pick<ApplySuggestion, 'startLine' | 'lines' | 'replacement'>): { text: string; at: number } | { error: string } {
  const lines = file.split('\n');
  const strip = (l: string) => l.replace(/\r$/, '');
  const want = s.lines.map(strip);
  if (!want.length) return { error: 'The suggestion has no lines to replace.' };
  // The last line has no newline when the file doesn't end with one: `split` leaves a final ''.
  const end = file.endsWith('\n') ? lines.length - 1 : lines.length;
  const at = (k: number) => k >= 0 && k + want.length <= end && want.every((w, j) => strip(lines[k + j]) === w);
  let k = s.startLine - 1;
  if (!at(k)) {
    const found: number[] = [];
    for (let j = 0; j + want.length <= end && found.length < 2; j++) if (at(j)) found.push(j);
    if (found.length !== 1) {
      const where = want.length === 1 ? `line ${s.startLine}` : `lines ${s.startLine}–${s.startLine + want.length - 1}`;
      return {
        error: found.length
          ? `The commented lines appear more than once in your file and not at ${where}, so legit can't tell which to change; apply it by hand.`
          : `Your file no longer has the lines this suggestion was made on (${where}); nothing was changed.`,
      };
    }
    k = found[0];
  }
  const crlf = lines[k].endsWith('\r');
  const repl = s.replacement.map((l) => strip(l) + (crlf ? '\r' : ''));
  // A suggestion that empties the last line of a file without a final newline keeps it that way.
  const out = [...lines.slice(0, k), ...repl, ...lines.slice(k + want.length)];
  return { text: out.join('\n'), at: k + 1 };
}

async function applySuggestion(repo: Repo, s: ApplySuggestion): Promise<{ line: number }> {
  if (typeof s.path !== 'string' || !s.path || s.path.split('/').some((p) => p === '..' || p === '' || p === '.git')) {
    throw new GitError('Bad path.');
  }
  if (!Array.isArray(s.lines) || !Array.isArray(s.replacement) || !Number.isInteger(s.startLine)) throw new GitError('Bad suggestion.');
  return repo.exclusive(async () => {
    const abs = `${repo.git.root}/${s.path}`;
    // Not through a symlinked directory to somewhere outside the repository.
    const [root, dir] = await Promise.all([realpath(repo.git.root), realpath(dirname(abs)).catch(() => null)]);
    if (!dir || (dir !== root && !dir.startsWith(root + '/'))) throw new GitError(`${s.path} isn't in your files.`);
    const st = await lstat(abs).catch(() => null);
    if (!st) throw new GitError(`${s.path} isn't in your files.`);
    if (!st.isFile()) throw new GitError(`${s.path} isn't a regular file; nothing was changed.`);
    const before = await readFile(abs);
    const r = withSuggestion(before.toString('utf8'), s);
    if ('error' in r) throw new GitError(r.error);
    const tmp = `${abs.slice(0, abs.lastIndexOf('/') + 1)}.legit-${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(tmp, r.text, { mode: st.mode & 0o777, flag: 'wx' });
      // Changed in the meantime (an editor saving it): leave it be.
      if (!(await readFile(abs)).equals(before)) throw new GitError(`${s.path} changed while applying; nothing was changed.`);
      await rename(tmp, abs);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
    return { line: r.at };
  });
}
