// Review threads of the current branch's pull request (or the one whose diff is shown), for the diffs and the threads panel: loaded
// with one query per refresh (gh.tick), changed through server/gh/review.ts, which answers each
// change with the review as it is then. `DiffReview` is what one diff view shows of it.

import { toast } from 'purr';
import { app } from './app.svelte.ts';
import { gh, ghPost, ghRequest } from './github.svelte.ts';
import { DiffTrack } from './gh-files.svelte.ts';
import { type DiffContext, type Placed, type RowsLike, belongs, commentTarget, newText, placeThreads, rowOfLine } from './gh-threads.ts';
import type { ApplySuggestion, DiffSide, NewComment, PrLines, PrReview, Reaction, ReviewComment, ReviewThread, SuggestionsApplied } from '../../shared/gh-review.ts';
import type { Annotation } from '../../shared/gh-files.ts';
import { type GhUser, isLive } from '../../shared/github.ts';
import type { OpResult } from '../../shared/types.ts';

/** A comment being written on lines of a diff (`key`: the diff's), kept while the view comes and goes. */
export interface Draft {
  id: string;
  key: string;
  path: string;
  /** On the whole file (shown at its top): no lines. */
  subject?: 'FILE';
  line: number;
  side: DiffSide;
  startLine?: number;
  startSide?: DiffSide;
  /** Where GitHub has those lines, when that's not where the diff shown has them (removed lines, numbered as the base has them). */
  gh?: { line: number; side: DiffSide; startLine?: number; startSide?: DiffSide };
  body: string;
  /** The picked lines' new text, for "Suggest"; null when they're removed lines. */
  suggest: string[] | null;
}

/** A suggestion picked to commit with others (`key`: its thread's, comment's and block's). */
export interface Batched extends ApplySuggestion {
  key: string;
  number: number;
  threadId: string;
  author: GhUser | null;
}

/** Something shown under a row of a diff (row -1: at the top of the file): a thread, a comment being written, or a CI annotation. */
export type Block = { key: string; row: number; start: number } & (
  | { thread: ReviewThread; moved: boolean; draft?: undefined; note?: undefined }
  | { draft: Draft; thread?: undefined; note?: undefined }
  | { note: Annotation; thread?: undefined; draft?: undefined }
);

class Reviews {
  /** Reviews by pull request number. */
  byNumber = $state.raw<Record<number, PrReview>>({});
  /** Threads shown open or closed against their default (open unless resolved). */
  opened = $state<Record<string, boolean>>({});
  drafts = $state<Record<string, Draft>>({});
  /** Replies being written, by thread. */
  replies = $state<Record<string, string>>({});
  /** A thread to bring into view in the diff showing it. */
  focus = $state<{ id: string; path: string } | null>(null);
  /** Suggestions picked to apply together, by key. */
  batch = $state<Record<string, Batched>>({});
  /** Heights threads were last measured at, so a diff opened again lays out without moving. */
  heights = new Map<string, number>();

  private loading = new Map<number, Promise<void>>();
  private seen = new Map<number, number>();

  /** The pull request whose diff is shown (lib/gh-prdiff.svelte.ts), else the current branch's; when it's open and GitHub's reachable. */
  get pr() {
    const v = gh.view;
    const pr = v?.kind === 'prdiff' ? v.pr : gh.pr;
    return gh.ready && pr && isLive(pr.state) ? pr : null;
  }

  /** Load pull request `number`'s threads, once per `gh.tick` (or now, with `fresh`). Quiet: it's background work. */
  load(number: number, fresh = false): Promise<void> {
    const tick = gh.tick;
    if (!fresh && this.seen.get(number) === tick) return this.loading.get(number) ?? Promise.resolve();
    this.seen.set(number, tick);
    const p = ghRequest<PrReview>('reviewThreads', { number, fresh: fresh ? 1 : null }).then(
      (r) => this.set(r),
      () => {},
    );
    this.loading.set(number, p);
    return p;
  }

  private set(r: PrReview) {
    this.byNumber = { ...this.byNumber, [r.number]: r };
  }

  /** A change on GitHub; errors are toasted. True when it went through. */
  async post(name: string, body: { number: number } & Record<string, unknown>): Promise<boolean> {
    try {
      this.set(await ghPost<PrReview>(name, body));
      return true;
    } catch (e) {
      toast.error(e);
      return false;
    }
  }

  /** Open in a diff unless resolved; in a list (`scope`) closed until opened there. */
  isOpen(t: ReviewThread, scope = ''): boolean {
    return this.opened[scope + t.id] ?? (scope ? false : !t.resolved);
  }

