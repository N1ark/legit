import { copyText, toast } from 'purr';
import { type SquashFields, squashFields } from './squash.ts';
import type { CommitInfo, DiffSummary, FileContents, HunkData, OpResult, Person, RepoState, SyncResult } from '../../shared/types.ts';

export async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(
    path,
    body === undefined
      ? {}
      : { method: 'POST', headers: { 'content-type': 'application/json', 'x-legit': '1' }, body: JSON.stringify(body) },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

class App {
  repo = $state<RepoState | null>(null);
  /** Selected commit SHAs, in click order. */
  selected = $state<string[]>([]);
  anchor: string | null = null;
  busy = $state(false);

  private diffs = new Map<string, Promise<DiffSummary>>();
  private contents = new Map<string, Promise<HunkData[]>>();
  private gen = 0;

  commits = $derived(this.repo?.commits ?? []);
  editable = $derived(this.commits.filter((c) => c.editable));
  bySha = $derived(new Map(this.commits.map((c) => [c.sha, c])));
  /** Selected commits, newest first. */
  selection = $derived(this.commits.filter((c) => this.selected.includes(c.sha)));
  people = $derived.by(() => {
    const seen = new Map<string, { name: string; email: string }>();
    for (const c of this.commits) {
      for (const p of [c.author, ...c.coauthors]) {
        const key = p.email.toLowerCase();
        if (!seen.has(key)) seen.set(key, { name: p.name, email: p.email });
      }
    }
    return [...seen.values()];
  });

  async refresh() {
    const gen = ++this.gen;
    try {
      const repo = await request<RepoState>('/api/state');
      if (gen === this.gen) this.setRepo(repo);
    } catch (e) {
      toast.error(e);
    }
  }

  private setRepo(repo: RepoState, focus?: string[]) {
    // A merge (or rebase...) that just stopped: show its conflicts.
    const conflictStarted = !!repo.conflict && !this.repo?.conflict;
    this.repo = repo;
    this.loadAvatars(this.people.map((p) => p.email));
    const shas = new Set(repo.commits.map((c) => c.sha));
    if (this.hasWork) shas.add(WORK);
    let sel = (conflictStarted ? [WORK] : (focus ?? this.selected)).filter((s) => shas.has(s));
    if (!sel.length && repo.commits.length) sel = [repo.commits[0].sha];
    this.selected = sel;
    if (this.anchor && !shas.has(this.anchor)) this.anchor = sel[0] ?? null;
  }

  /** A commit's file list (no content). Cached: commits are immutable. */
  diff(sha: string): Promise<DiffSummary> {
    let d = this.diffs.get(sha);
    if (!d) {
      d = request<DiffSummary>(`/api/diff/${sha}`);
      d.catch(() => this.diffs.delete(sha));
      if (this.diffs.size > 200) this.diffs.delete(this.diffs.keys().next().value!);
      this.diffs.set(sha, d);
    }
    return d;
  }

  /** Contents of some of a commit's files; misses are fetched in one request. */
  async fileContents(sha: string, files: number[]): Promise<Record<number, HunkData[]>> {
    const key = (i: number) => `${sha}:${i}`;
    const missing = files.filter((i) => !this.contents.has(key(i)));
    if (missing.length) {
      const batch = request<FileContents>(`/api/diff/${sha}/files?i=${missing.join(',')}`);
      for (const i of missing) {
        const p = batch.then((r) => r[i] ?? []);
        p.catch(() => this.contents.delete(key(i)));
        this.contents.set(key(i), p);
      }
      while (this.contents.size > 4000) this.contents.delete(this.contents.keys().next().value!);
    }
    const out: Record<number, HunkData[]> = {};
    for (const i of files) out[i] = await this.contents.get(key(i))!;
    return out;
  }

  /** Warm the caches for a commit: its file list and the files on its first screen. */
  prefetch(sha: string) {
    this.diff(sha)
      .then((d) => {
        const first: number[] = [];
        let y = 0;
        for (let i = 0; i < d.files.length && y < 2000; i++) {
          if (d.files[i].rows) first.push(i);
          y += 40 + d.files[i].rows * 19;
        }
        if (first.length) return this.fileContents(sha, first);
      })
      .catch(() => {});
  }

  /** Run a history-rewriting operation. Returns true on success. */
  async op(name: string, body: unknown = {}, optimistic?: () => void): Promise<boolean> {
    if (this.busy) return false;
    const gen = ++this.gen;
    const before = this.repo;
    this.busy = true;
    optimistic?.();
    try {
      const r = await request<OpResult>(`/api/${name}`, body);
      this.gen = Math.max(this.gen, gen);
      this.setRepo(r.state, r.focus.length ? r.focus : this.selected.map((s) => r.renamed[s] ?? s));
      return true;
    } catch (e) {
      if (optimistic) this.repo = before;
      toast.error(e);
      this.refresh();
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** Click on a commit: plain, toggle (cmd/ctrl) or range (shift). */
  select(sha: string, mode: 'set' | 'toggle' | 'range' = 'set') {
    const c = this.bySha.get(sha);
    if (!c) return;
    this.stash = null;
    if (mode === 'toggle' && c.editable) {
      this.selected = this.selected.includes(sha)
        ? this.selected.filter((s) => s !== sha)
        : [...this.selected.filter((s) => this.bySha.get(s)?.editable), sha];
      if (!this.selected.length) this.selected = [sha];
    } else if (mode === 'range' && this.anchor && c.editable) {
      const a = this.commits.findIndex((x) => x.sha === this.anchor);
      const b = this.commits.findIndex((x) => x.sha === sha);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      this.selected = this.commits.slice(lo, hi + 1).filter((x) => x.editable).map((x) => x.sha);
      return;
    } else {
      this.selected = [sha];
      const i = this.commits.findIndex((x) => x.sha === sha);
      for (const n of [this.commits[i - 1], this.commits[i + 1]]) if (n) this.prefetch(n.sha);
    }
    this.anchor = sha;
  }

  /** Move selection up (-1) or down (+1). */
  step(dir: number, extend = false) {
    this.stash = null;
    const cur = this.anchor ?? this.selected[0];
    // "Uncommitted changes" sits above the newest commit.
    if (cur === WORK) {
      if (dir > 0 && !extend && this.commits[0]) this.select(this.commits[0].sha);
      return;
    }
    const i = this.commits.findIndex((c) => c.sha === cur);
    if (i === 0 && dir < 0 && !extend && this.hasWork) {
      this.selectWork();
      document.querySelector('[data-sha="work"]')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    const next = this.commits[Math.max(0, Math.min(this.commits.length - 1, i + dir))];
    if (!next) return;
    if (extend) {
      if (!next.editable) return;
      const keep = this.selected.includes(next.sha);
      this.selected = keep ? this.selected.filter((s) => s !== cur) : [...this.selected, next.sha];
      this.anchor = next.sha;
    } else this.select(next.sha);
    document.querySelector(`[data-sha="${next.sha}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  /** Move the selected commits by `dir` positions (negative = newer). */
  move(dir: number) {
    const list = this.editable.map((c) => c.sha);
    const picked = list.filter((s) => this.selected.includes(s));
    if (!picked.length) return;
    const rest = list.filter((s) => !picked.includes(s));
    const first = list.indexOf(picked[0]);
    const at = Math.max(0, Math.min(rest.length, first + dir));
    this.reorder([...rest.slice(0, at), ...picked, ...rest.slice(at)]);
  }

  /** Apply a new order of the editable commits (newest first), optimistically. */
  reorder(order: string[]) {
    const cur = this.editable.map((c) => c.sha);
    if (order.every((s, i) => s === cur[i])) return;
    this.op('reorder', { order }, () => {
      if (!this.repo) return;
      const by = this.bySha;
      const rest = this.repo.commits.filter((c) => !c.editable);
      this.repo = { ...this.repo, commits: [...order.map((s) => by.get(s)!), ...rest] };
    });
  }

  /** Open a file of the working tree (path relative to the repo root) in Zed. */
  async openInZed(path: string, line?: number) {
    try {
      await request('/api/open', { path, line });
    } catch (e) {
      toast.error(e);
    }
  }

  async copy(text: string, what = text) {
    if (await copyText(text)) toast(`Copied ${what}`);
    else toast.error("Couldn't access the clipboard");
  }

  /** Message the squash panel is showing, if the user edited it (keyed by the selected SHAs). */
  squashDraft = $state<({ key: string } & SquashFields) | null>(null);

  /** Squash commits (any order) into the oldest, with the edited draft or the combined message. */
  squash(commits: CommitInfo[]) {
    const newestFirst = this.commits.filter((c) => commits.some((x) => x.sha === c.sha));
    const key = newestFirst.map((c) => c.sha).join(' ');
    const { subject, body, coauthors } = this.squashDraft?.key === key ? this.squashDraft : squashFields(newestFirst);
    return this.op('squash', { shas: newestFirst.map((c) => c.sha), subject, body, coauthors });
  }

  /** Anything staged, unstaged or untracked, or a merge (rebase...) in progress. */
  hasWork = $derived(
    !!this.repo && (this.repo.work.staged + this.repo.work.unstaged + this.repo.work.untracked > 0 || !!this.repo.conflict),
  );
  /** Avatar URL by lowercased email; null when there's none (initials are shown instead). */
  avatars = $state<Record<string, string | null>>({});
  private avatarsPending = new Set<string>();

  loadAvatars(emails: string[]) {
    const need = [...new Set(emails.map((e) => e.trim().toLowerCase()))].filter(
      (e) => e && !(e in this.avatars) && !this.avatarsPending.has(e),
    );
    if (!need.length) return;
    for (const e of need) this.avatarsPending.add(e);
    request<Record<string, string | null>>('/api/avatars', { emails: need })
      .then((r) => (this.avatars = { ...this.avatars, ...r }))
      .catch(() => {})
      .finally(() => need.forEach((e) => this.avatarsPending.delete(e)));
  }

  /** Bumped whenever files or the index change, so the changes view reloads. */
  workTick = $state(0);

  /** Message to put in the commit form (e.g. of a commit that was just undone). */
  workDraft = $state<{ subject: string; body: string; coauthors: Person[] } | null>(null);

  /** Undo the last commit, keeping its changes staged and its message in the commit form. */
  async uncommit() {
    const c = this.commits.find((x) => x.sha === this.repo?.head);
    if (!c || !(await this.op('uncommit'))) return;
    this.workDraft = { subject: c.subject, body: c.body, coauthors: c.coauthors };
    this.selectWork();
    toast(`Undid "${c.subject}"; its changes are staged.`);
  }

  selectWork() {
    this.stash = null;
    this.selected = [WORK];
    this.anchor = WORK;
  }

  workChanged() {
    this.workTick++;
    this.refresh();
  }

  /** The stash shown in place of the selected commit, if any (from the stashes panel). */
  stash = $state<ShownStash | null>(null);

  undo = () => this.op('undo');
  redo = () => this.op('redo');

  /**
   * Run a sync operation (pull, merge, rebase, resolve, continue, abort) and toast what
   * happened. Returns the result, or null if it failed.
   */
  async sync(name: string, body: unknown = {}): Promise<SyncResult | null> {
    if (this.busy) return null;
    const gen = ++this.gen;
    this.busy = true;
    try {
      const r = await request<SyncResult>(`/api/${name}`, body);
      this.gen = Math.max(this.gen, gen);
      this.setRepo(r.state, r.focus.length ? r.focus : this.selected.map((s) => r.renamed[s] ?? s));
      if (r.message) toast(r.message, { timeout: r.message.length > 80 ? 10_000 : undefined });
      return r;
    } catch (e) {
      toast.error(e);
      this.refresh();
      return null;
    } finally {
      this.busy = false;
    }
  }

  fetching = $state(false);
  /** Why the last background fetch failed, if it did. */
  fetchError = $state<string | null>(null);
  private fetchTried = 0;

  /**
   * Fetch the remote. It doesn't block other operations (a fetch only updates remote-tracking
   * refs). In the background, a failure is only noted, not toasted.
   */
  async fetchRemote(background = false) {
    if (this.fetching) return;
    this.fetching = true;
    this.fetchTried = Date.now();
    try {
      await request<SyncResult>('/api/fetch', {});
      this.fetchError = null;
    } catch (e) {
      this.fetchError = e instanceof Error ? e.message : String(e);
      if (!background) toast.error(e);
    } finally {
      this.fetching = false;
      // The returned state may be older than one an operation applied meanwhile.
      await this.refresh();
    }
  }

  /** Fetch in the background when the last fetch (or attempt) is older than `ms`. */
  fetchIfOlder(ms: number) {
    const last = Math.max(this.repo?.fetchedAt ?? 0, this.fetchTried);
    if (this.repo?.push && !this.fetching && Date.now() - last > ms) this.fetchRemote(true);
  }
}

/** A stash being looked at: one in the stash list, or a dropped one legit kept. */
export interface ShownStash {
  sha: string;
  title: string;
  message: string;
  time: number;
  /** Dropped or popped (only under refs/legit/stashes): it can only be applied. */
  dropped: boolean;
}

/** Selection key of the "Uncommitted changes" entry. */
export const WORK = 'work';

export const app = new App();

export function shortSha(c: CommitInfo | string) {
  return (typeof c === 'string' ? c : c.sha).slice(0, 7);
}

/** A person's avatar at `size` px (doubled for retina), or null for initials. */
export function avatarUrl(email: string, size: number): string | null {
  const url = app.avatars[email.trim().toLowerCase()];
  if (!url) return null;
  return url.includes('avatars.githubusercontent.com') ? `${url}&s=${size * 2}` : `${url}?size=${size * 2}`;
}
