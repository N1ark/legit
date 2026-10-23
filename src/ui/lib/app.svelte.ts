import { IS_TAURI, copyText, persisted, toast } from 'purr';
import { expandable } from '../../shared/context.ts';
import { highlight } from './highlighter.ts';
import { type Expansion, buildRows, noExpansion, rowHunks } from './rows.ts';
import { switchRefusal } from './busy.ts';
import { recall } from './desktop.ts';
import { type SquashFields, squashFields } from './squash.ts';
import type { GhView } from './github.svelte.ts';
import type {
  CommitInfo, DiffSummary, DisplaySettings, EditLineRequest, EditRequest, SplitRequest, FileContents, FileLines, HunkData, MergedCommits, OlderCommits, OpResult, Person, Progress, RemoveChangesRequest, RepoState,
  Stashes, SyncResult,
} from '../../shared/types.ts';

/** GETs index.html sent before the bundle loaded, by path. */
const early: Record<string, Promise<Response> | undefined> = (window as any).__legitEarly ?? {};

export async function request<T>(path: string, body?: unknown): Promise<T> {
  const sent = body === undefined ? early[path] : undefined;
  if (sent) delete early[path];
  const res = await (sent ??
    fetch(
      path,
      body === undefined
        ? {}
        : { method: 'POST', headers: { 'content-type': 'application/json', 'x-legit': '1' }, body: JSON.stringify(body) },
    ));
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { code: data.code as string | undefined });
  return data;
}

class App {
  /** Replaced, never changed in place: a refresh brings a whole new one. */
  repo = $state.raw<RepoState | null>(null);
  /** Selected commit SHAs, in click order. */
  selected = $state<string[]>([]);
  anchor: string | null = null;
  busy = $state(false);
  /** The operation running while `busy` (its API name). */
  running: string | null = null;

  private diffs = new Map<string, Promise<DiffSummary>>();
  private contents = new Map<string, Promise<HunkData[]>>();
  private olds = new Map<string, Promise<FileLines>>();
  private gen = 0;

  /** History loaded by scrolling past the state's commits; it continues from `from`, the oldest of those. */
  private older = $state.raw<({ from: string } & OlderCommits) | null>(null);
  loadingOlder = $state(false);
  /** Merges whose commits are listed under them, by SHA (null while loading). */
  expanded = $state.raw<Record<string, MergedCommits | null>>({});

  /** Everything the list shows, newest first: the state's commits, older ones, and expanded merges' commits. */
  commits = $derived.by(() => {
    const base = this.repo?.commits ?? NONE;
    const older = this.older && this.older.from === base.at(-1)?.sha ? this.older.commits : NONE;
    // The same list when a refresh changed nothing in it, so what derives from it stays as it is.
    const last = this.listed;
    if (last && last.base === base && last.older === older && last.expanded === this.expanded) return last.out;
    const out: CommitInfo[] = [];
    for (const c of [...base, ...older]) {
      out.push(c);
      if (c.merge) out.push(...(this.expanded[c.sha]?.commits ?? []));
    }
    this.listed = { base, older, expanded: this.expanded, out };
    return out;
  });
  private listed: { base: CommitInfo[]; older: CommitInfo[]; expanded: unknown; out: CommitInfo[] } | null = null;
  /** No older history left to load. */
  atEnd = $derived(!!this.older && this.older.from === this.repo?.commits.at(-1)?.sha && !this.older.more);
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

  /** First load: the state, and the view this window left the repo in, if it's been here before. */
  async start() {
    this.loadDisplay();
    try {
      await this.load();
    } finally {
      this.started = true;
    }
  }

  /** Set once `start` is done. */
  started = $state(false);

  private async load() {
    const kept = await recall<View>();
    if (kept) {
      this.kept = kept.views;
      this.selected = kept.selected;
      this.anchor = kept.anchor;
    }
    await this.refresh();
    if (!kept || !this.repo) return;
    // Commits listed under a merge only exist once it's expanded again.
    const merges = kept.expanded.filter((s) => this.bySha.get(s)?.merge);
    await Promise.all(merges.map((s) => this.toggleMerge(s, true)));
    const sel = kept.selected.filter((s) => this.bySha.has(s));
    if (merges.length && sel.length) [this.selected, this.anchor] = [sel, kept.anchor];
    if (kept.stash) {
      const s = await request<Stashes>('/api/stashes').catch(() => null);
      if (s && [...s.entries, ...s.dropped].some((x) => x.sha === kept.stash?.sha)) this.stash = kept.stash;
    }
  }

