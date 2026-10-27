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
/** Most of a request's URL taken by branch names. */
const PER_REQUEST = 6000;
/** A row shown again after this long asks again. */
const STALE = 30_000;

class Prs {
  /** Local branches' pull requests, by branch name, once their rows have shown. */
  byBranch = $state.raw<Record<string, PullRequest>>({});
  /** Remote-tracking branches', by `remote/branch`. */
  byRemote = $state.raw<Record<string, PullRequest>>({});
  /** The stack the current branch's pull request is in; null when there's none. */
  stack = $state.raw<PrStack | null>(null);
  /** The "Create pull request" dialog is open. */
  creating = $state(false);

  /** Rows shown now (by how many), when each name was last asked about, and names waiting to be. */
  private shown: Record<Kind, Map<string, number>> = { local: new Map(), remote: new Map() };
  private askedAt: Record<Kind, Map<string, number>> = { local: new Map(), remote: new Map() };
  private pending: Record<Kind, Set<string>> = { local: new Set(), remote: new Set() };
  /** One request in flight per kind, so answers land in the order they were asked. */
  private busy: Record<Kind, boolean> = { local: false, remote: false };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstWant = 0;
  private stackFor: string | null = null;
  private gen = 0;

  /**
   * A branch's row is shown (a local branch, or a remote one as `remote/branch`): look up its pull
   * request, with the other rows shown meanwhile. Returns the cleanup, for an attachment.
   */
  want(kind: Kind, name: string) {
    const shown = this.shown[kind];
    shown.set(name, (shown.get(name) ?? 0) + 1);
    if (Date.now() - (this.askedAt[kind].get(name) ?? 0) > STALE) {
      this.pending[kind].add(name);
      this.schedule();
    }
    return () => {
      const n = (shown.get(name) ?? 1) - 1;
      if (n) shown.set(name, n);
      else shown.delete(name);
    };
  }

  /** Asked once rows stop coming in (scrolling), or at most 300ms after the first. */
  private schedule() {
    if (!this.timer) this.firstWant = Date.now();
    clearTimeout(this.timer ?? undefined);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush(false);
    }, Math.max(0, Math.min(120, this.firstWant + 300 - Date.now())));
  }

  /** Ask again about the rows shown now. */
  async loadBranches(fresh = false) {
    for (const kind of ['local', 'remote'] as const) for (const n of this.shown[kind].keys()) this.pending[kind].add(n);
    await this.flush(fresh);
  }

  private async flush(fresh: boolean) {
    if (!gh.ready) return void ([this.byBranch, this.byRemote] = [{}, {}]);
    await Promise.all((['local', 'remote'] as const).map((kind) => this.ask(kind, fresh)));
  }

  private async ask(kind: Kind, fresh: boolean) {
    if (this.busy[kind]) return;
    this.busy[kind] = true;
    try {
      // Rows scrolled past before their turn came aren't asked about.
      for (let names = this.take(kind); names.length; names = this.take(kind)) {
        const r = await ghRequest<Record<string, PullRequest>>(kind === 'local' ? 'prBranches' : 'prRemoteBranches', {
          names: names.join('\n'),
          fresh: fresh ? 1 : null,
        }).catch(() => null);
        if (!r) continue;
        const next = { ...(kind === 'local' ? this.byBranch : this.byRemote) };
        for (const n of names) {
          if (r[n]) next[n] = r[n];
          else delete next[n];
        }
        if (kind === 'local') this.byBranch = next;
        else this.byRemote = next;
      }
    } finally {
      this.busy[kind] = false;
    }
  }

  /** The next names to ask about: pending ones still shown, as many as fit in a request. */
  private take(kind: Kind): string[] {
    const out: string[] = [];
    let length = 0;
    for (const n of this.pending[kind]) {
      const size = encodeURIComponent(n).length + 3;
      if (length && length + size > PER_REQUEST) break;
      this.pending[kind].delete(n);
      if (!this.shown[kind].has(n)) continue;
      out.push(n);
      length += size;
      this.askedAt[kind].set(n, Date.now());
    }
    return out;
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

  /** After `gh.refresh()`: the stack, and the badges of the rows the branch list shows. */
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
