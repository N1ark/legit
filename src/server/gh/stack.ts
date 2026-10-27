// Every local branch's pull request in one GraphQL query (for the branch list), the stack of
// pull requests the current branch is in (each one's base another's head), and opening or
// retargeting a pull request.

import { freshest } from '../base.ts';
import { githubRepo } from '../github.ts';
import { GithubError, cached, graphql, prune, rest } from './client.ts';
import { ghRepos, needGhRepos, type GhRepos } from './context.ts';
import { PR_FIELDS, forgetPrs, headCache, pickPr, toPullRequest } from './pulls.ts';
import { byHead, missingBase, stackAround } from './stacks.ts';
import type { CreatePrRequest, PrCreateInfo, PrStack, RestackPlan, StackEntry } from '../../shared/gh-stack.ts';
import { type PullRequest, isLive } from '../../shared/github.ts';
import type { Git } from '../git.ts';
import type { Repo } from '../repo.ts';
import type { GetRoute, PostRoute } from './routes.ts';

/** Most local branches a stack is looked for among (the most recently committed to). */
const MAX_BRANCHES = 60;

const live = (p: PullRequest | undefined) => !!p && isLive(p.state);

interface Local {
  name: string;
  sha: string;
  /** Its name on GitHub: its upstream's branch, else its own. */
  head: string;
  worktree: string | null;
}

interface Context {
  git: Git;
  r: GhRepos;
  locals: Local[];
  /** Local branches by their name on GitHub. */
  byHead: Map<string, Local>;
  /** Remotes of the repo pull requests go to, and of the one branches are pushed to. */
  baseRemote: string;
  headRemote: string;
  /** Every local and remote-tracking ref → its SHA. */
  refs: Map<string, string>;
  /** The remotes on GitHub, and their `owner/name` there (lowercase). */
  remotes: { name: string; repo: string }[];
  current: string | null;
}