  /** What views asked to keep (see `keep`) and what they left (see `restore`). */
  private keepers = new Map<string, () => unknown>();
  private kept: Record<string, unknown> = {};

  /** Have `get()` kept under `key` when the window switches repo. Returns the cleanup, for an $effect. */
  keep(key: string, get: () => unknown) {
    this.keepers.set(key, get);
    return () => {
      if (this.keepers.get(key) === get) this.keepers.delete(key);
    };
  }

  /** What was kept under `key`, once (only if `fits` it). */
  restore<T>(key: string, fits: (v: T) => boolean = () => true): T | undefined {
    const v = this.kept[key] as T | undefined;
    if (v === undefined || v === null || !fits(v)) return undefined;
    delete this.kept[key];
    return v;
  }

  /** The view to come back to (see lib/desktop.ts). */
  snapshot(): View {
    return {
      selected: this.selected,
      anchor: this.anchor,
      stash: this.stash,
      expanded: Object.keys(this.expanded),
      views: Object.fromEntries([...this.keepers].map(([k, get]) => [k, get()])),
    };
  }

  async refresh() {
    const gen = ++this.gen;
    try {
      const res = await fetch('/api/state');
      const text = await res.text();
      if (!res.ok) throw new Error((JSON.parse(text) as { error?: string }).error ?? res.statusText);
      // Window focus and file events refresh far more often than anything changes.
      if (gen !== this.gen || (text === this.fetched?.text && this.repo === this.fetched.repo)) return;
      this.setRepo(JSON.parse(text));
      this.fetched = { text, repo: this.repo! };
    } catch (e) {
      toast.error(e);
    }
  }

  /** The state `refresh` last applied, as the server sent it. */
  private fetched: { text: string; repo: RepoState } | null = null;

  private setRepo(repo: RepoState, focus?: string[]) {
    const first = !this.repo;
    // A merge (or rebase...) that just stopped: show its conflicts.
    const conflictStarted = !!repo.conflict && !this.repo?.conflict;
    repo.commits = keepCommits(this.repo?.commits, repo.commits);
    this.repo = repo;
    this.loadAvatars(this.people.map((p) => p.email));
    const shas = new Set(this.commits.map((c) => c.sha));
    if (this.hasWork) shas.add(WORK);
    let sel = (conflictStarted ? [WORK] : (focus ?? this.selected)).filter((s) => shas.has(s));
    if (!sel.length && repo.commits.length) sel = [repo.commits[0].sha];
    this.selected = sel;
    if (this.anchor && !shas.has(this.anchor)) this.anchor = sel[0] ?? null;
    // The first commit shown: its diff is asked for now, not once the list and the view have rendered.
    if (first && sel.length === 1 && sel[0] !== WORK) this.prefetch(sel[0]);
  }

  /** Load the next page of older history (the list calls this when scrolled near its end). */
  async loadOlder() {
    const from = this.repo?.commits.at(-1)?.sha;
    if (!from || this.loadingOlder || this.atEnd) return;
    const cur = this.older?.from === from ? this.older : null;
    this.loadingOlder = true;
    try {
      const r = await request<OlderCommits>(`/api/older/${cur?.commits.at(-1)?.sha ?? from}`);
      // History changed meanwhile: the next call starts over from the new oldest commit.
      if (this.repo?.commits.at(-1)?.sha !== from || this.older !== cur) return;
      this.older = { from, commits: [...(cur?.commits ?? []), ...r.commits], more: r.more };
      this.loadAvatars(r.commits.map((c) => c.author.email));
    } catch (e) {
      toast.error(e);
    } finally {
      this.loadingOlder = false;
    }
  }

