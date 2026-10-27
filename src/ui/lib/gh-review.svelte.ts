// Review threads of the current branch's pull request, for the diffs and the threads panel: loaded
// with one query per refresh (gh.tick), changed through server/gh/review.ts, which answers each
// change with the review as it is then. `DiffReview` is what one diff view shows of it.

import { toast } from 'purr';
import { app } from './app.svelte.ts';
import { gh, ghPost, ghRequest } from './github.svelte.ts';
import { type DiffContext, type Placed, type RowsLike, commentTarget, newText, placeThreads, rowOfLine } from './gh-threads.ts';
import type { DiffSide, NewComment, PrReview, Reaction, ReviewComment, ReviewThread } from '../../shared/gh-review.ts';
import { isLive } from '../../shared/github.ts';

/** A comment being written on lines of a diff (`key`: the diff's), kept while the view comes and goes. */
export interface Draft {
  id: string;
  key: string;
  path: string;
  line: number;
  side: DiffSide;
  startLine?: number;
  startSide?: DiffSide;
  body: string;
  /** The picked lines' new text, for "Suggest"; null when they're removed lines. */
  suggest: string[] | null;
}

/** Something shown under a row of a diff: a thread, or a comment being written. */
export type Block = { key: string; row: number; start: number } & ({ thread: ReviewThread; moved: boolean; draft?: undefined } | { draft: Draft; thread?: undefined });

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
  /** Heights threads were last measured at, so a diff opened again lays out without moving. */
  heights = new Map<string, number>();

  private loading = new Map<number, Promise<void>>();
  private seen = new Map<number, number>();

  /** The current branch's pull request, when it's open and GitHub's reachable. */
  get pr() {
    const pr = gh.pr;
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
  data = $derived(this.pr ? (reviews.byNumber[this.pr.number] ?? null) : null);

  ctx: DiffContext = $derived.by(() => {
    const d = this.data;
    const one = this.shas.length === 1 ? this.shas[0] : null;
    if (!d) return { sha: one, head: false, base: false };
    const head = this.shas[0] === d.headSha;
    // Its old side is the base when it starts at the pull request's first commit.
    const base = head && d.commits.length > 0 && d.commits.every((c) => this.shas.includes(c));
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

  /** Removed lines can be commented on: the diff's old side is the pull request's base. */
  private base = $derived(this.ctx.base || (!!this.data && this.ctx.sha === this.data.commits[0]));

  /** File `path`'s threads and comments being written, under the rows they go with; and its threads with no line here. */
  blocks(path: string, rows: RowsLike | null): { blocks: Block[]; elsewhere: ReviewThread[] } {
    const { placed, elsewhere } = placeThreads(this.byPath.get(path) ?? [], rows, this.ctx);
    const out: Block[] = placed.map((p: Placed) => ({ key: p.thread.id, row: p.row, start: p.start, thread: p.thread, moved: p.moved }));
    if (rows) {
      for (const d of Object.values(reviews.drafts)) {
        if (d.key !== this.key || d.path !== path) continue;
        const row = rowOfLine(rows, d.side, d.line);
        if (row < 0) continue;
        const s = d.startLine !== undefined ? rowOfLine(rows, d.startSide ?? d.side, d.startLine) : row;
        out.push({ key: d.id, row, start: s >= 0 ? s : row, draft: d });
      }
    }
    out.sort((a, b) => a.row - b.row);
    return { blocks: out, elsewhere };
  }

  /** Why rows a..b of `path` can't be commented on, or null. */
  why(rows: RowsLike, a: number, b: number): string | null {
    if ('why' in this.target) return this.target.why;
    const t = commentTarget(rows, a, b, { base: this.base });
    return 'error' in t ? t.error : null;
  }

  /** Start a comment on rows a..b of `path` (or go back to the one being written there). */
  compose(path: string, rows: RowsLike, a: number, b: number) {
    const why = this.why(rows, a, b);
    if (why) return toast.error(why);
    const t = commentTarget(rows, a, b, { base: this.base });
    if ('error' in t) return;
    const id = `draft:${this.key}:${path}:${t.side}${t.line}`;
    const all = [];
    for (let r = Math.min(a, b); r <= Math.max(a, b); r++) all.push(rows.kind[r]);
    const right = t.side === 'RIGHT' && (t.startSide ?? 'RIGHT') === 'RIGHT';
    reviews.drafts[id] ??= { id, key: this.key, path, ...t, body: '', suggest: right ? newText(rows, a, b) : null };
    reviews.focus = { id, path };
  }

  async submit(d: Draft, pending: boolean): Promise<boolean> {
    const pr = this.pr;
    if (!pr || !d.body.trim()) return false;
    if ('why' in this.target) {
      toast.error(this.target.why);
      return false;
    }
    const { line, side, startLine, startSide, path, body } = d;
    return reviews.comment({ number: pr.number, commitId: this.target.commit, path, line, side, startLine, startSide, body, pending }, d);
  }
}