async function context(repo: Repo, r: GhRepos): Promise<Context> {
  const git = repo.git;
  const [urls, heads, refs, current] = await Promise.all([
    git.text(['config', '--get-regexp', '^remote\\..*\\.url$'], { allowFail: true }),
    git.text([
      'for-each-ref', '--sort=-committerdate',
      '--format=%(refname:short)%00%(objectname)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(worktreepath)', 'refs/heads',
    ]),
    git.text(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes']),
    repo.currentBranch(),
  ]);
  const remotes = urls.split('\n').flatMap((l) => {
    const m = /^remote\.(.+)\.url (.+)$/.exec(l);
    const gh = m ? githubRepo(m[2]) : null;
    return m && gh ? [{ name: m[1], repo: gh.toLowerCase() }] : [];
  });
  const prefer = (list: { name: string }[]) => list.find((x) => x.name === 'upstream' || x.name === 'origin')?.name ?? list[0]?.name;
  const baseRemote = prefer(remotes.filter((x) => x.repo === r.base.toLowerCase())) ?? 'origin';
  const headRemote = remotes.find((x) => x.repo.split('/')[0] === r.headOwner.toLowerCase() && x.name !== 'upstream')?.name ?? baseRemote;
  const locals = heads
    .split('\n')
    .filter(Boolean)
    .map((line): Local => {
      const [name, sha, remote, remoteRef, worktree] = line.split('\0');
      const up = remote && remote !== '.' && remoteRef.startsWith('refs/heads/') ? remoteRef.slice('refs/heads/'.length) : '';
      return { name, sha, head: up || name, worktree: name !== current && worktree ? worktree : null };
    });
  const byHeadName = new Map<string, Local>();
  for (const l of locals) if (!byHeadName.has(l.head) || l.name === l.head) byHeadName.set(l.head, l);
  return {
    git, r, locals, byHead: byHeadName, baseRemote, headRemote, current, remotes,
    refs: new Map(refs.split('\n').filter(Boolean).map((l) => l.split(' ') as [string, string])),
  };
}

interface Found {
  /** The repo's default branch. */
  trunk: string;
  /** The pull request each branch asked about is the head of, and the open ones based on the other branches asked about. */
  prs: PullRequest[];
}

const found = new Map<string, { at: number; value: Promise<Found> }>();

/** One GraphQL query: the pull request of each of `heads`, and the open ones whose base is one of `bases`. */
function lookup(r: GhRepos, heads: string[], bases: string[], fresh: boolean): Promise<Found> {
  const key = `${r.base}\0${r.headOwner}\0${heads.join('\0')}\0\0${bases.join('\0')}`;
  if (fresh) found.delete(key);
  return cached(found, key, 15_000, async () => {
    const vars: Record<string, string> = { owner: r.owner, name: r.name };
    const fields: string[] = [];
    const order = 'orderBy: { field: UPDATED_AT, direction: DESC }';
    heads.forEach((h, i) => {
      vars[`h${i}`] = h;
      fields.push(`h${i}: pullRequests(headRefName: $h${i}, first: 5, ${order}) { nodes { ${PR_FIELDS} } }`);
    });
    bases.forEach((b, i) => {
      vars[`c${i}`] = b;
      fields.push(`c${i}: pullRequests(baseRefName: $c${i}, states: [OPEN], first: 20, ${order}) { nodes { ${PR_FIELDS} } }`);
    });
    const decl = Object.keys(vars).map((k) => `$${k}: String!`).join(', ');
    const d = await graphql(
      `query PrStack(${decl}) { repository(owner: $owner, name: $name) { defaultBranchRef { name } ${fields.join('\n')} } }`,
      vars,
    );
    const repo = d.repository;
    if (!repo) throw new GithubError(`GitHub has no repository ${r.base}, or this token can't see it.`);
    const mine = (n: any) => !n.headRepositoryOwner || n.headRepositoryOwner.login.toLowerCase() === r.headOwner.toLowerCase();
    const picked = heads.flatMap((_, i) => pickPr(repo[`h${i}`]?.nodes ?? [], r.headOwner) ?? []);
    const children = bases.flatMap((_, i) => (repo[`c${i}`]?.nodes ?? []).filter(mine).map(toPullRequest));
    return { trunk: repo.defaultBranchRef?.name ?? 'main', prs: [...picked, ...children] };
  });
}

/** The local branches' pull requests, and the open ones stacked on them (but not on the default branch). */
async function batch(c: Context, fresh: boolean): Promise<Found> {
  const shown = c.locals.slice(0, MAX_BRANCHES);
  const cur = c.locals.find((l) => l.name === c.current);
  if (cur && !shown.includes(cur)) shown.push(cur);
  const remoteHead = await c.git.text(['symbolic-ref', '-q', '--short', `refs/remotes/${c.baseRemote}/HEAD`], { allowFail: true });
  const trunks = new Set(['main', 'master', remoteHead.slice(c.baseRemote.length + 1)]);
  const heads = [...new Set(shown.map((l) => l.head))];
  return lookup(c.r, heads, heads.filter((h) => !trunks.has(h)), fresh);
}

/** Branch names looked up in one query. */
const CHUNK = 50;
/** Pull requests asked for per branch name; a name with more is asked again for up to `MANY`. */
const FEW = 10;
const MANY = 100;

async function queryHeads(r: GhRepos, heads: string[], first: number): Promise<{ nodes: any[]; more: boolean }[]> {
  const vars: Record<string, string | number> = { owner: r.owner, name: r.name, first };
  const fields = heads.map((h, i) => {
    vars[`h${i}`] = h;
    return `h${i}: pullRequests(headRefName: $h${i}, first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) { totalCount nodes { ${PR_FIELDS} } }`;
  });
  const decl = heads.map((_, i) => `$h${i}: String!`).join(', ');
  const d = await graphql(`query BranchPrs($owner: String!, $name: String!, $first: Int!, ${decl}) { repository(owner: $owner, name: $name) { ${fields.join('\n')} } }`, vars);
  return heads.map((_, i) => {
    const c = d.repository?.[`h${i}`];
    return { nodes: c?.nodes ?? [], more: (c?.totalCount ?? 0) > (c?.nodes?.length ?? 0) };
  });
}

/** The pull request nodes of each of `heads` (branch names on GitHub), asked for in chunks of the names not cached. */
function headNodes(r: GhRepos, heads: string[], fresh: boolean): Promise<any[][]> {
  const key = (h: string) => `${r.base}\0${h}`;
  const now = Date.now();
  prune(headCache, 15_000, 5000);
  const missing = heads.filter((h) => {
    const hit = headCache.get(key(h));
    return fresh || !hit || now - hit.at >= 15_000;
  });
  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK);
    // A name used by many forks can have newer pull requests than this repo's own: those are asked again for more.
    const all = queryHeads(r, chunk, FEW).then(async (res) => {
      const more = chunk.filter((_, k) => res[k].more);
      const wide = more.length ? await queryHeads(r, more, MANY).catch(() => null) : null;
      wide?.forEach((x, k) => (res[chunk.indexOf(more[k])] = x));
      return res.map((x) => x.nodes);
    });
    chunk.forEach((h, k) => {
      const value = all.then((res) => res[k]);
      headCache.set(key(h), { at: now, value });
      value.catch(() => headCache.get(key(h))?.value === value && headCache.delete(key(h)));
    });
  }
  return Promise.all(heads.map((h) => headCache.get(key(h))!.value));
}

