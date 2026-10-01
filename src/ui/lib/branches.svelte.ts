// Branch actions shared by the branch picker and the commit list.
//
// Switching with uncommitted changes asks first, like GitHub Desktop: leave them on the branch
// being left (stashed) or bring them along (`git switch`, which refuses if they'd be
// overwritten). The question is asked before the request, so no lock is held while waiting.
import { dialog, promptText, toast } from 'purr';
import { app, shortSha } from './app.svelte.ts';

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
  toast(stash && from ? `Switched to ${to}; your changes are stashed on ${from}.` : `Switched to ${to}`);
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
  toast(`Deleted ${name}. It's under Recently deleted in the branch list for two weeks.`);
  return true;
}

/** Delete a branch on its remote, given its remote-tracking ref (refs/remotes/<remote>/<branch>). */
export async function deleteRemoteBranch(ref: string): Promise<boolean> {
  const short = ref.replace(/^refs\/remotes\//, '');
  if (!(await app.op('deleteRemoteBranch', { ref }))) return false;
  toast(`Deleted ${short} on the remote. Its tip is under Recently deleted for two weeks.`);
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
