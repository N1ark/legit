// Checking out a pull request, or reviewing it in a worktree of its own: the server fetches its head
// and says where it would go (server/gh/checkout.ts), then what's asked comes first, without a lock
// held: what to do with a branch that has diverged from it, and (switching) with uncommitted changes.

import { toast } from 'purr';
import { app } from './app.svelte.ts';
import { question } from './branches.svelte.ts';
import { checkedOut } from './gh-inbox.ts';
import { ghPost } from './github.svelte.ts';
import { openWorktree } from './worktrees.svelte.ts';
import type { CheckoutPlan } from '../../shared/gh-inbox.ts';

export type DivergedChoice = 'reset' | 'other';

class Checkouts {
  /** The pull request whose head is being fetched. */
  fetching = $state<number | null>(null);
  /** The question about a diverged branch on screen (PrCheckoutDialog.svelte), if any. */
  pending = $state<{ plan: CheckoutPlan; answer: (c: DivergedChoice | null) => void } | null>(null);

  ask(plan: CheckoutPlan): Promise<DivergedChoice | null> {
    this.pending?.answer(null);
    return new Promise((done) => {
      this.pending = {
        plan,
        answer: (c) => {
          this.pending = null;
          done(c);
        },
      };
    });
  }
}

export const checkouts = new Checkouts();

const folder = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/**
 * Check out pull request `number` on a local branch and switch to it, or with `worktree`, give it a
 * worktree next to the repository's and show that one. Returns true when it did.
 */
export async function checkoutPr(number: number, worktree = false): Promise<boolean> {
  if (app.switchBlocker) return (toast(app.switchBlocker), false);
  if (app.repo?.blocked) return (toast(`${app.repo.blocked} Finish or abort it first.`), false);
  if (checkouts.fetching !== null) return false;
  checkouts.fetching = number;
  let plan: CheckoutPlan;
  try {
    plan = await ghPost<CheckoutPlan>('prCheckoutPlan', { number });
  } catch (e) {
    toast.error(e);
    return false;
  } finally {
    checkouts.fetching = null;
  }
  if (plan.worktree) {
    toast(`${plan.branch} is checked out in ${folder(plan.worktree)}`);
    await openWorktree(plan.worktree);
    return true;
  }
  if (plan.current && (worktree || plan.relation === 'same' || plan.relation === 'ahead')) {
    toast(worktree ? `#${number} is ${plan.branch}, which you're on here.` : checkedOut(plan, plan.branch));
    return !worktree;
  }
  let { branch, tip, upstream } = plan;
  let reset = false;
  if (plan.relation === 'diverged') {
    const c = await checkouts.ask(plan);
    if (!c) return false;
    if (c === 'reset') reset = true;
    else [branch, tip, upstream] = [plan.alternative, null, null];
  }
  let stash = false;
  if (!worktree && !(plan.current && branch === plan.branch) && app.hasWork) {
    const c = await question.ask(app.repo?.branch ?? null, branch);
    if (!c) return false;
    stash = c === 'leave';
  }
  const from = app.repo?.branch;
  let path = '';
  const body = { number, sha: plan.sha, branch, tip, upstream, addRemote: upstream ? plan.addRemote : null, head: plan.head, reset, stash, newWorktree: worktree };
  if (!(await app.op('checkoutPr', body, undefined, async (r) => (path = (r as { path?: string }).path ?? '')))) return false;
  const said = checkedOut(plan, branch) + (stash && from ? ` Your changes are stashed on ${from}.` : '');
  if (worktree && path) {
    toast(`${said} It's in ${folder(path)}.`);
    await openWorktree(path);
  } else toast(said, { timeout: 8000 });
  return true;
}