  toggle(t: ReviewThread, scope = '') {
    this.opened[scope + t.id] = !this.isOpen(t, scope);
  }

  reply(number: number, t: ReviewThread, body: string, pending: boolean) {
    const last = t.comments[t.comments.length - 1];
    return this.post('reviewReply', { number, threadId: t.id, commentDatabaseId: last.databaseId, body, pending });
  }

  resolve(number: number, t: ReviewThread, resolved: boolean) {
    // Resolving closes it, unresolving opens it.
    delete this.opened[t.id];
    return this.post('reviewResolve', { number, threadId: t.id, resolved });
  }

  edit(number: number, c: ReviewComment, body: string) {
    return this.post('reviewEdit', { number, commentId: c.id, body });
  }

  remove(number: number, c: ReviewComment) {
    return this.post('reviewDelete', { number, commentId: c.id });
  }

  react(number: number, c: ReviewComment, content: Reaction) {
    const on = !c.reactions.some((r) => r.content === content && r.mine);
    return this.post('reviewReact', { number, subjectId: c.id, content, on });
  }

  async comment(c: NewComment, draft: Draft): Promise<boolean> {
    const ok = await this.post('reviewComment', { ...c });
    if (ok) delete this.drafts[draft.id];
    return ok;
  }

  /** Delete the viewer's review in progress on pull request `number`, with its comments. */
  async discard(number: number): Promise<boolean> {
    const ok = await this.post('reviewDiscard', { number });
    if (ok) toast('Discarded your pending review');
    return ok;
  }

  /** The commits to show thread `t` of pull request `number` on: the one it was made on, else the pull request's up to its head; or why it can't be. */
  where(number: number, t: ReviewThread): string[] | string {
    const data = this.byNumber[number];
    const made = t.comments[0]?.originalCommit;
    if (made && app.bySha.has(made)) return [made];
    if (!data || t.outdated) return "It was made on a commit that isn't in your history any more.";
    const local = data.commits.filter((c) => app.bySha.has(c));
    if (local.length !== data.commits.length || !local.length) return "The pull request's commits on GitHub aren't the ones in your history.";
    return local.toReversed();
  }

  /** Select the commits thread `t` is on (see `where`) and bring it into view there, open. */
  show(number: number, t: ReviewThread): boolean {
    const w = this.where(number, t);
    if (typeof w === 'string') return false;
    app.select(w[0]);
    if (w.length > 1) app.select(w[w.length - 1], 'range');
    this.opened[t.id] = true;
    this.focus = { id: t.id, path: t.path };
    return true;
  }

  /** Pull request `number`'s suggestions picked to apply together. */
  batched(number: number): Batched[] {
    return Object.values(this.batch).filter((b) => b.number === number);
  }

  toggleBatch(b: Batched) {
    if (this.batch[b.key]) delete this.batch[b.key];
    else this.batch[b.key] = b;
  }

  /** Why pull request `number`'s suggestions can't be committed here, or null: they go on its branch, checked out at its head. */
  batchWhy(number: number): string | null {
    const d = this.byNumber[number];
    const repo = app.repo;
    if (!d || !repo) return 'Loading the pull request…';
    if (gh.pr?.number !== number || !repo.branch) return `Check out #${number}'s branch to commit suggestions to it.`;
    if (repo.head !== d.headSha) return `${repo.branch} isn't at #${number}'s head on GitHub: push or pull first, so the suggestions' lines are the ones in your files.`;
    return null;
  }

  /** Commit pull request `number`'s batch of suggestions (see server/gh/suggestions.ts), then resolve their threads if asked. */
  async applyBatch(number: number, resolve: boolean): Promise<boolean> {
    const why = this.batchWhy(number);
    if (why) {
      toast.error(why);
      return false;
    }
    const items = this.batched(number);
    const { branch, head } = app.repo!;
    let got: SuggestionsApplied | null = null;
    const ok = await app.op(
      'gh/reviewApplyBatch',
      { branch, head, suggestions: items.map(({ key: _, number: __, ...s }) => s) },
      undefined,
      async (r) => void (got = r as OpResult & SuggestionsApplied),
    );
    const result = got as SuggestionsApplied | null;
    if (!ok || !result) return false;
    const applied = result.applied.map((i) => items[i]);
    for (const b of applied) delete this.batch[b.key];
    if (!result.refused.length) toast.success(`Committed ${applied.length === 1 ? 'the suggestion' : `${applied.length} suggestions`} to ${branch}`);
    if (resolve) {
      const threads = this.byNumber[number]?.threads ?? [];
      for (const id of new Set(applied.map((b) => b.threadId))) {
        const t = threads.find((x) => x.id === id);
        if (t && !t.resolved && t.canResolve) await this.resolve(number, t, true);
      }
    }
    return true;
  }

