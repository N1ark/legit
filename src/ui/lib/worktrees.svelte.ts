// Worktree actions shared by the repository and branch pickers. Switching to another worktree
// shows it in this window (the app) or this tab (the browser), like switching repository.
import { IS_TAURI, toast } from 'purr';
import type { OpResult, WorktreeInfo, WorktreeRequest } from '../../shared/types.ts';
import { app, request } from './app.svelte.ts';
import { invoke } from './desktop.ts';
import { Listed } from './listed.ts';

/** The worktrees the repository picker and ⌘K list (see `Listed`). */
export const worktreeList = new Listed<WorktreeInfo[]>('/api/worktrees');
export const listWorktrees = () => worktreeList.load();

/** Show the worktree at `path` instead of this one. */
export async function openWorktree(path: string) {
  if (app.switchBlocker) return toast(app.switchBlocker);
  try {
    // The app asks the page before switching (App.svelte `leave`); the browser keeps the view on `pagehide`.
    if (IS_TAURI) await invoke('open_worktree', { path });
    else location.href = (await request<{ url: string }>('/api/openWorktree', { path })).url;
  } catch (e) {
    toast.error(e);
  }
}

/** What `newWorktree` starts from: a branch name to suggest, or a commit (`what` names it) to branch from. */
export type WorktreeStart = { branch?: string; from?: string; what?: string; track?: boolean };

/** The new-worktree dialog on screen (NewWorktreeDialog.svelte), if any. */
class WorktreeQuestion {
  pending = $state<{ start: WorktreeStart; answer: (a: { branch: string; path: string; open: boolean } | null) => void } | null>(null);

  ask(start: WorktreeStart) {
    this.pending?.answer(null);
    return new Promise<{ branch: string; path: string; open: boolean } | null>((done) => {
      this.pending = {
        start,
        answer: (a) => {
          this.pending = null;
          done(a);
        },
      };
    });
  }
}

export const worktreeQuestion = new WorktreeQuestion();

/**
 * Ask for a branch (an existing local one, or a new one from `from`, HEAD by default) and a
 * folder, and add a worktree for it, switching to it by default.
 */
export async function newWorktree(start: WorktreeStart = {}): Promise<boolean> {
  const answer = await worktreeQuestion.ask(start);
  if (!answer) return false;
  const { branch } = answer;
  const req: WorktreeRequest = { branch, path: answer.path || undefined, from: start.from, track: start.track };
  let path = '';
  const ok = await app.op('addWorktree', req, undefined, async (r) => (path = (r as OpResult & { path: string }).path));
  if (!ok) return false;
  if (answer.open) await openWorktree(path);
  else toast(`Created a worktree for ${branch}`);
  return true;
}

/**
 * Remove a worktree, once its button was clicked twice: its folder goes, its branch stays (the
 * server refuses one with uncommitted changes or untracked files, and keeps commits only it has).
 */
export async function removeWorktree(w: WorktreeInfo): Promise<boolean> {
  if (!(await app.op('removeWorktree', { path: w.path }))) return false;
  toast(w.missing ? `Forgot ${w.name}` : `Removed ${w.name}`);
  return true;
}

/** What removing `w` does, for its button's tooltip. */
export function removeWorktreeTip(w: WorktreeInfo): string {
  if (w.missing) return `Forget it: ${w.short} is already gone`;
  const keeps = w.branch ? `${w.branch} stays` : 'commits only it has go under Recently deleted';
  return `Remove it: deletes ${w.short}, ignored files included; ${keeps}. Refused if it has uncommitted changes or untracked files.`;
}
