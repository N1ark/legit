// Pull requests around the current branch: every local branch's (badges in the branch list), the
// stack it's in (the header's pull request chip), restacking it, and opening a pull request.

import { toast } from 'purr';
import { app } from './app.svelte.ts';
import { rebuild, switchOp } from './branches.svelte.ts';
import { gh, ghPost, ghRequest } from './github.svelte.ts';
import { openWorktree } from './worktrees.svelte.ts';
import type { CreatePrRequest, PrStack, RestackPlan, StackEntry } from '../../shared/gh-stack.ts';
import type { PullRequest } from '../../shared/github.ts';

class Prs {
  /** Each local branch's pull request, by branch name (once the branch list asked). */
  byBranch = $state.raw<Record<string, PullRequest>>({});
  /** The stack the current branch's pull request is in; null when there's none. */
  stack = $state.raw<PrStack | null>(null);
  /** The "Create pull request" dialog is open. */
  creating = $state(false);

  private branchesAsked = false;
  private stackFor: string | null = null;
  private gen = 0;

  async loadBranches(fresh = false) {
    this.branchesAsked = true;
    if (!gh.ready) return void (this.byBranch = {});
    try {
      this.byBranch = await ghRequest<Record<string, PullRequest>>('prBranches', { fresh: fresh ? 1 : null });
    } catch {}
  }

  async loadStack(fresh = false) {
    const gen = ++this.gen;
    const branch = app.repo?.branch ?? null;
    if (branch !== this.stackFor) this.stack = null;
    this.stackFor = branch;
    if (!gh.ready || !branch || !gh.pr) return void (this.stack = null);
    try {
      const s = await ghRequest<PrStack | null>('prStack', { branch, fresh: fresh ? 1 : null });
      if (gen === this.gen) this.stack = s;
    } catch (e) {
      if (gen === this.gen && fresh) toast.error(e);
    }
  }

  /** After `gh.refresh()`: the stack, and the badges if the branch list showed them. */
  refreshed() {
    this.loadStack();
    if (this.branchesAsked) this.loadBranches();
  }
}

export const prs = new Prs();

/** Switch to a stack entry's branch (its local one, else its remote one checked out, else its worktree). */
export async function switchToEntry(e: StackEntry): Promise<boolean> {
  if (e.current) return true;
  if (e.worktree) {
    await openWorktree(e.worktree);
    return true;
  }
  if (e.branch) return switchOp('switch', { branch: e.branch }, e.branch);
  if (e.remoteRef) return switchOp('checkoutRemote', { ref: e.remoteRef }, e.pr.head);
  toast.error(`${e.pr.head} isn't here; fetch, then try again.`);
  return false;
}

/** Rebuild the current branch on the branch it's stacked on with only its own commits (rebuild asks first). */
export async function restack(plan: RestackPlan) {
  if (plan.onto) await rebuild(plan.shas, plan.onto);
}

/** Point the current branch's pull request at what its merged parent merged into. */
export async function retarget(plan: RestackPlan): Promise<boolean> {
  const pr = gh.pr;
  if (!pr || !plan.retarget) return false;
  try {
    await ghPost('prRetarget', { number: pr.number, base: plan.retarget });
  } catch (e) {
    toast.error(e);
    return false;
  }
  toast(`#${pr.number} now merges into ${plan.retarget}.`);
  await gh.refresh({ fresh: true });
  return true;
}

/** Open the "Create pull request" dialog for the current branch. */
export function openCreatePr() {
  if (!gh.ready) return toast.error(gh.status?.error ?? 'This repository is not on GitHub.');
  if (!app.repo?.branch) return toast.error('HEAD is detached: switch to a branch first.');
  prs.creating = true;
}

/** Push the branch if GitHub doesn't have all of it yet, then open its pull request. */
export async function createPr(req: Omit<CreatePrRequest, 'head'>): Promise<PullRequest | null> {
  const push = app.repo?.push;
  if (!push) {
    toast.error("This branch doesn't push anywhere: add a GitHub remote first.");
    return null;
  }
  if (push.ahead && push.behind) {
    toast.error(`${push.remote}/${push.branch} has commits this branch doesn't: pull or force push first, so the pull request has your commits.`);
    return null;
  }
  if ((push.publish || push.ahead) && !(await app.op('push', { force: false }))) return null;
  let pr: PullRequest;
  try {
    pr = await ghPost<PullRequest>('prCreate', { ...req, head: app.repo?.push?.branch ?? push.branch });
  } catch (e) {
    toast.error(e);
    return null;
  }
  toast(`Opened #${pr.number}: ${pr.title}`, { timeout: 10_000, action: { label: 'Open on GitHub', run: () => app.openUrl(pr.url) } });
  await gh.refresh({ fresh: true });
  prs.loadBranches(true);
  return pr;
}