/** The pull requests of local branches `names`, by name. */
async function branchPrs(repo: Repo, names: string[], fresh: boolean): Promise<Record<string, PullRequest>> {
  const r = await ghRepos(repo);
  if (!r || !names.length) return {};
  const c = await context(repo, r);
  const wanted = new Set(names);
  const locals = c.locals.filter((l) => wanted.has(l.name));
  const heads = [...new Set(locals.map((l) => l.head))];
  const nodes = new Map((await headNodes(r, heads, fresh)).map((n, i) => [heads[i], n]));
  return Object.fromEntries(locals.flatMap((l) => {
    const pr = pickPr(nodes.get(l.head) ?? [], r.headOwner);
    return pr ? [[l.name, pr]] : [];
  }));
}

/**
 * The pull requests of remote-tracking branches `keys` (`remote/branch`), by key: each matched to
 * pull requests from that remote's owner.
 */
async function remoteBranchPrs(repo: Repo, keys: string[], fresh: boolean): Promise<Record<string, PullRequest>> {
  const r = await ghRepos(repo);
  if (!r || !keys.length) return {};
  const c = await context(repo, r);
  const wanted = keys.flatMap((key) => {
    // The longest remote name that fits, as a remote's name may hold a slash.
    const remote = c.remotes.filter((x) => key.startsWith(`${x.name}/`)).sort((a, b) => b.name.length - a.name.length)[0];
    const name = remote ? key.slice(remote.name.length + 1) : '';
    return remote && name && name !== 'HEAD' ? [{ key, owner: remote.repo.split('/')[0], name }] : [];
  });
  const names = [...new Set(wanted.map((w) => w.name))];
  const nodes = new Map((await headNodes(r, names, fresh)).map((n, i) => [names[i], n]));
  return Object.fromEntries(wanted.flatMap((w) => {
    const pr = pickPr(nodes.get(w.name) ?? [], w.owner);
    return pr ? [[w.key, pr]] : [];
  }));
}

const isAncestor = async (git: Git, a: string, b: string) => (await git.run(['merge-base', '--is-ancestor', a, b], { allowFail: true })).code === 0;

interface Tip {
  /** As the rebuild op takes it: a local branch, or `remote/branch`. */
  name: string;
  sha: string;
}

/**
 * Branch `name` (on GitHub) here: its local branch, else its remote-tracking one. For the trunk,
 * whichever of the two has the other (else the remote's), as "Rebase on main" picks it.
 */
async function tipOf(c: Context, name: string, trunk: string): Promise<Tip | null> {
  const remote = name === trunk ? c.baseRemote : c.headRemote;
  const l = c.byHead.get(name) ?? (name === trunk ? c.locals.find((x) => x.name === name) : undefined);
  const r = c.refs.get(`refs/remotes/${remote}/${name}`);
  const remoteTip = r ? { name: `${remote}/${name}`, sha: r } : null;
  if (!l) return remoteTip;
  if (name === trunk && remoteTip) {
    const same = remoteTip.sha === l.sha;
    const [localBehind, remoteBehind] = same
      ? [true, true]
      : await Promise.all([isAncestor(c.git, l.sha, remoteTip.sha), isAncestor(c.git, remoteTip.sha, l.sha)]);
    if (freshest(l.sha, remoteTip.sha, localBehind, remoteBehind) === 'remote') return remoteTip;
  }
  return { name: l.name, sha: l.sha };
}

async function counts(git: Git, base: string, tip: string): Promise<{ ahead: number; behind: number }> {
  const [behind, ahead] = (await git.text(['rev-list', '--left-right', '--count', `${base}...${tip}`])).split(/\s+/).map(Number);
  return { ahead, behind };
}