  /** List a merge's commits under it, or stop listing them. */
  async toggleMerge(sha: string, open = !(sha in this.expanded)) {
    if (open === sha in this.expanded) return;
    if (!open) {
      const side = new Set(this.expanded[sha]?.commits.map((c) => c.sha));
      const { [sha]: _, ...rest } = this.expanded;
      this.expanded = rest;
      if (this.selected.some((s) => side.has(s))) this.select(sha);
      return;
    }
    this.expanded = { ...this.expanded, [sha]: null };
    try {
      const r = await request<MergedCommits>(`/api/merged/${sha}`);
      if (sha in this.expanded) this.expanded = { ...this.expanded, [sha]: r };
      this.loadAvatars(r.commits.map((c) => c.author.email));
    } catch (e) {
      const { [sha]: _, ...rest } = this.expanded;
      this.expanded = rest;
      toast.error(e);
    }
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

  /** File i's contents are loaded or on their way. */
  hasContents(d: DiffSummary, i: number): boolean {
    return this.contents.has(fileKey(d, i));
  }

  /** Contents of some of a diff's files; misses are fetched in one request. */
  async fileContents(d: DiffSummary, files: number[]): Promise<Record<number, HunkData[]>> {
    const key = (i: number) => fileKey(d, i);
    const missing = files.filter((i) => !this.contents.has(key(i)));
    if (missing.length) {
      const batch = request<FileContents>(`/api/diff/${d.sha}/files?i=${missing.join(',')}`);
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

  /** File i's old version, to show the unchanged lines between its hunks. */
  oldLines(sha: string, i: number): Promise<FileLines> {
    const key = `${sha}:${i}`;
    let p = this.olds.get(key);
    if (!p) {
      p = request<FileLines>(`/api/diff/${sha}/old?i=${i}`);
      p.catch(() => this.olds.delete(key));
      if (this.olds.size > 50) this.olds.delete(this.olds.keys().next().value!);
      this.olds.set(key, p);
    }
    return p;
  }

  /** The commits prefetched last, whose highlighting is still worth working out. */
  private prefetched: string[] = [];

  /**
   * Warm the caches for a commit: its file list, and the files on its first screen (generated ones
   * start collapsed) and their highlighting, which the worker does when the diff shown leaves it free.
   */
  prefetch(sha: string): Promise<unknown> {
    this.prefetched = [sha, ...this.prefetched.filter((s) => s !== sha)].slice(0, 4);
    return this.diff(sha)
      .then(async (d) => {
        const first: number[] = [];
        let y = 0;
        for (let i = 0; i < d.files.length && y < 2000; i++) {
          const f = d.files[i];
          if (f.rows && !f.generated) first.push(i);
          y += f.generated ? 44 : 40 + f.rows * 19;
        }
        if (!first.length) return;
        const res = await this.fileContents(d, first);
        for (const i of first) {
          const f = d.files[i];
          if (f.rows > PREHIGHLIGHT_ROWS) continue;
          const rows = buildRows(res[i], expandable(f), noExpansion(), hideWhitespace.value);
          const wanted = () => this.prefetched.includes(sha);
          highlight(highlightKey(d, i, f.syntax, undefined, rows.ws), f.path, rowHunks(rows), () => Infinity, wanted, f.syntax);
        }
      })
      .catch(() => {});
  }

  /**
   * Run a history-rewriting operation. Returns true on success. `prepare` runs once it has
   * succeeded, before the UI shows the result (to load what the next view needs, say).
   */
  async op(
    name: string,
    body: unknown = {},
    optimistic?: () => void,
    prepare?: (r: OpResult) => Promise<unknown>,
    /** Shows the error instead of the default toast; returns false to leave it to the toast. */
    fail?: (e: Error & { code?: string }) => boolean,
  ): Promise<boolean> {
    if (this.busy) return false;
    const gen = ++this.gen;
    const before = this.repo;
    this.busy = true;
    this.running = name;
    optimistic?.();
    try {
      const r = await request<OpResult>(`/api/${name}`, body);
      await prepare?.(r).catch(() => {});
      this.gen = Math.max(this.gen, gen);
      this.setRepo(r.state, r.focus.length ? r.focus : this.selected.map((s) => r.renamed[s] ?? s));
      return true;
    } catch (e) {
      if (optimistic) this.repo = before;
      if (!(e instanceof Error && fail?.(e))) toast.error(e);
      this.refresh();
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** Where to put the diff of a commit that was just rewritten from its own view (see `rewriteInPlace`). */
  diffPosition: { sha: string; at: DiffPosition } | null = null;

  /**
   * Run an operation that rewrites commit `sha` from its own view (edit its message or diff,
   * split it). The rewritten commit's view opens where this one was (`at`), with its file list and
   * the files that were in view already loaded, so it doesn't jump or flash.
   */
  rewriteInPlace(
    name: 'edit' | 'split' | 'removeChanges' | 'editLine',
    body: EditRequest | SplitRequest | RemoveChangesRequest | EditLineRequest,
    at: DiffPosition | null,
  ) {
    return this.op(name, body, undefined, async (r) => {
      const sha = r.renamed[body.sha];
      if (sha && !r.state.conflict) await this.placeDiff(sha, at);
    });
  }

  /** Have the next view of `sha`'s diff (or of the commit being edited, `EDITING`) open at `at`. */
  private async placeDiff(sha: string, at: DiffPosition | null) {
    if (!at) return;
    this.diffPosition = { sha, at };
    if (sha === EDITING) return;
    const d = await this.diff(sha);
    const want = d.files.flatMap((f, i) => (f.rows && at.shown.includes(f.path) ? [i] : []));
    if (want.length) await this.fileContents(d, want);
  }

  /** Where the shown commit's diff is scrolled to, when `sha` is the one shown. */
  private shownPosition(sha: string): DiffPosition | null {
    const k = this.keepers.get('commit')?.() as { sha: string; position: DiffPosition | null } | undefined;
    return k?.sha === sha ? k.position : null;
  }

  /** Remove changes from commit `sha`'s diff or edit one of its lines, staying where its view was. */
  async editDiff(
    ...[name, body, at]: ['removeChanges', RemoveChangesRequest, DiffPosition | null] | ['editLine', EditLineRequest, DiffPosition | null]
  ): Promise<boolean> {
    const ok = await this.rewriteInPlace(name, body, at);
    // A later commit conflicted with the change, and the rebase replaying them stopped there.
    if (ok && this.repo?.conflict) {
      toast('A later commit conflicts with that change: resolve and continue, or abort to put everything back.', {
        timeout: 15_000,
      });
    }
    return ok;
  }

  /** The position saved for `sha`'s diff, once. */
  takeDiffPosition(sha: string): DiffPosition | null {
    // Another view may open first (a refresh landing mid-operation): the position waits for its own.
    if (this.diffPosition?.sha !== sha) return null;
    const p = this.diffPosition.at;
    this.diffPosition = null;
    return p;
  }

  /** Check out commit `sha` to edit its files (see EditView), which opens where its diff was. */
  editCommit(sha: string) {
    const at = this.shownPosition(sha);
    return this.sync('editStart', { sha }, () => this.placeDiff(EDITING, at));
  }

  /** Finish or cancel editing a commit; its view then opens where the editing view (`at`) was. */
  endEdit(how: 'editFinish' | 'editCancel', at: DiffPosition | null) {
    return this.sync(how, {}, async (r) => {
      if (!r.state.conflict && r.focus.length === 1) await this.placeDiff(r.focus[0], at);
    });
  }

  /**
   * Click on a commit: plain, toggle (cmd/ctrl) or range (shift). Several commits of the branch's own
   * history can be picked, rewritable or not (the panel then shows their combined changes); a merge's
   * commits listed under it are only picked one at a time.
   */
  select(sha: string, mode: 'set' | 'toggle' | 'range' = 'set') {
    const c = this.bySha.get(sha);
    if (!c) return;
    this.stash = null;
    this.ghView = null;
    const anchor = this.anchor ? this.bySha.get(this.anchor) : undefined;
    if (mode === 'toggle' && !c.side) {
      this.selected = this.selected.includes(sha)
        ? this.selected.filter((s) => s !== sha)
        : [...this.selected.filter((s) => this.bySha.has(s) && !this.bySha.get(s)!.side), sha];
      if (!this.selected.length) this.selected = [sha];
    } else if (mode === 'range' && anchor && !anchor.side && !c.side) {
      const a = this.commits.indexOf(anchor);
      const b = this.commits.indexOf(c);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      this.selected = this.commits.slice(lo, hi + 1).filter((x) => !x.side).map((x) => x.sha);
      return;
    } else {
      this.selected = [sha];
      // Its neighbours once its own first screen is in, so their requests don't hold it up.
      this.prefetch(sha).then(() => {
        if (this.selected.length !== 1 || this.selected[0] !== sha) return;
        const i = this.commits.findIndex((x) => x.sha === sha);
        for (const n of [this.commits[i - 1], this.commits[i + 1]]) if (n) this.prefetch(n.sha);
      });
    }
    this.anchor = sha;
  }

  /** Move selection up (-1) or down (+1). */
  step(dir: number, extend = false) {
    this.stash = null;
    this.ghView = null;
    const cur = this.anchor ?? this.selected[0];
    // "Uncommitted changes" sits above the newest commit.
    if (cur === WORK) {
      if (dir > 0 && !extend && this.commits[0]) this.select(this.commits[0].sha);
      return;
    }
    const i = this.commits.findIndex((c) => c.sha === cur);
    if (i === 0 && dir < 0 && !extend && this.hasWork) {
      this.selectWork();
      this.reveal?.(WORK);
      return;
    }
    let j = Math.max(0, Math.min(this.commits.length - 1, i + dir));
    // Extending the selection skips over an expanded merge's commits.
    if (extend) while (this.commits[j]?.side && this.commits[j + dir]) j += dir;
    const next = this.commits[j];
    if (!next) return;
    if (extend) {
      if (next.side || this.bySha.get(cur)?.side) return;
      const keep = this.selected.includes(next.sha);
      this.selected = keep ? this.selected.filter((s) => s !== cur) : [...this.selected, next.sha];
      this.anchor = next.sha;
    } else this.select(next.sha);
    this.reveal?.(next.sha);
  }

  /** Scrolls the commit list to a row (set by the list, which only mounts the rows in view). */
  reveal: ((sha: string) => void) | null = null;

  /** Move the selected commits by `dir` positions (negative = newer). */
  move(dir: number) {
    const list = this.editable.map((c) => c.sha);
    const picked = list.filter((s) => this.selected.includes(s));
    if (!picked.length || this.selection.some((c) => !c.editable)) return;
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

  /** Open a web link: the desktop app's window can't, so the server asks the OS to. */
  async openUrl(url: string) {
    if (!IS_TAURI) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    try {
      await request('/api/open-url', { url });
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

  /** Drop commits (the files lose their changes too); the toast offers to undo it. */
  async drop(commits: CommitInfo[]) {
    if (!commits.length || !(await this.op('drop', { shas: commits.map((c) => c.sha) }))) return;
    // Stopped at a conflict: the conflict view says so.
    if (this.repo?.conflict) return;
    const what = commits.length === 1 ? `"${commits[0].subject}"` : `${commits.length} commits`;
    const undo = async () => (await this.undo()) && this.select(commits[0].sha);
    toast(`Dropped ${what}.`, { timeout: 8000, action: { label: 'Undo', run: undo } });
  }

  /** Anything staged, unstaged or untracked, or a merge (rebase...) in progress. */
  hasWork = $derived(
    !!this.repo && (this.repo.work.staged + this.repo.work.unstaged + this.repo.work.untracked > 0 || !!this.repo.conflict),
  );
  /** Avatar URL by lowercased email, set once the picture is loaded; null when there's none (initials are shown instead). */
  avatars = $state<Record<string, string | null>>({});
  private avatarsPending = new Set<string>();

  loadAvatars(emails: string[]) {
    const need = [...new Set(emails.map((e) => e.trim().toLowerCase()))].filter(
      (e) => e && !(e in this.avatars) && !this.avatarsPending.has(e),
    );
    if (!need.length) return;
    for (const e of need) this.avatarsPending.add(e);
    request<Record<string, string | null>>('/api/avatars', { emails: need })
      .then((r) =>
        Promise.all(
          Object.entries(r).map(async ([email, url]) => {
            const src = url && (await preloadAvatar(url));
            this.avatars = { ...this.avatars, [email]: src || null };
          }),
        ),
      )
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
    this.ghView = null;
    this.selected = [WORK];
    this.anchor = WORK;
  }

  /** Bumped when the settings change: open diffs take the new ones (see DiffView). */
  settingsTick = $state(0);

  /** How diffs are shown, from the settings. */
  display = $state.raw<DisplaySettings>({ wrap: 'none', wrapColumn: 100, guides: [] });

  async loadDisplay() {
    this.display = await request<DisplaySettings>('/api/display').catch(() => this.display);
  }

  /** Diffs' summaries say which files are collapsed and how they're highlighted: drop them, and tell open diffs. */
  settingsChanged() {
    this.diffs.clear();
    this.settingsTick++;
    this.loadDisplay();
  }

  workChanged() {
    this.workTick++;
    this.refresh();
  }

  /** The stash shown in place of the selected commit, if any (from the stashes panel). */
  stash = $state<ShownStash | null>(null);
  /** A GitHub view shown in place of a commit (see lib/github.svelte.ts); picking a commit leaves it. */
  ghView = $state<GhView | null>(null);

  undo = () => this.op('undo');
  redo = () => this.op('redo');

  /**
   * Run a sync operation (pull, merge, rebase, resolve, continue, abort) and toast what
   * happened. Returns the result, or null if it failed.
   */
  async sync(
    name: string,
    body: unknown = {},
    prepare?: (r: SyncResult) => Promise<unknown>,
    undoable = false,
  ): Promise<SyncResult | null> {
    if (this.busy) return null;
    const gen = ++this.gen;
    this.busy = true;
    this.running = name;
    try {
      const r = await request<SyncResult>(`/api/${name}`, body);
      await prepare?.(r).catch(() => {});
      this.gen = Math.max(this.gen, gen);
      this.setRepo(r.state, r.focus.length ? r.focus : this.selected.map((s) => r.renamed[s] ?? s));
      // The toast's Undo only once it's finished (not stopped on a conflict).
      const undo = undoable && r.state.canUndo && !r.state.conflict ? { label: 'Undo', run: () => this.undo() } : undefined;
      if (r.message) toast(r.message, { timeout: r.message.length > 80 || undo ? 10_000 : undefined, action: undo });
      return r;
    } catch (e) {
      toast.error(e);
      this.refresh();
      return null;
    } finally {
      this.busy = false;
    }
  }

  /** Fetches and pushes under way (pulls' fetches too), by op and remote: how far each has got. */
  progress = $state.raw<Record<string, Progress>>({});

  gotProgress(p: Progress) {
    const key = `${p.op} ${p.remote}`;
    const { [key]: _, ...rest } = this.progress;
    this.progress = p.phase === null ? rest : { ...rest, [key]: p };
  }

  fetching = $state(false);
  /** Why the last background fetch failed, if it did. */
  fetchError = $state<string | null>(null);
  private fetchTried = 0;

  private fetchRun: Promise<boolean> | null = null;

  /**
   * Fetch the remote (or wait for the fetch running), then refresh; true if it worked. It doesn't
   * block other operations (a fetch only updates remote-tracking refs). In the background, a
   * failure is only noted, not toasted.
   */
  fetchRemote(background = false): Promise<boolean> {
    return (this.fetchRun ??= this.fetchNow(background).finally(() => (this.fetchRun = null)));
  }

  private async fetchNow(background: boolean): Promise<boolean> {
    this.fetching = true;
    this.userFetching = !background;
    this.fetchTried = Date.now();
    try {
      await request<SyncResult>('/api/fetch', {});
      this.fetchError = null;
      return true;
    } catch (e) {
      this.fetchError = e instanceof Error ? e.message : String(e);
      if (!background) toast.error(e);
      return false;
    } finally {
      this.fetching = this.userFetching = false;
      // The returned state may be older than one an operation applied meanwhile.
      await this.refresh();
    }
  }

  /** Fetching for "Rebase on main", so its button shows it. */
  fetchingBase = $state(false);
  private userFetching = $state(false);

  /**
   * Why the window can't switch repo now: an operation is running, or a fetch the user asked
   * for (a background fetch is just dropped).
   */
  switchBlocker = $derived(
    this.busy ? switchRefusal(this.running) : this.userFetching || this.fetchingBase ? switchRefusal('fetch') : null,
  );

  /**
   * Rebase onto the default branch (see server/base.ts), fetched first so it's the latest. If the
   * fetch fails, the toast says so and offers to rebase onto what was fetched before.
   */
  async rebaseOnBase() {
    if (this.busy || this.fetchingBase) return;
    const base = this.repo?.base;
    if (!base) return toast("There's no default branch to rebase on, or you're on it.");
    if (this.repo?.push) {
      this.fetchingBase = true;
      const fetched = await this.fetchRemote(true).finally(() => (this.fetchingBase = false));
      if (!fetched) {
        toast(`${base.name} may not be the latest: ${this.fetchError}`, {
          kind: 'error',
          timeout: 15_000,
          action: { label: 'Rebase anyway', run: () => this.rebaseOnBaseNow() },
        });
        return;
      }
    }
    return this.rebaseOnBaseNow();
  }

  private rebaseOnBaseNow() {
    const base = this.repo?.base;
    if (!base) return toast("There's no default branch to rebase on, or you're on it.");
    if (!base.behind) return toast(`${this.repo?.branch} already has everything on ${base.name}.`);
    return this.sync('rebase', { branch: base.name });
  }

  /** Fetch in the background when the last fetch (or attempt) is older than `ms`. */
  fetchIfOlder(ms: number) {
    const last = Math.max(this.repo?.fetchedAt ?? 0, this.fetchTried);
    if (this.repo?.push && !this.fetching && Date.now() - last > ms) this.fetchRemote(true);
  }
}

/** Where a diff view is scrolled to, and which of its files are collapsed or in view (by path). */
export interface DiffPosition {
  /** File at the top of the viewport and how far into it, or null when the diff starts below the top. */
  path: string | null;
  offset: number;
  /** The scroller's scrollTop, for when `path` is null. */
  scrollTop: number;
  collapsed: string[];
  shown: string[];
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

/** What a window remembers of a repo while it shows another. */
interface View {
  selected: string[];
  anchor: string | null;
  stash: ShownStash | null;
  expanded: string[];
  views: Record<string, unknown>;
}

/** Selection key of the "Uncommitted changes" entry. */
export const WORK = 'work';
/** What identifies file i's diff: its token in a working-tree snapshot (unchanged files keep it across snapshots), else its place in the diff. */
export const fileKey = (d: DiffSummary, i: number) => (d.files[i].token ? `${d.files[i].token}:${d.files[i].path}` : `${d.sha}:${i}`);

/** Highlighting's cache key for file i's rows: with grammar `syntax`, lines `x` shown between hunks, whitespace changes hidden (`ws`). */
export const highlightKey = (d: DiffSummary, i: number, syntax: string | undefined, x: Expansion | undefined, ws: boolean) =>
  `${fileKey(d, i)}:${syntax ?? ''}` + (x ? `:${x.top.join()}/${x.bottom.join()}` : '') + (ws ? ':ws' : '');

/** Show lines whose only change is whitespace as unchanged, in every diff. */
export const hideWhitespace = persisted<boolean>('legit:hide-whitespace', false);

/** Bigger files aren't highlighted ahead of being shown: the worker can't be interrupted. */
const PREHIGHLIGHT_ROWS = 3000;

/** `diffPosition` key of the view of the commit being edited (see EditView). */
export const EDITING = 'editing';

export const app = new App();

const NONE: CommitInfo[] = [];

/**
 * `next`, keeping the commits `prev` already had unchanged (a commit's SHA fixes all but whether
 * it's pushed or rewritable), and `prev` itself if it's the same list, so that rows don't re-render.
 */
function keepCommits(prev: CommitInfo[] | undefined, next: CommitInfo[]): CommitInfo[] {
  if (!prev?.length) return next;
  const by = new Map(prev.map((c) => [c.sha, c]));
  let same = prev.length === next.length;
  const out = next.map((c, i) => {
    const p = by.get(c.sha);
    const kept = p && p.pushed === c.pushed && p.editable === c.editable ? p : c;
    if (kept !== prev[i]) same = false;
    return kept;
  });
  return same ? prev : out;
}

export function shortSha(c: CommitInfo | string) {
  return (typeof c === 'string' ? c : c.sha).slice(0, 7);
}

/** A person's avatar at `size` px (doubled for retina), or null for initials. */
/** Avatars are shown 14 to 22px wide: one size for all, sharp at 2x, so each is downloaded once. */
const AVATAR_PX = 64;
/** Downloaded and decoded pictures, held so the browser keeps them ready for every view that shows one. */
const avatarImages = new Map<string, HTMLImageElement>();

/** The one URL an avatar is shown from, once it's downloaded and decoded; null if it won't load. */
async function preloadAvatar(url: string): Promise<string | null> {
  const src = url.includes('avatars.githubusercontent.com') ? `${url}&s=${AVATAR_PX}` : `${url}?size=${AVATAR_PX}`;
  if (avatarImages.has(src)) return src;
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
  } catch {
    return null;
  }
  avatarImages.set(src, img);
  return src;
}

/** Avatar URL for `email`, the same at every size (so a picture loaded once shows everywhere at once). */
export function avatarUrl(email: string, _size?: number): string | null {
  return app.avatars[email.trim().toLowerCase()] ?? null;
}
