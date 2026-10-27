// Branch actions shared by the branch picker and the commit list.
//
// Switching with uncommitted changes asks first, like GitHub Desktop: leave them on the branch
// being left (stashed) or bring them along (`git switch`, which refuses if they'd be
// overwritten). The question is asked before the request, so no lock is held while waiting.
import { confirmAction, dialog, promptText, toast } from 'purr';
import type { BranchInfo, DeleteBranchesResult, DeletedBranch, RebuildPlan, RemoteBranchInfo } from '../../shared/types.ts';
import { app, request, shortSha } from './app.svelte.ts';
import { Listed } from './listed.ts';

/** The branch lists the branch picker, ⌘K and the new-worktree dialog show (see `Listed`). */
export const lists = {
  local: new Listed<BranchInfo[]>('/api/branches'),
  /** Those no local branch tracks or shares a name with. */
  remote: new Listed<RemoteBranchInfo[]>('/api/branches/remote'),
  allRemote: new Listed<RemoteBranchInfo[]>('/api/branches/remote?all=1'),
  deleted: new Listed<DeletedBranch[]>('/api/branches/deleted'),
  remotes: new Listed<string[]>('/api/remotes'),
};

export type Choice = 'leave' | 'bring';

class SwitchQuestion {
  /** The question on screen, if any. */
  pending = $state<{ from: string | null; to: string; answer: (c: Choice | null) => void } | null>(null);

  ask(from: string | null, to: string): Promise<Choice | null> {
    this.pending?.answer(null);
    return new Promise((done) => {
      this.pending = {
        from,
        to,
        answer: (c) => {
          this.pending = null;
          done(c);
        },
      };
    });
  }
}

export const question = new SwitchQuestion();

/** Commits waiting for the branch picker to pick a branch: to copy them to, or to rebuild this one on. */
class CommitsRequest {
  pending = $state<{ shas: string[]; mode: 'copy' | 'rebuild' } | null>(null);
}

export const commitsRequest = new CommitsRequest();

/** Open the branch picker to cherry-pick `shas` onto another branch. */
export function copyToBranch(shas: string[]) {
  commitsRequest.pending = { shas, mode: 'copy' };
}

/** Open the branch picker to rebuild the current branch on another from `shas` (see `rebuild`). */
export function rebuildOn(shas: string[]) {
  if (!app.repo?.branch) return toast.error('HEAD is detached: switch to a branch first.');
  if (!shas.length) return toast.error('Select the commits to keep first.');
  commitsRequest.pending = { shas, mode: 'rebuild' };
}

/**
 * Make the current branch `base` plus `shas`, dropping its other commits, once confirmed with
 * how many are kept and dropped.
 */
export async function rebuild(shas: string[], base: string): Promise<void> {
  const here = app.repo?.branch;
  let plan: RebuildPlan;
  try {
    plan = await request<RebuildPlan>(`/api/rebuild/plan?branch=${encodeURIComponent(base)}&shas=${shas.join(',')}`);
  } catch (e) {
    return void toast.error(e);
  }
  if (plan.unchanged) return void toast(`${here} already is ${base} plus ${plan.kept === 1 ? 'that commit' : 'those commits'}.`);
  const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;
  const there = plan.there ? ` ${commits(plan.there)} of those ${plan.there === 1 ? 'is' : 'are'} already on ${base}.` : '';
  const ok = await confirmAction(`Rebuild ${here} on ${base}?`, {
    description:
      `${here} becomes ${base} plus ${commits(plan.kept)}, in their order.` +
      (plan.dropped ? ` Its ${plan.dropped === 1 ? 'other commit is' : `${plan.dropped} other commits are`} dropped.` : '') +
      `${there} ⌘Z undoes it.`,
    confirmLabel: `Keep ${commits(plan.kept)}${plan.dropped ? `, drop ${plan.dropped}` : ''}`,
    danger: plan.dropped > 0,
  });
  if (ok) await app.sync('rebuild', { shas, branch: base }, undefined, true);
}

/**
 * Run a switching op (`switch`, `createBranch`, `checkoutRemote`) to branch `to`, asking about
 * uncommitted changes first. Returns true on success.
 */
export async function switchOp(op: string, body: Record<string, unknown>, to: string): Promise<boolean> {
  let stash = false;
  if (app.hasWork) {
    const c = await question.ask(app.repo?.branch ?? null, to);
    if (!c) return false;
    stash = c === 'leave';
  }
  const from = app.repo?.branch;
  if (!(await app.op(op, { ...body, stash }))) return false;
  toast(stash && from ? `Switched to ${to}; changes stashed on ${from}` : `Switched to ${to}`);
  return true;
}