/** HEAD's own commits on top of `parent`'s, oldest first: those no tip `parent` has had (as its reflog remembers) has. */
async function ownCommits(c: Context, parent: PullRequest, also: string[]): Promise<string[]> {
  const git = c.git;
  const refs = [`refs/heads/${c.byHead.get(parent.head)?.name}`, `refs/remotes/${c.headRemote}/${parent.head}`].filter((x) => c.refs.has(x));
  const forks = await Promise.all(refs.map((ref) => git.text(['merge-base', '--fork-point', ref, 'HEAD'], { allowFail: true })));
  const known = (await git.run(['cat-file', '-e', `${parent.headSha}^{commit}`], { allowFail: true })).code === 0;
  const not = [...refs.map((x) => c.refs.get(x)!), ...forks.filter(Boolean), ...(known ? [parent.headSha] : []), ...also];
  return (await git.text(['rev-list', '--reverse', 'HEAD', '--not', ...new Set(not)])).split('\n').filter(Boolean);
}

/** What the current branch (`own`'s head) needs to sit on its parent pull request again, if anything. */
async function restackPlan(c: Context, own: PullRequest, heads: Map<string, PullRequest>, trunk: string): Promise<RestackPlan | null> {
  const parent = own.base !== trunk ? heads.get(own.base) : undefined;
  const head = c.locals.find((l) => l.name === c.current)?.sha;
  if (!parent || !head) return null;
  if (parent.state === 'merged') {
    const onto = await tipOf(c, parent.base, trunk);
    const retarget = live(own) && own.base === parent.head ? parent.base : null;
    const behind = !!onto && !(await isAncestor(c.git, onto.sha, head));
    const shas = behind ? await ownCommits(c, parent, [onto.sha]) : [];
    if (!shas.length && !retarget) return null;
    return { why: 'merged', parent, onto: shas.length ? onto!.name : null, shas, retarget };
  }
  if (!live(parent)) return null;
  const onto = await tipOf(c, parent.head, trunk);
  if (!onto || (await isAncestor(c.git, onto.sha, head))) return null;
  const shas = await ownCommits(c, parent, [onto.sha]);
  return shas.length ? { why: 'moved', parent, onto: onto.name, shas, retarget: null } : null;
}

async function prStack(repo: Repo, branch: string, fresh: boolean): Promise<PrStack | null> {
  const r = await ghRepos(repo, branch);
  if (!r) return null;
  const c = await context(repo, r);
  const head = c.locals.find((l) => l.name === branch)?.head ?? branch;
  const first = await batch(c, fresh);
  const { trunk } = first;
  let prs = first.prs;
  // Pull requests under this one whose branches aren't here: look them up, a few levels down.
  for (let i = 0, base = missingBase(prs, head, trunk); base && i < 5; i++, base = missingBase(prs, head, trunk)) {
    prs = [...prs, ...(await lookup(r, [base], [base], fresh)).prs];
  }
  const placed = stackAround(prs, head, trunk);
  if (!placed.length) return null;
  const heads = byHead(prs);
  const entries = await Promise.all(
    placed.map(async ({ pr, indent }): Promise<StackEntry> => {
      const l = c.byHead.get(pr.head);
      const remoteRef = `refs/remotes/${c.headRemote}/${pr.head}`;
      const [tip, base] = await Promise.all([tipOf(c, pr.head, trunk), tipOf(c, pr.base, trunk)]);
      const n = tip && base ? await counts(c.git, base.sha, tip.sha) : null;
      const stacked = pr.base !== trunk && live(heads.get(pr.base));
      return {
        pr, indent, current: pr.head === head, branch: l?.name ?? null, remoteRef: c.refs.has(remoteRef) ? remoteRef : null,
        worktree: l?.worktree ?? null, ahead: n?.ahead ?? null, behind: n?.behind ?? null, restack: stacked && !!n?.behind,
      };
    }),
  );
  const own = heads.get(head)!;
  return { trunk, entries, restack: branch === c.current ? await restackPlan(c, own, heads, trunk) : null };
}