  /** Apply a suggestion to the working tree's file; true when it was. */
  async apply(path: string, startLine: number, lines: string[], replacement: string[]): Promise<boolean> {
    try {
      const r = await ghPost<{ line: number }>('reviewApply', { path, startLine, lines, replacement });
      app.workChanged();
      toast.success(`Applied the suggestion to ${path}:${r.line}`);
      return true;
    } catch (e) {
      toast.error(e);
      return false;
    }
  }
}

export const reviews = new Reviews();

/**
 * What one diff shows of the current pull request's review: `shas` are the commits it's the diff of
 * (newest first), `key` the diff's own (a SHA, or a squash's `q…`).
 */
export class DiffReview {
  key: string;
  shas: string[];

  constructor(key: string, shas: string[]) {
    this.key = key;
    this.shas = shas;
  }

  pr = $derived(reviews.pr);
  /** Viewed marks, owners and CI annotations of the files it shows. */
  track: DiffTrack = new DiffTrack(this);
  data = $derived(this.pr ? (reviews.byNumber[this.pr.number] ?? null) : null);

  ctx: DiffContext = $derived.by(() => {
    const d = this.data;
    const one = this.shas.length === 1 ? this.shas[0] : null;
    if (!d) return { sha: one, head: false, base: false };
    const head = this.shas[0] === d.headSha;
    // Its old side is the base when it starts at the pull request's first commit.
    const base = (head && d.commits.length > 0 && d.commits.every((c) => this.shas.includes(c))) || (!!one && one === d.commits[0]);
    return { sha: one, head, base };
  });

  private byPath = $derived.by(() => {
    const m = new Map<string, ReviewThread[]>();
    for (const t of this.data?.threads ?? []) {
      const list = m.get(t.path);
      if (list) list.push(t);
      else m.set(t.path, [t]);
    }
    return m;
  });

  /** The commit GitHub gets comments on (the head for the whole pull request), or why there isn't one. */
  target = $derived.by((): { commit: string } | { why: string } => {
    const d = this.data;
    if (!this.pr) return { why: gh.ready ? 'This branch has no open pull request.' : 'Not signed in to GitHub.' };
    if (!d) return { why: 'Loading the pull request…' };
    if (this.ctx.head) return { commit: d.headSha };
    if (this.shas.length > 1) return { why: "Comment from one commit, or from all of the pull request's commits up to its head." };
    const sha = this.shas[0];
    if (d.commits.includes(sha)) return { commit: sha };
    return app.bySha.get(sha)?.pushed ? { why: `This commit isn't part of #${d.number} on GitHub. Push it first.` } : { why: 'Push this commit first.' };
  });

  /** Removed lines can be commented on as they're numbered here: the diff's old side is the pull request's base. */
  private base = $derived(this.ctx.base);

  /** Threads and comments being written on whole files, shown at their tops, by path. */
  onFiles = $derived.by(() => {
    const m = new Map<string, Block[]>();
    const add = (path: string, b: Block) => {
      const list = m.get(path);
      if (list) list.push(b);
      else m.set(path, [b]);
    };
    for (const t of this.data?.threads ?? []) if (t.subject === 'FILE' && belongs(t, this.ctx)) add(t.path, { key: t.id, row: -1, start: -1, thread: t, moved: false });
    for (const d of Object.values(reviews.drafts)) if (d.key === this.key && d.subject === 'FILE') add(d.path, { key: d.id, row: -1, start: -1, draft: d });
    return m;
  });

  /** File `path`'s threads and comments being written, under the rows they go with; and its threads with no line here (but those at its top). */
  blocks(path: string, rows: RowsLike | null): { blocks: Block[]; elsewhere: ReviewThread[] } {
    const { placed, elsewhere: away } = placeThreads(this.byPath.get(path) ?? [], rows, this.ctx);
    const elsewhere = away.filter((t) => t.subject !== 'FILE');
    const out: Block[] = placed.map((p: Placed) => ({ key: p.thread.id, row: p.row, start: p.start, thread: p.thread, moved: p.moved }));
    if (rows) {
      for (const d of Object.values(reviews.drafts)) {
        if (d.key !== this.key || d.path !== path || d.subject) continue;
        const row = rowOfLine(rows, d.side, d.line);
        if (row < 0) continue;
        const s = d.startLine !== undefined ? rowOfLine(rows, d.startSide ?? d.side, d.startLine) : row;
        out.push({ key: d.id, row, start: s >= 0 ? s : row, draft: d });
      }
      for (const p of this.track.place(path, rows).placed) out.push({ key: `note:${p.note.key}`, row: p.row, start: p.start, note: p.note });
    }
    out.sort((a, b) => a.row - b.row);
    return { blocks: out, elsewhere };
  }

