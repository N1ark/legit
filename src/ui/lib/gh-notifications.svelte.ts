// The signed-in user's GitHub notifications: polled as often as GitHub allows while the window
// has focus, marked read when opened. A pull request of this repo opens in legit's own view.

import { toast } from 'purr';
import { app } from './app.svelte.ts';
import { checks } from './gh-checks.svelte.ts';
import { gh, ghPost, ghRequest } from './github.svelte.ts';
import type { GhNotification, GhNotifications } from '../../shared/gh-notifications.ts';

/** The branch a CI notification is about: GitHub titles them "CI workflow run failed for main branch". */
export const ciBranch = (title: string) => /\bfor (\S+) branch$/.exec(title)?.[1] ?? null;

class Notifications {
  /** Newest first; null until loaded. */
  items = $state.raw<GhNotification[] | null>(null);
  error = $state<string | null>(null);
  unread = $derived(this.items?.filter((n) => n.unread).length ?? 0);

  private poll = 60;
  private lastAt = 0;
  private loading: Promise<void> | null = null;
  private gen = 0;

  load(fresh = false): Promise<void> {
    if (this.loading && !fresh) return this.loading;
    this.lastAt = Date.now();
    const run = this.fetch(fresh).finally(() => {
      if (this.loading === run) this.loading = null;
    });
    this.loading = run;
    return run;
  }

  private async fetch(fresh: boolean) {
    const gen = ++this.gen;
    try {
      const r = await ghRequest<GhNotifications>('notifs', { fresh: fresh ? 1 : null });
      if (gen !== this.gen) return;
      this.items = r.items;
      this.poll = Math.max(r.poll, 30);
      this.error = null;
    } catch (e) {
      if (gen === this.gen) this.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Poll while signed in and focused; returns the cleanup, for onMount. */
  start(): () => void {
    const tick = () => {
      if (gh.ready && document.hasFocus() && Date.now() - this.lastAt >= this.poll * 1000) this.load();
    };
    const timer = setInterval(tick, 15_000);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }

  /** A pull request of this repo, or a CI run on the current branch, which legit can show itself. */
  here(n: GhNotification): boolean {
    if (n.repo.toLowerCase() !== gh.status?.repo?.toLowerCase()) return false;
    if (n.type === 'PullRequest') return n.number !== null;
    return n.type === 'CheckSuite' && !!checks.showHead && ciBranch(n.title) === app.repo?.branch;
  }

  /** Show it (in legit when it can, else on GitHub) and mark it read. */
  open(n: GhNotification) {
    if (!this.here(n)) app.openUrl(n.url);
    else if (n.type === 'CheckSuite') checks.showHead?.();
    else gh.showPr(n.number!);
    if (n.unread) this.change('notifsRead', n, (x) => ({ ...x, unread: false }));
  }

  markRead(n: GhNotification) {
    this.change('notifsRead', n, (x) => ({ ...x, unread: false }));
  }

  done(n: GhNotification) {
    this.change('notifsDone', n, () => null);
  }

  unsubscribe(n: GhNotification) {
    this.change('notifsUnsubscribe', n, () => null);
  }

  /** Mark everything shown as read, in `repo` only when given. */
  async readAll(repo: string | null) {
    const shown = this.items ?? [];
    const before = Math.max(0, ...shown.map((n) => n.updatedAt));
    const hit = (n: GhNotification) => !repo || n.repo.toLowerCase() === repo.toLowerCase();
    this.items = shown.map((n) => (hit(n) ? { ...n, unread: false } : n));
    try {
      await ghPost('notifsReadAll', { before, repo });
    } catch (e) {
      toast.error(e);
      this.load(true);
    }
  }

  /** Change `n` here at once (null removes it), then on GitHub; put it back if that fails. */
  private async change(route: string, n: GhNotification, to: (n: GhNotification) => GhNotification | null) {
    this.items = (this.items ?? []).flatMap((x) => (x.id === n.id ? (to(x) ?? []) : [x]));
    try {
      await ghPost(route, { id: n.id });
    } catch (e) {
      toast.error(e);
      this.load(true);
    }
  }
}

export const notifications = new Notifications();