/** Ask for a name and create a branch at `from` (HEAD when absent), switching to it by default. */
export async function newBranch(from?: string, what?: string): Promise<boolean> {
  const at = from ?? app.repo?.head;
  const answer = await dialog.ask({
    title: 'New branch',
    description: at ? `From ${what ? `${what} (${shortSha(at)})` : shortSha(at)}.` : undefined,
    fields: [
      { name: 'name', label: 'Name', required: true, placeholder: 'my-feature' },
      { name: 'checkout', label: 'Switch to it', type: 'checkbox', value: true },
    ],
    confirmLabel: 'Create branch',
  });
  const name = String(answer?.name ?? '').trim();
  if (!answer || !name) return false;
  if (answer.checkout) return switchOp('createBranch', { name, from, checkout: true }, name);
  if (!(await app.op('createBranch', { name, from, checkout: false }))) return false;
  toast(`Created ${name}`);
  return true;
}

export async function renameBranch(from: string): Promise<boolean> {
  const to = await promptText(`Rename ${from}`, { label: 'New name', value: from }, { confirm: 'Rename' });
  if (!to || to === from || !(await app.op('renameBranch', { from, to }))) return false;
  toast(`Renamed ${from} to ${to}`);
  return true;
}

export async function deleteBranch(name: string): Promise<boolean> {
  if (!(await app.op('deleteBranch', { branch: name }))) return false;
  toast(`Deleted ${name}; restorable for two weeks`);
  return true;
}

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 'es'}`;

/** Run a bulk delete; the toast says what was deleted and which were skipped, and why. */
async function bulk(op: string, body: unknown, done: (n: number) => string): Promise<boolean> {
  const got: { r?: DeleteBranchesResult } = {};
  if (!(await app.op(op, body, undefined, async (r) => (got.r = r as DeleteBranchesResult)))) return false;
  const skipped = got.r?.skipped ?? [];
  const also = skipped.length ? `; skipped ${skipped.map((s) => `${s.name} (${s.why})`).join(', ')}` : '';
  toast(done(got.r?.deleted.length ?? 0) + also, { timeout: skipped.length ? 12_000 : 5000 });
  return true;
}

/** Delete several local branches; the current one and those checked out in another worktree are skipped. */
export function deleteBranches(names: string[]): Promise<boolean> {
  return bulk('deleteBranches', { branches: names }, (n) => `Deleted ${plural(n, 'branch')}; restorable for two weeks`);
}

/** Delete several branches on their remotes, given their remote-tracking refs. */
export function deleteRemoteBranches(refs: string[]): Promise<boolean> {
  return bulk(
    'deleteRemoteBranches',
    { refs },
    (n) => `Deleted ${plural(n, 'branch')} on the remote; restorable for two weeks`,
  );
}

/** Delete a branch on its remote, given its remote-tracking ref (refs/remotes/<remote>/<branch>). */
export async function deleteRemoteBranch(ref: string): Promise<boolean> {
  const short = ref.replace(/^refs\/remotes\//, '');
  if (!(await app.op('deleteRemoteBranch', { ref }))) return false;
  toast(`Deleted ${short} on the remote; restorable for two weeks`);
  return true;
}

type Tracked = Pick<BranchInfo, 'name' | 'upstream' | 'tracking'>;

/** Put back what `b` tracked before a change, for the toast's Undo. */
function trackAgain(b: Tracked) {
  const t = b.tracking;
  return {
    label: 'Undo',
    run: () => void app.op(t ? 'setUpstream' : 'unsetUpstream', t ? { branch: b.name, remote: t.remote, name: t.branch } : { branch: b.name }),
  };
}

/** Make `b` track `name` on `remote`; one that isn't there yet is where the next push publishes `b`. */
export async function setUpstream(b: Tracked, remote: string, name: string, exists: boolean): Promise<boolean> {
  if (!(await app.op('setUpstream', { branch: b.name, remote, name }))) return false;
  const then = exists ? '' : `; the next push publishes it to ${remote}`;
  toast(`${b.name} now tracks ${remote}/${name}${then}.`, { action: trackAgain(b), timeout: 8000 });
  return true;
}

export async function unsetUpstream(b: Tracked): Promise<boolean> {
  if (!(await app.op('unsetUpstream', { branch: b.name }))) return false;
  toast(`${b.name} no longer tracks ${b.upstream}.`, { action: trackAgain(b), timeout: 8000 });
  return true;
}

/** Recreate a deleted branch, under a new name if `taken` (its old name is in use). */
export async function restoreBranch(d: { ref: string; name: string }, taken: boolean): Promise<boolean> {
  let name = d.name;
  if (taken) {
    const picked = await promptText(
      `${d.name} already exists`,
      { label: 'Restore it as', value: `${d.name}-restored` },
      { confirm: 'Restore' },
    );
    if (!picked) return false;
    name = picked;
  }
  if (!(await app.op('restoreBranch', { ref: d.ref, name }))) return false;
  toast(`Restored ${name}`);
  return true;
}
