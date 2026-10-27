// Pull requests around the current branch: every branch's (badges in the branch list), the
// stack it's in (the header's pull request chip), restacking it, and opening a pull request.

import { toast } from 'purr';
import { app } from './app.svelte.ts';
import { rebuild, switchOp } from './branches.svelte.ts';
import { gh, ghPost, ghRequest } from './github.svelte.ts';
import { openWorktree } from './worktrees.svelte.ts';
import type { CreatePrRequest, PrStack, RestackPlan, StackEntry } from '../../shared/gh-stack.ts';
import type { PullRequest } from '../../shared/github.ts';

type Kind = 'local' | 'remote';
/** Branch names sent in one request. */
const PER_REQUEST = 100;

class Prs {
  /** Local branches' pull requests, by branch name, once their rows have shown. */
  byBranch = $state.raw<Record<string, PullRequest>>({});
  /** Remote-tracking branches', by `remote/branch`. */
  byRemote = $state.raw<Record<string, PullRequest>>({});
  /** The stack the current branch's pull request is in; null when there's none. */
  stack = $state.raw<PrStack | null>(null);
  /** The "Create pull request" dialog is open. */
  creating = $state(false);

  /** Branches whose rows have shown, asked about again on each refresh; those not asked about yet. */
  private asked: Record<Kind, Set<string>> = { local: new Set(), remote: new Set() };
  private pending: Record<Kind, Set<string>> = { local: new Set(), remote: new Set() };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stackFor: string | null = null;
  private gen = 0;

  /** Look up a branch's pull request once its row shows (a local branch, or a remote one as `remote/branch`); rows that show together are asked about together. */
  want(kind: Kind, name: string) {
    if (this.asked[kind].has(name)) return;
    this.asked[kind].add(name);
    this.pending[kind].add(name);
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.ask(this.pending, false);
    }, 30);
  }

  /** Ask again about every branch whose row has shown. */
  async loadBranches(fresh = false) {
    await this.ask(this.asked, fresh);
  }

  private async ask(which: Record<Kind, Set<string>>, fresh: boolean) {
    const names = { local: [...which.local], remote: [...which.remote] };
    if (which === this.pending) [this.pending.local, this.pending.remote] = [new Set(), new Set()];
    if (!gh.ready) return void ([this.byBranch, this.byRemote] = [{}, {}]);
    const get = async (kind: Kind, list: string[]) => {
      for (let i = 0; i < list.length; i += PER_REQUEST) {
        const chunk = list.slice(i, i + PER_REQUEST);
        const r = await ghRequest<Record<string, PullRequest>>(kind === 'local' ? 'prBranches' : 'prRemoteBranches', {
          names: chunk.join('\n'),
          fresh: fresh ? 1 : null,
        }).catch(() => null);
        if (!r) continue;
        const next = { ...(kind === 'local' ? this.byBranch : this.byRemote) };
        for (const n of chunk) delete next[n];
        Object.assign(next, r);
        if (kind === 'local') this.byBranch = next;
        else this.byRemote = next;
      }
    };
    await Promise.all([get('local', names.local), get('remote', names.remote)]);
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

  /** After `gh.refresh()`: the stack, and the badges the branch list has shown. */
  refreshed() {
    this.loadStack();
    this.loadBranches();
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
  toast.error(`${e.pr.head} isn't here: fetch first`);
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
    toast.error("This branch doesn't push anywhere: add a GitHub remote first");
    return null;
  }
  if (push.ahead && push.behind) {
    toast.error(`${push.remote}/${push.branch} has commits this branch doesn't: pull or force push first`);
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
