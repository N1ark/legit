// Editing a commit's files: it's checked out (a `git rebase -i` that stops at it, as `edit` in
// the todo does), you change anything in your editor, then finishing amends the changes into it
// and `git rebase --continue` replays the commits after it, stopping on conflicts like any
// rebase. Cancelling aborts the rebase, after saving the edits.
//
// It starts from a clean working tree, so an abort gets back exactly. Untracked files that were
// there before are noted (in git's rebase dir) and never folded into the commit.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommitDiff, SyncResult } from '../shared/types.ts';
import { DIFF_ARGS, parseDiff } from './diff.ts';
import { GitError } from './git.ts';
import { Repo } from './repo.ts';
import { EDIT_NOTE, abortNow, changedPaths, continueNow, done, editStop, inProgress, unmergedPaths, worktreeTree } from './sync.ts';

interface Note {
  /** The commit as it was, and the branch tip, when the edit started. */
  sha: string;
  head: string;
  /** Untracked files (byte strings) there before the edit. */
  untracked: string[];
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const nul = (paths: string[]) => Buffer.from(paths.map((p) => p + '\0').join(''), 'latin1');

async function untrackedFiles(repo: Repo): Promise<string[]> {
  const r = await repo.git.run(['ls-files', '--others', '--exclude-standard', '-z']);
  return r.out.toString('latin1').split('\0').filter(Boolean);
}

async function readNote(repo: Repo): Promise<Note | null> {
  try {
    return JSON.parse(await readFile(join(repo.git.gitDir, EDIT_NOTE), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Untracked files made while editing: they go into the commit. Without legit's note (an edit
 * started elsewhere) there's no telling them from files that were already there, so none do.
 */
async function newFiles(repo: Repo): Promise<string[]> {
  const note = await readNote(repo);
  if (!note) return [];
  const before = new Set(note.untracked);
  return (await untrackedFiles(repo)).filter((p) => !before.has(p));
}

/** Check out commit `sha` to edit its files: a rebase that stops at it. */
export function startEdit(repo: Repo, req: { sha: string }): Promise<SyncResult> {
  return repo.exclusive(async () => {
    const git = repo.git;
    const chain = await repo.chain();
    const k = Repo.indexOf(chain, req.sha);
    const c = chain[k];
    const head = chain[0].sha;
    await repo.requireClean();
    const untracked = await untrackedFiles(repo);
    await repo.backup(head, 'edit commit');
    const base = c.parents[0];
    const r = await git.run(
      [
        '-c', 'rebase.autoStash=false', '-c', 'rebase.updateRefs=false', '-c', 'rebase.abbreviateCommands=false',
        // Keep every commit, as legit's own replays do: none dropped as empty or as already applied.
        'rebase', '-i', '--no-autosquash', '--reapply-cherry-picks', '--empty=keep', ...(base ? [base] : ['--root']),
      ],
      {
        allowFail: true,
        timeout: 120_000,
        // The todo starts with this commit: make it stop there.
        env: { GIT_SEQUENCE_EDITOR: "sed -i.legit -E '1s/^pick /edit /'", GIT_EDITOR: 'true' },
      },
    );
    const stop = await editStop(git);
    if (!stop || stop.sha !== c.sha) {
      // Didn't stop where it should (an untracked file in the way, say): put everything back.
      if (inProgress(git)) await git.run(['rebase', '--abort'], { allowFail: true });
      const now = await repo.head();
      const output = (r.err + r.out.toString('utf8')).trim();
      throw new GitError(
        now === head
          ? `Couldn't check out that commit; nothing was changed.\n${output}`
          : `Couldn't check out that commit, and HEAD is now ${now?.slice(0, 7)} (it was ${head.slice(0, 7)}; a backup was made).\n${output}`,
      );
    }
    const note: Note = { sha: c.sha, head, untracked };
    await writeFile(join(git.gitDir, EDIT_NOTE), JSON.stringify(note));
    const n = stop.pending.length;
    return done(
      repo,
      `Checked out "${stop.subject}". Change its files, then finish to amend them into it${n ? ` and replay the ${plural(n, 'commit')} after it` : ''}.`,
    );
  });
}

/** Amend the edits into the commit being edited, then replay the commits after it. */
export function finishEdit(repo: Repo): Promise<SyncResult> {
  return repo.exclusive(async () => {
    const git = repo.git;
    const stop = await editStop(git);
    if (!stop) throw new GitError('No commit is being edited (any more); nothing was changed.');
    if ((await unmergedPaths(git)).size) throw new GitError('Some files are conflicted; resolve them first.');
    await git.run(['add', '-u']);
    const created = await newFiles(repo);
    if (created.length) {
      await git.run(['--literal-pathspecs', 'add', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nul(created) });
    }
    const changed = (await git.run(['diff', '--cached', '--quiet', 'HEAD'], { allowFail: true })).code !== 0;
    if (changed) {
      const r = await git.run(['commit', '--amend', '--no-edit', '--allow-empty'], { allowFail: true, timeout: 600_000, env: { GIT_EDITOR: 'true' } });
      if (r.code !== 0) {
        throw new GitError(`Amending failed; you're still editing, with your changes staged.\n${(r.err + r.out.toString('utf8')).trim()}`);
      }
    }
    const edited = (await repo.head())!;
    const res = await continueNow(repo, 'edit commit');
    const what = changed ? `Amended "${stop.subject}"` : `"${stop.subject}" is unchanged`;
    const n = stop.pending.length;
    if (res.state.conflict) {
      const files = res.state.conflict.files.length;
      res.message = `${what}; replaying the commits after it stopped${files ? ` with conflicts in ${plural(files, 'file')}` : ''}. Resolve them and continue, or abort to put everything back.`;
    } else {
      res.message = `${what}${n ? ` and replayed the ${plural(n, 'commit')} after it` : ''}.`;
      res.focus = [edited];
    }
    return res;
  });
}

/** Stop editing without changing anything: the rebase is aborted, after the edits are saved. */
export function cancelEdit(repo: Repo): Promise<SyncResult> {
  return repo.exclusive(async () => {
    if (!(await editStop(repo.git))) throw new GitError('No commit is being edited (any more); nothing was changed.');
    const res = await abortNow(repo, await newFiles(repo));
    res.message = res.message.replace(/^Aborted the rebase\./, 'Stopped editing; nothing was changed.');
    return res;
  });
}

/** The edits so far (tracked files, and files made while editing) as a snapshot for the diff view. */
export async function editChanges(repo: Repo): Promise<CommitDiff> {
  await repo.idle();
  const git = repo.git;
  const stop = await editStop(git);
  if (!stop) throw new GitError('No commit is being edited.');
  const paths = [...new Set([...(await changedPaths(git)), ...(await newFiles(repo))])];
  const tree = await worktreeTree(git, stop.sha, paths);
  const { out } = await git.run(['diff-tree', ...DIFF_ARGS, await git.treeOf(stop.sha), tree]);
  return repo.snapshot('edit', parseDiff(out.toString('latin1'), ''));
}
