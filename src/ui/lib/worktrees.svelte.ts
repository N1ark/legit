// Worktree actions shared by the repository and branch pickers. Switching to another worktree
// shows it in this window (the app) or this tab (the browser), like switching repository.
import { IS_TAURI, dialog, toast } from 'purr';
import type { OpResult, WorktreeInfo, WorktreeRequest } from '../../shared/types.ts';
import { app, request } from './app.svelte.ts';
import { invoke } from './desktop.ts';

export const listWorktrees = () => request<WorktreeInfo[]>('/api/worktrees');

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

/**
 * Ask for a branch (an existing local one, or a new one from `from`, HEAD by default) and a
 * folder, and add a worktree for it, switching to it by default.
 */
export async function newWorktree(start: { branch?: string; from?: string; what?: string; track?: boolean } = {}): Promise<boolean> {
  const from = start.what ?? app.repo?.branch ?? 'HEAD';
  const answer = await dialog.ask({
    title: 'New worktree',
    description: `Checks a branch out in a folder of its own, to work on it alongside this one. A new branch starts from ${from}.`,
    fields: [
      { name: 'branch', label: 'Branch', required: true, value: start.branch ?? '', placeholder: 'my-feature' },
      {
        name: 'path',
        label: 'Folder',
        placeholder: `Next to the repository, as ${app.repo?.name ?? 'repo'}-<branch>`,
        hint: "Relative to this worktree's folder; ~ is your home folder.",
      },
      { name: 'open', label: 'Switch to it', type: 'checkbox', value: true },
    ],
    confirmLabel: 'Create worktree',
  });
  const branch = String(answer?.branch ?? '').trim();
  if (!answer || !branch) return false;
  const req: WorktreeRequest = { branch, path: String(answer.path ?? '').trim() || undefined, from: start.from, track: start.track };
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