  /** Why rows a..b of `path` can't be commented on, or null. */
  // What GitHub takes comments on in each file (see PrLines), asked of the server as a file's
  // lines are looked at; `linesIn` changes as answers come in. null: it can't tell, and GitHub will.
  private prLines = new Map<string, Promise<PrLines | null> | PrLines | null>();
  private linesIn = $state(0);

  /** What GitHub takes comments on in file `path`, once known (see PrLines). */
  lines(path: string): Promise<PrLines | null> {
    if (!this.data || 'why' in this.target) return Promise.resolve(null);
    const q = { base: this.data.baseSha, commit: this.target.commit, oldest: this.shas[this.shas.length - 1], path };
    const key = JSON.stringify(q);
    const hit = this.prLines.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const p = ghRequest<PrLines | null>('reviewLines', q).then(
      (v) => v,
      () => null,
    );
    this.prLines.set(key, p);
    p.then((v) => {
      this.prLines.set(key, v);
      this.linesIn++;
    });
    return p;
  }

  /** `lines(path)` if it's in, else undefined (and it's asked for). */
  private linesNow(path: string): PrLines | null | undefined {
    void this.linesIn;
    if (!this.data || 'why' in this.target) return null;
    const q = { base: this.data.baseSha, commit: this.target.commit, oldest: this.shas[this.shas.length - 1], path };
    const hit = this.prLines.get(JSON.stringify(q));
    if (hit === undefined) void this.lines(path);
    return hit instanceof Promise ? undefined : hit;
  }

  /** Why rows a..b of `path` can't be commented on, or null. */
  why(path: string, rows: RowsLike, a: number, b: number): string | null {
    if ('why' in this.target) return this.target.why;
    const t = commentTarget(rows, a, b, { base: this.base }, this.linesNow(path));
    return 'error' in t ? t.error : null;
  }

  /** Start a comment on rows a..b of `path` (or go back to the one being written there). */
  async compose(path: string, rows: RowsLike, a: number, b: number) {
    await this.lines(path);
    const why = this.why(path, rows, a, b);
    if (why) return toast.error(why);
    const t = commentTarget(rows, a, b, { base: this.base }, this.linesNow(path));
    const at = commentTarget(rows, a, b, { base: true });
    if ('error' in t || 'error' in at) return;
    const id = `draft:${this.key}:${path}:${at.side}${at.line}`;
    const right = t.side === 'RIGHT' && (t.startSide ?? 'RIGHT') === 'RIGHT';
    const moved = t.line !== at.line || t.startLine !== at.startLine;
    reviews.drafts[id] ??= { id, key: this.key, path, ...at, ...(moved ? { gh: t } : {}), body: '', suggest: right ? newText(rows, a, b) : null };
    reviews.focus = { id, path };
  }

  /** Why file `path` can't be commented on as a whole, or null. */
  fileWhy(path: string): string | null {
    if ('why' in this.target) return this.target.why;
    const pr = this.linesNow(path);
    return pr && !pr.hunks.length ? "The pull request doesn't change this file as of this commit, so GitHub takes no comments on it." : null;
  }

  /** Start a comment on the whole of file `path` (or go back to the one being written). */
  async composeFile(path: string) {
    await this.lines(path);
    const why = this.fileWhy(path);
    if (why) return toast.error(why);
    const id = `draft:${this.key}:${path}:file`;
    reviews.drafts[id] ??= { id, key: this.key, path, subject: 'FILE', line: 0, side: 'RIGHT', body: '', suggest: null };
    reviews.focus = { id, path };
  }

  async submit(d: Draft, pending: boolean): Promise<boolean> {
    const pr = this.pr;
    if (!pr || !d.body.trim()) return false;
    if ('why' in this.target) {
      toast.error(this.target.why);
      return false;
    }
    const { line, side, startLine, startSide } = d.gh ?? d;
    const { path, body, subject } = d;
    return reviews.comment({ number: pr.number, commitId: this.target.commit, path, subject, line, side, startLine, startSide, body, pending }, d);
  }
}
