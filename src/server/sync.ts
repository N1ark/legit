// Syncing with other branches and remotes: fetch, pull (fast-forward, rebase or merge), merging
// another branch in or rebasing onto it, and finishing or aborting a merge, rebase, cherry-pick
// or revert that stopped halfway.
//
// Fast-forwards and rebases happen in memory and move HEAD once, carrying uncommitted changes
// along like `git switch` (git refuses, changing nothing, if they'd be overwritten). A rebase
// that would conflict is refused. A merge is a real `git merge`, which may stop on conflicts;
// it only starts from a clean working tree, so aborting it can always get back.

import { existsSync } from 'node:fs';
import { lstat, readFile, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CommitDiff, Conflict, ConflictFile, EditStop, RepoState, SyncResult } from '../shared/types.ts';
import { DIFF_ARGS, parseDiff } from './diff.ts';
import { type Git, GitError, fromUtf8, toUtf8 } from './git.ts';
import type { Repo } from './repo.ts';
import { pruneRefs } from './retention.ts';

type Kind = Conflict['kind'];

/** Reads without taking the index lock, so they never get in the way of the user's git. */
const NO_LOCKS = { GIT_OPTIONAL_LOCKS: '0' };
/** Most commits a rebase replays. */
const MAX_REPLAY = 1000;
/** Where the working tree is saved before an abort: refs/legit/aborted/<branch>/<time>-<kind>. */
const ABORTED = 'refs/legit/aborted';
/** Conflict markers at a line start: <<<<<<< ours, ||||||| base, =======, >>>>>>> theirs. */
const MARKERS = /^(?:<{7}|>{7}|\|{7})(?: |\r?$)|^={7}\r?$/m;
const STATUS: Record<string, string> = {
  '123': 'both modified', '23': 'both added', '12': 'deleted by them', '13': 'deleted by us',
  '2': 'added by us', '3': 'added by them', '1': 'both deleted',
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const nul = (paths: string[]) => Buffer.from(paths.map((p) => p + '\0').join(''), 'latin1');

export async function done(repo: Repo, message: string, focus: string[] = [], renamed: Record<string, string> = {}): Promise<SyncResult> {
  return { state: await repo.state(), renamed, focus, message };
}

// ---- state ----

/** The fetch time and any merge/rebase/cherry-pick/revert in progress, for RepoState. */
export async function syncState(repo: Repo): Promise<Pick<RepoState, 'fetchedAt' | 'conflict'>> {
  const [fetchedAt, conflict] = await Promise.all([lastFetch(repo.git), conflictState(repo.git)]);
  return { fetchedAt, conflict };
}

/** FETCH_HEAD is rewritten by every fetch, whoever runs it. */
async function lastFetch(git: Git): Promise<number | null> {
  const dirs = [...new Set([git.gitDir, git.commonDir])];
  const times = await Promise.all(dirs.map((d) => stat(join(d, 'FETCH_HEAD')).then((s) => s.mtimeMs, () => 0)));
  const t = Math.max(...times);
  return t ? Math.round(t) : null;
}

export function inProgress(git: Git): Kind | null {
  const has = (f: string) => existsSync(join(git.gitDir, f));
  if (has('rebase-merge')) return 'rebase';
  if (has('rebase-apply')) return has('rebase-apply/applying') ? 'am' : 'rebase';
  if (has('MERGE_HEAD')) return 'merge';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  return null;
}

export const readGitFile = (git: Git, f: string) => readFile(join(git.gitDir, f), 'utf8').then((s) => s.trim(), () => '');
const rebaseDir = (git: Git) => (existsSync(join(git.gitDir, 'rebase-merge')) ? 'rebase-merge' : 'rebase-apply');

async function describe(git: Git, kind: Kind): Promise<string> {
  if (kind === 'merge') return (await readGitFile(git, 'MERGE_MSG')).split('\n')[0] || 'Merge';
  if (kind === 'am') return 'Applying patches (git am)';
  if (kind === 'rebase') {
    const dir = rebaseDir(git);
    const [name, onto, n, of] = await Promise.all(
      ['head-name', 'onto', dir === 'rebase-merge' ? 'msgnum' : 'next', dir === 'rebase-merge' ? 'end' : 'last'].map((f) =>
        readGitFile(git, `${dir}/${f}`),
      ),
    );
    return `Rebasing ${name.replace(/^refs\/heads\//, '') || 'HEAD'} onto ${onto.slice(0, 7)}${n && of ? ` (${n} of ${of})` : ''}`;
  }
  const sha = await readGitFile(git, kind === 'cherry-pick' ? 'CHERRY_PICK_HEAD' : 'REVERT_HEAD');
  const subject = await git.text(['log', '-1', '--format=%s', sha, '--'], { allowFail: true });
  return `${kind === 'cherry-pick' ? 'Cherry-picking' : 'Reverting'} ${sha.slice(0, 7)} "${subject}"`;
}

/** The branch an operation is on: a rebase detaches HEAD, so it's the one being rebased. */
async function opBranch(repo: Repo, kind: Kind): Promise<string | null> {
  if (kind !== 'rebase') return repo.currentBranch();
  const name = await readGitFile(repo.git, `${rebaseDir(repo.git)}/head-name`);
  return name.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : null;
}

/** Unmerged paths (byte strings) and which index stages they have, e.g. "123". */
export async function unmergedPaths(git: Git): Promise<Map<string, string>> {
  const r = await git.run(['ls-files', '-u', '-z'], { env: NO_LOCKS, allowFail: true });
  const out = new Map<string, string>();
  for (const e of r.out.toString('latin1').split('\0')) {
    const tab = e.indexOf('\t');
    if (tab < 0) continue;
    const path = e.slice(tab + 1);
    out.set(path, (out.get(path) ?? '') + e.slice(0, tab).split(' ')[2]);
  }
  return out;
}

/**
 * Tracked files (byte strings) changed since they were staged, outside the unmerged ones. A
 * rebase won't continue with any (git says to "edit all merge conflicts"), unlike a merge.
 */
async function unstagedPaths(git: Git, unmerged: Map<string, string>): Promise<string[]> {
  const r = await git.run(['diff', '--no-ext-diff', '--ignore-submodules', '--name-only', '-z'], { env: NO_LOCKS, allowFail: true });
  return [...new Set(r.out.toString('latin1').split('\0'))].filter((p) => p && !unmerged.has(p));
}

async function inspect(git: Git, path: string): Promise<Pick<ConflictFile, 'exists' | 'markers' | 'line'>> {
  try {
    const file = join(git.root, toUtf8(path));
    const st = await lstat(file);
    if (!st.isFile() || st.size > 50 * 1024 * 1024) return { exists: true, markers: false, line: null };
    const text = (await readFile(file)).toString('latin1');
    const m = MARKERS.exec(text);
    if (!m) return { exists: true, markers: false, line: null };
    let line = 1;
    for (let i = text.indexOf('\n'); i >= 0 && i < m.index; i = text.indexOf('\n', i + 1)) line++;
    return { exists: true, markers: true, line };
  } catch {
    return { exists: false, markers: false, line: null };
  }
}

async function conflictState(git: Git): Promise<Conflict | null> {
  const kind = inProgress(git);
  if (!kind) return null;
  const [title, unmerged, staged] = await Promise.all([
    describe(git, kind),
    unmergedPaths(git),
    git.run(['diff-index', '--cached', '--name-only', '-z', 'HEAD'], { env: NO_LOCKS, allowFail: true }),
  ]);
  const files: ConflictFile[] = await Promise.all(
    [...unmerged].map(async ([path, stages]) => ({
      path: toUtf8(path),
      status: STATUS[stages] ?? 'conflicted',
      ...(await inspect(git, path)),
    })),
  );
  const resolved = [...new Set(staged.out.toString('latin1').split('\0'))].filter((p) => p && !unmerged.has(p)).map(toUtf8);
  const edit = kind === 'rebase' && !unmerged.size ? await editStop(git) : null;
  const unstaged = kind === 'rebase' && !edit ? (await unstagedPaths(git, unmerged)).map(toUtf8) : [];
  return { kind, title, files, resolved, unstaged, edit };
}

/** What legit notes about an edit it started (see edit.ts), inside git's rebase dir so it goes with it. */
export const EDIT_NOTE = 'rebase-merge/legit-edit';

/**
 * A rebase stopped to edit a commit (`edit` in its todo), with HEAD still that commit: not on a
 * conflict, and nothing committed on top of it since.
 */
export async function editStop(git: Git): Promise<EditStop | null> {
  if (!existsSync(join(git.gitDir, 'rebase-merge'))) return null;
  const [amend, head, todo] = await Promise.all([
    readGitFile(git, 'rebase-merge/amend'),
    git.text(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { allowFail: true }),
    readGitFile(git, 'rebase-merge/git-rebase-todo'),
  ]);
  if (!amend || amend !== head) return null;
  const picks = todo
    .split('\n')
    .map((l) => /^(?:p|pick|e|edit|r|reword|s|squash|f|fixup)\s+([0-9a-f]{4,64})\b/.exec(l.trim())?.[1])
    .filter((x): x is string => !!x);
  const log = (shas: string[]) =>
    git
      .text(['log', '--no-walk=unsorted', '--format=%H%x00%s', ...shas, '--'], { allowFail: true })
      .then((o) => o.split('\n').filter(Boolean).map((l) => {
        const [sha, subject] = l.split('\0');
        return { sha, subject };
      }));
  const [[self], pending] = await Promise.all([log([head]), picks.length ? log(picks) : []]);
  return { sha: head, subject: self?.subject ?? '', pending, legit: existsSync(join(git.gitDir, EDIT_NOTE)) };
}

// ---- fetch ----

/** Network settings: never wait for a password or a host-key prompt nobody can answer. */
async function networkEnv(git: Git): Promise<Record<string, string>> {
  // GIT_TERMINAL_PROMPT=0 (set for every git call) covers HTTPS; this covers SSH, unless
  // the user set up their own SSH command.
  if (process.env.GIT_SSH_COMMAND || process.env.GIT_SSH) return {};
  if (await git.text(['config', '--get', 'core.sshCommand'], { allowFail: true })) return {};
  return { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=30' };
}

/** The remote to fetch: the current branch's upstream remote, else origin, else the first one. */
async function remoteFor(git: Git, branch: string | null): Promise<string | null> {
  const [up, remotes] = await Promise.all([
    branch ? git.text(['for-each-ref', '--format=%(upstream:remotename)', `refs/heads/${branch}`]) : '',
    git.text(['remote']),
  ]);
  const names = remotes.split('\n').filter(Boolean);
  if (up && names.includes(up)) return up;
  return names.includes('origin') ? 'origin' : (names[0] ?? null);
}

/** Running fetches, so a second request for the same remote waits for the first. */
const fetches = new Map<string, Promise<void>>();

/**
 * `git fetch <remote>`. Not serialised with other operations: a fetch only updates
 * remote-tracking refs (each atomically, under git's ref locks) and FETCH_HEAD, never HEAD,
 * a local branch, the index or the working tree. Operations that use a remote-tracking ref
 * read it once, so a fetch landing midway can't make them act on a mix of old and new.
 */
function fetchFrom(git: Git, remote: string): Promise<void> {
  const key = `${git.root}\0${remote}`;
  let p = fetches.get(key);
  if (!p) {
    p = (async () => {
      const r = await git.run(['fetch', remote], { allowFail: true, timeout: 120_000, env: await networkEnv(git) });
      if (r.code === 0) return;
      const err = r.err.trim();
      const auth = /terminal prompts disabled|could not read Username|Authentication failed|Permission denied|Host key verification failed/i.test(err);
      throw new GitError(
        r.code < 0
          ? `Fetching from ${remote} timed out; nothing was changed.`
          : `Couldn't fetch from ${remote}; nothing was changed.${auth ? " Git needs credentials it can't ask for here: fetch once from a terminal, or set up a credential helper or ssh-agent." : ''}\n${err}`,
      );
    })().finally(() => fetches.delete(key));
    fetches.set(key, p);
  }
  return p;
}

export async function fetchRemote(repo: Repo): Promise<SyncResult> {
  const remote = await remoteFor(repo.git, await repo.currentBranch());
  if (!remote) throw new GitError('This repository has no remote to fetch from.');
  await fetchFrom(repo.git, remote);
  return done(repo, `Fetched ${remote}.`);
}

// ---- pull, merge, rebase ----

interface Target {
  /** Full ref name, e.g. refs/remotes/origin/main. */
  ref: string;
  /** Short name for messages, e.g. origin/main. */
  name: string;
  how: 'ff' | 'rebase' | 'merge';
  /** Backup and undo label. */
  label: string;
}

/**
 * Bring the current branch's upstream in: fetch it, then fast-forward when only behind. When
 * the branch has diverged, `how` says whether to rebase onto it or merge it.
 */
export async function pull(repo: Repo, req: { how?: 'rebase' | 'merge' }): Promise<SyncResult> {
  const why = repo.blocked();
  if (why) throw new GitError(why);
  const branch = await repo.currentBranch();
  if (!branch) throw new GitError('HEAD is detached; switch to a branch to pull.');
  const out = await repo.git.text([
    'for-each-ref', '--format=%(upstream)%00%(upstream:remotename)%00%(upstream:short)', `refs/heads/${branch}`,
  ]);
  const [ref, remote, name] = out.split('\0');
  if (!ref) throw new GitError(`${branch} doesn't track a remote branch, so there's nothing to pull.`);
  if (remote && remote !== '.') await fetchFrom(repo.git, remote);
  const how = req.how === 'rebase' || req.how === 'merge' ? req.how : 'ff';
  return repo.exclusive(() => integrate(repo, { ref, name, how, label: 'pull' }));
}

/** `git merge <branch>` into the current branch (a fast-forward when it's only behind). */
export function mergeBranch(repo: Repo, req: { branch: string }): Promise<SyncResult> {
  return repo.exclusive(async () => integrate(repo, { ...(await branchRef(repo.git, req.branch)), how: 'merge', label: 'merge' }));
}

/** Replay the current branch's own commits onto `branch`, in memory; refused on any conflict. */
export function rebaseBranch(repo: Repo, req: { branch: string }): Promise<SyncResult> {
  return repo.exclusive(async () => integrate(repo, { ...(await branchRef(repo.git, req.branch)), how: 'rebase', label: 'rebase' }));
}

/** A local or remote-tracking branch by name. */
async function branchRef(git: Git, name: unknown): Promise<{ ref: string; name: string }> {
  if (typeof name !== 'string' || !name || name.startsWith('-')) throw new GitError('Pick a branch.');
  for (const ref of [`refs/heads/${name}`, `refs/remotes/${name}`]) {
    const r = await git.run(['show-ref', '--verify', '--quiet', ref], { allowFail: true });
    if (r.code === 0) return { ref, name };
  }
  throw new GitError(`No branch named ${name}.`);
}

async function integrate(repo: Repo, t: Target): Promise<SyncResult> {
  const git = repo.git;
  const why = repo.blocked();
  if (why) throw new GitError(why);
  const head = await repo.head();
  if (!head) throw new GitError('This branch has no commits yet.');
  const here = (await repo.currentBranch()) ?? 'HEAD';
  const r = await git.run(['rev-parse', '-q', '--verify', `${t.ref}^{commit}`], { allowFail: true });
  const target = r.out.toString('latin1').trim();
  if (r.code !== 0 || !target) throw new GitError(`${t.name} doesn't exist; nothing was changed.`);
  const [onlyHere, onlyThere] = (await git.text(['rev-list', '--left-right', '--count', `${head}...${target}`])).split(/\s+/).map(Number);

  if (!onlyThere) return done(repo, t.label === 'pull' ? 'Already up to date.' : `${here} already contains ${t.name}.`);
  if (!onlyHere) {
    await carry(repo, head, target, t.label);
    return done(repo, `Fast-forwarded ${here} to ${t.name} (${plural(onlyThere, 'new commit')}).`);
  }
  if (t.how === 'ff') {
    throw new GitError(
      `${here} and ${t.name} have diverged (${onlyHere} commit${onlyHere === 1 ? '' : 's'} only here, ${onlyThere} only there), ` +
        'so they need a rebase or a merge. Nothing was changed.',
    );
  }
  return t.how === 'rebase' ? rebase(repo, head, target, t, here) : merge(repo, head, t, here);
}

/**
 * Move HEAD from `from` to `to` like `git merge --ff-only` or `git switch` would: uncommitted
 * changes come along, and git refuses (changing nothing) if they or an untracked file would be
 * overwritten. The old tip is backed up first, HEAD moves with a compare-and-swap, and the move
 * can be undone.
 */
async function carry(repo: Repo, from: string, to: string, label: string) {
  const git = repo.git;
  await git.run(['update-index', '-q', '--refresh'], { allowFail: true });
  const r = await git.run(['read-tree', '-m', '-u', from, to], { allowFail: true });
  if (r.code !== 0) {
    throw new GitError(`Your uncommitted changes (or untracked files) are in the way, so nothing was changed. Commit or stash them first.\n${r.err.trim()}`);
  }
  try {
    await repo.backup(from, label);
    const u = await git.run(['update-ref', '-m', `legit: ${label}`, 'HEAD', to, from], { allowFail: true });
    if (u.code !== 0) throw new GitError(`HEAD moved in the meantime; nothing was changed. ${u.err.trim()}`);
  } catch (e) {
    await git.run(['read-tree', '-m', '-u', to, from], { allowFail: true });
    throw e;
  }
  await repo.record({ label, before: from, after: to });
}

/**
 * Replay the commits only on HEAD onto `target`, like `git rebase`, but in memory through
 * merge-tree: any conflict refuses the whole thing. Commits whose changes are already in
 * `target` become empty and are dropped, as `git rebase` does.
 */
async function rebase(repo: Repo, head: string, target: string, t: Target, here: string): Promise<SyncResult> {
  const git = repo.git;
  const rows = (await git.text(['rev-list', '--reverse', '--topo-order', '--parents', head, '--not', target]))
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(' '));
  if (rows.length > MAX_REPLAY) throw new GitError(`That would replay ${rows.length} commits, more than legit rebases at once. Nothing was changed.`);
  const merge = rows.find((r) => r.length > 2);
  if (merge) {
    throw new GitError(
      `The commits only on ${here} include a merge (${merge[0].slice(0, 7)}), which a rebase can't replay. Merge ${t.name} instead. Nothing was changed.`,
    );
  }
  const commits = await git.loadCommits(rows.map((r) => r[0]));
  if (commits.some((c, i) => i > 0 && c.parents[0] !== commits[i - 1].sha)) {
    throw new GitError(`The commits only on ${here} aren't a straight line; nothing was changed.`);
  }

  const committer = await git.committerIdent();
  const merger = git.merger();
  let parent = target;
  let parentTree = await git.treeOf(target);
  const out: string[] = [];
  const renamed: Record<string, string> = {};
  let dropped = 0;
  try {
    for (const c of commits) {
      const base = await git.treeOf(c.parents[0] ?? null);
      let tree: string;
      try {
        tree = await repo.pickOrThrow(merger, base, parentTree, c);
      } catch (e) {
        if (!(e instanceof GitError)) throw e;
        throw new GitError(`Rebasing ${here} onto ${t.name} would conflict. ${e.message} Merge instead to resolve the conflicts by hand.`);
      }
      if (tree === parentTree && c.tree !== base) {
        dropped++;
        continue;
      }
      const sha = git.writeCommit({ tree, parents: [parent], author: c.author, committer, extra: c.extra, message: c.message });
      out.push(sha);
      renamed[c.sha] = sha;
      parent = sha;
      parentTree = tree;
    }
    await git.flush();
  } finally {
    merger.close();
  }
  if (out.length) await repo.verify(target, parent, out);
  await carry(repo, head, parent, t.label);
  const skipped = dropped ? ` (${plural(dropped, 'commit')} already there ${dropped === 1 ? 'was' : 'were'} dropped)` : '';
  return done(repo, `Rebased ${plural(out.length, 'commit')} of ${here} onto ${t.name}${skipped}.`, [parent], renamed);
}

/**
 * A real `git merge`, which may stop on conflicts for the conflict view to resolve. It only
 * starts from a working tree without changes to tracked files: git's own abort can't always
 * restore changes that were there before a merge.
 */
async function merge(repo: Repo, head: string, t: Target, here: string): Promise<SyncResult> {
  const git = repo.git;
  await git.run(['update-index', '-q', '--refresh'], { allowFail: true });
  const status = await git.text(['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=none']);
  if (status) {
    throw new GitError(
      `Merging needs a working tree without uncommitted changes (untracked files are fine), so the merge can always be aborted cleanly. You have:\n${status}\nCommit or stash them first. Nothing was changed.`,
    );
  }
  await repo.backup(head, t.label);
  // The short name gives the usual message ("Merge branch 'x'"), unless it means something else.
  const short = await git.text(['rev-parse', '-q', '--verify', `${t.name}^{commit}`], { allowFail: true });
  const target = await git.text(['rev-parse', '--verify', `${t.ref}^{commit}`]);
  const r = await git.run(['merge', '--no-edit', short === target ? t.name : t.ref], {
    allowFail: true,
    timeout: 600_000,
    env: { GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' },
  });
  const output = (r.err + r.out.toString('utf8')).trim();
  if (inProgress(git) === 'merge') {
    const n = (await unmergedPaths(git)).size;
    return done(
      repo,
      n
        ? `Merging ${t.name} stopped with conflicts in ${plural(n, 'file')}. Resolve them, then continue (or abort).`
        : `Merging ${t.name} stopped before committing; continue to commit it (or abort).\n${output}`,
    );
  }
  const after = await repo.head();
  if (r.code !== 0 || !after || after === head) {
    throw new GitError(after === head ? `Merge failed; nothing was changed.\n${output}` : `Merge failed.\n${output}`);
  }
  await repo.record({ label: t.label, before: head, after });
  return done(repo, `Merged ${t.name} into ${here}.`, [after]);
}

// ---- resolving conflicts ----

/** `git add` a conflicted file. Refused while it still has conflict markers, unless `force`. */
export function markResolved(repo: Repo, req: { path: string; force?: boolean }): Promise<SyncResult> {
  return repo.exclusive(async () => {
    const shown = String(req.path ?? '');
    const path = fromUtf8(shown);
    const unmerged = await unmergedPaths(repo.git);
    // A file changed again after it was staged (in a rebase, which won't continue so) is staged again.
    const again = !unmerged.has(path) && inProgress(repo.git) === 'rebase' && (await unstagedPaths(repo.git, unmerged)).includes(path);
    if (!unmerged.has(path) && !again) throw new GitError(`${shown} isn't conflicted (any more); nothing was changed.`);
    const { markers } = await inspect(repo.git, path);
    if (markers && !req.force) {
      throw new GitError(`${shown} still has conflict markers (<<<<<<<, =======, >>>>>>>). Nothing was changed.`);
    }
    // -A stages a deletion too, when deleting the file was the resolution.
    await repo.git.run(['--literal-pathspecs', 'add', '-A', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      input: nul([path]),
    });
    return done(repo, again ? `Staged ${shown} again.` : `Marked ${shown} as resolved.`);
  });
}

const CONTINUE: Record<Kind, string[]> = {
  merge: ['merge', '--continue'],
  rebase: ['rebase', '--continue'],
  'cherry-pick': ['cherry-pick', '--continue'],
  revert: ['revert', '--continue'],
  am: ['am', '--continue'],
};

/**
 * Commit the resolution and carry on (`git merge --continue`, `git rebase --continue`...),
 * with the prepared message. Only once nothing is unmerged. The tip that's about to be
 * replaced is backed up first, and a finished merge, rebase, cherry-pick or revert can be undone.
 */
export function continueOp(repo: Repo): Promise<SyncResult> {
  return repo.exclusive(() => continueNow(repo));
}

/** `continueOp`, for a caller already holding the repo's lock. `label` names the undo step. */
export async function continueNow(repo: Repo, label?: string): Promise<SyncResult> {
    const git = repo.git;
    const kind = inProgress(git);
    if (!kind) throw new GitError('There is no merge, rebase, cherry-pick or revert to continue.');
    const unmerged = [...(await unmergedPaths(git)).keys()].map(toUtf8);
    if (unmerged.length) {
      throw new GitError(`Still conflicted: ${unmerged.join(', ')}. Resolve and mark them resolved first. Nothing was changed.`);
    }
    if (kind === 'rebase') {
      const unstaged = (await unstagedPaths(git, new Map())).map(toUtf8);
      if (unstaged.length) {
        throw new GitError(
          `Changed since staged: ${unstaged.join(', ')}. Stage ${unstaged.length === 1 ? 'it' : 'them'} to keep the change in the commit, or undo it; a rebase won't continue otherwise. Nothing was changed.`,
        );
      }
    }
    const head = await repo.head();
    const branch = await opBranch(repo, kind);
    // A rebase moves the branch from where it was before the rebase started.
    const before = kind === 'rebase' ? (await readGitFile(git, `${rebaseDir(git)}/orig-head`)) || head : head;
    if (before) await backupOnce(repo, before, kind, branch);

    const r = await git.run(CONTINUE[kind], { allowFail: true, timeout: 600_000, env: { GIT_EDITOR: 'true' } });
    const still = inProgress(git);
    const after = await repo.head();
    const output = (r.err + r.out.toString('utf8')).trim();
    if (still) {
      // Nothing was unmerged before, so unmerged files now are a new conflict (maybe in the very next commit).
      if (r.code === 0 || after !== head || (await unmergedPaths(git)).size) {
        const n = (await unmergedPaths(git)).size;
        return done(repo, `Continued; the ${kind} stopped again${n ? ` with conflicts in ${plural(n, 'file')}` : ''}.`);
      }
      throw new GitError(`Couldn't continue the ${kind}; it's still in progress and nothing was lost.\n${output}`);
    }
    if (r.code !== 0) throw new GitError(`The ${kind} ended with an error.\n${output}`);
    if (before && after && after !== before && (await repo.currentBranch()) === branch) {
      await repo.record({ label: label ?? kind, before, after });
    }
    return done(repo, `Finished the ${kind}.`, after ? [after] : []);
}

/** Back up `sha` unless it's already the newest backup of `branch`. */
async function backupOnce(repo: Repo, sha: string, label: string, branch: string | null) {
  const newest = await repo.git.text([
    'for-each-ref', '--sort=-refname', '--count=1', '--format=%(objectname)', `refs/legit/backups/${branch ?? '_detached'}/`,
  ]);
  if (newest !== sha) await repo.backup(sha, label, branch);
}

/**
 * Abort a merge, rebase, cherry-pick or revert. Aborting throws away what was resolved so
 * far, so first the working tree's version of every changed file is committed (on top of
 * HEAD, in a throwaway index) and kept as refs/legit/aborted/<branch>/<time>-<kind>.
 */
export function abortOp(repo: Repo): Promise<SyncResult> {
  return repo.exclusive(() => abortNow(repo));
}

/** `abortOp`, for a caller already holding the repo's lock. `untracked`: new files to save too. */
export async function abortNow(repo: Repo, untracked: string[] = []): Promise<SyncResult> {
    const git = repo.git;
    const kind = inProgress(git);
    if (!kind) throw new GitError('There is no merge, rebase, cherry-pick or revert to abort.');
    const head = await repo.head();
    let saved: string | null = null;
    let changed = false;
    if (head) {
      const tree = await worktreeTree(git, head, [...new Set([...(await changedPaths(git)), ...untracked])]);
      changed = tree !== (await git.treeOf(head));
      let sha = head;
      if (changed) {
        const ident = await git.committerIdent().catch(() => `legit <legit@localhost> ${Math.floor(Date.now() / 1000)} +0000`);
        const title = await describe(git, kind);
        sha = git.writeCommit({
          tree, parents: [head], author: ident, committer: ident, extra: [],
          message: fromUtf8(`Work in progress before aborting the ${kind}\n\n${title}\n`),
        });
        await git.flush();
      }
      // HEAD itself is kept too (it's the parent): an aborted rebase or cherry-pick moves it back.
      saved = `${ABORTED}/${(await opBranch(repo, kind)) ?? '_detached'}/${Date.now()}-${kind}`;
      await git.run(['update-ref', '-m', `legit: before aborting the ${kind}`, saved, sha, '']);
      await pruneRefs(git);
    }
    const r = await git.run([kind, '--abort'], { allowFail: true, timeout: 120_000 });
    if (r.code !== 0) {
      throw new GitError(`Couldn't abort the ${kind}.${saved ? ` (Your work in progress is saved as ${saved}.)` : ''}\n${r.err.trim()}`);
    }
    return done(
      repo,
      changed
        ? `Aborted the ${kind}. Your files as they were (resolutions included) were saved first, as ${saved}; \`git restore -s ${saved} -- <file>\` brings one back.`
        : `Aborted the ${kind}.`,
    );
}

/** Paths (byte strings) whose index or working-tree version differs from HEAD, or that are unmerged. */
export async function changedPaths(git: Git): Promise<string[]> {
  const lists = await Promise.all([
    git.run(['diff-index', '--name-only', '-z', 'HEAD'], { env: NO_LOCKS }),
    git.run(['diff-index', '--cached', '--name-only', '-z', 'HEAD'], { env: NO_LOCKS }),
    git.run(['ls-files', '-u', '-z'], { env: NO_LOCKS }),
  ]);
  const paths = new Set<string>();
  for (const p of lists[0].out.toString('latin1').split('\0')) if (p) paths.add(p);
  for (const p of lists[1].out.toString('latin1').split('\0')) if (p) paths.add(p);
  for (const e of lists[2].out.toString('latin1').split('\0')) if (e.includes('\t')) paths.add(e.slice(e.indexOf('\t') + 1));
  return [...paths];
}

/** HEAD's tree with `paths` as they are in the working tree, built in a throwaway index. */
export async function worktreeTree(git: Git, head: string, paths: string[]): Promise<string> {
  if (!paths.length) return git.treeOf(head);
  const index = join(tmpdir(), `legit-index-${randomBytes(6).toString('hex')}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git.run(['read-tree', head], { env });
    const exists = await Promise.all(paths.map((p) => lstat(join(git.root, toUtf8(p))).then(() => true, () => false)));
    const present = paths.filter((_, i) => exists[i]);
    const gone = paths.filter((_, i) => !exists[i]);
    if (present.length) {
      await git.run(['--literal-pathspecs', 'add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: nul(present) });
    }
    if (gone.length) await git.run(['update-index', '--force-remove', '-z', '--stdin'], { env, input: nul(gone) });
    return await git.text(['write-tree'], { env });
  } finally {
    await unlink(index).catch(() => {});
  }
}

/**
 * What finishing would change on top of HEAD, from the working tree (conflict markers
 * included), as a snapshot the diff view can page through.
 */
export async function conflictDiff(repo: Repo): Promise<CommitDiff> {
  await repo.idle();
  const git = repo.git;
  const head = await repo.head();
  if (!head || !inProgress(git)) throw new GitError('Nothing is being merged.');
  const tree = await worktreeTree(git, head, await changedPaths(git));
  const { out } = await git.run(['diff-tree', ...DIFF_ARGS, await git.treeOf(head), tree]);
  return repo.snapshot('conflict', parseDiff(out.toString('latin1'), ''));
}