/** The nearest local branch under HEAD with an open pull request: the one this branch is likely stacked on. */
async function stackParent(c: Context, heads: Map<string, PullRequest>, head: string, trunk: string): Promise<{ base: string; number: number } | null> {
  const here = c.locals.find((l) => l.name === c.current);
  if (!here) return null;
  let best: { base: string; number: number; n: number } | null = null;
  for (const l of c.locals.slice(0, MAX_BRANCHES)) {
    const pr = heads.get(l.head);
    if (l === here || l.head === head || l.head === trunk || !live(pr) || !(await isAncestor(c.git, l.sha, here.sha))) continue;
    const n = Number(await c.git.text(['rev-list', '--count', `${l.sha}..${here.sha}`]));
    if (!best || n < best.n) best = { base: l.head, number: pr!.number, n };
  }
  return best && { base: best.base, number: best.number };
}

async function createInfo(repo: Repo, branch: string, wanted: string | null): Promise<PrCreateInfo> {
  const r = await needGhRepos(repo, branch);
  const c = await context(repo, r);
  const head = c.locals.find((l) => l.name === branch)?.head ?? branch;
  const { trunk, prs } = await batch(c, false);
  const suggested = branch === c.current ? await stackParent(c, byHead(prs), head, trunk) : null;
  const prefix = `refs/remotes/${c.baseRemote}/`;
  const others = [...c.refs.keys()].filter((x) => x.startsWith(prefix)).map((x) => x.slice(prefix.length));
  const bases = [...new Set([trunk, ...(suggested ? [suggested.base] : []), ...others.sort()])].filter((b) => b !== 'HEAD' && b !== head);
  const base = wanted || suggested?.base || trunk;
  const tip = await tipOf(c, base, trunk);
  const log = tip
    ? await c.git.text(['log', '--reverse', '--max-count=100', '--format=%s%x1f%b%x1e', `${tip.sha}..refs/heads/${branch}`], { allowFail: true })
    : '';
  const commits = log
    .split('\x1e')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [subject, body = ''] = x.split('\x1f');
      return { subject: subject.trim(), body: body.trim() };
    });
  return { bases, trunk, suggested, base, commits, head };
}

const text = (v: unknown, what: string) => {
  if (typeof v !== 'string' || !v.trim()) throw new GithubError(`Give the pull request ${what}.`);
  return v.trim();
};

async function createPr(repo: Repo, req: CreatePrRequest): Promise<PullRequest> {
  const r = await needGhRepos(repo);
  const [title, base, branch] = [text(req.title, 'a title'), text(req.base, 'a base branch'), text(req.head, 'a branch')];
  const head = r.headOwner.toLowerCase() === r.owner.toLowerCase() ? branch : `${r.headOwner}:${branch}`;
  const p = await rest('POST', `/repos/${r.base}/pulls`, { title, body: typeof req.body === 'string' ? req.body : '', head, base, draft: !!req.draft });
  forgetPrs();
  found.clear();
  return fromRest(p, r.base);
}

/** A pull request from the REST API's shape. */
export function fromRest(p: any, repo: string): PullRequest {
  return {
    number: p.number,
    title: p.title,
    url: p.html_url,
    state: p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : p.draft ? 'draft' : 'open',
    base: p.base.ref,
    head: p.head.ref,
    headSha: p.head.sha,
    author: p.user ? { login: p.user.login, avatar: p.user.avatar_url } : null,
    repo: p.base.repo?.full_name ?? repo,
  };
}

async function retarget(repo: Repo, req: { number: unknown; base: unknown }): Promise<PullRequest> {
  const r = await needGhRepos(repo);
  if (typeof req.number !== 'number' || !Number.isInteger(req.number)) throw new GithubError('Which pull request?');
  const p = await rest('PATCH', `/repos/${r.base}/pulls/${req.number}`, { base: text(req.base, 'a base branch') });
  forgetPrs();
  found.clear();
  return fromRest(p, r.base);
}

const lines = (v: string | null) => (v ?? '').split('\n').filter(Boolean);

export const stackGet: Record<string, GetRoute> = {
  prBranches: (repo, q) => branchPrs(repo, lines(q.get('names')), q.get('fresh') === '1'),
  prRemoteBranches: (repo, q) => remoteBranchPrs(repo, lines(q.get('names')), q.get('fresh') === '1'),
  prStack: (repo, q) => prStack(repo, q.get('branch') ?? '', q.get('fresh') === '1'),
  prCreateInfo: (repo, q) => createInfo(repo, q.get('branch') ?? '', q.get('base')),
};

export const stackPost: Record<string, PostRoute> = {
  prCreate: (repo, body) => createPr(repo, body),
  prRetarget: (repo, body) => retarget(repo, body),
};
