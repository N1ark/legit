// Keeping track during a review, for the diffs: each pull request's files marked viewed and its
// CODEOWNERS (one request per refresh, by number), and CI's annotations on its head (by SHA, again
// as its checks finish). Marking a file viewed shows at once, and goes back if GitHub refuses.
// `DiffTrack` is what one diff view shows of it.

import { toast } from 'purr';
import { gh, ghPost, ghRequest } from './github.svelte.ts';
import type { DiffReview } from './gh-review.svelte.ts';
import { checks } from './gh-checks.svelte.ts';
import { type OwnerRule, type Owners, ownedBy, ownersOf, parseCodeowners } from './codeowners.ts';
import { type NoteCounts, type PlacedNote, countNotes, placeNotes } from './gh-files.ts';
import type { RowsLike } from './gh-threads.ts';
import type { Annotation, CommitAnnotations, PrFiles, ViewedState } from '../../shared/gh-files.ts';

class Tracking {
  /** By pull request number. */
  files = $state.raw<Record<number, PrFiles>>({});
  /** By commit. */
  notes = $state.raw<Record<string, CommitAnnotations>>({});
  /** The file tree shows only the files the viewer owns. */
  ownedOnly = $state(false);

  private seen = new Map<string, string>();
  /** Marks sent to GitHub and not answered yet, by `number:path`: a refresh meanwhile doesn't undo them. */
  private sending = new Map<string, ViewedState>();
  /** The last DiffView that showed, for the shortcut: toggles Viewed on its current file. */
  private keys: (() => void)[] = [];

  /** Once per `gh.tick` (or now, with `fresh`); quiet, it's background work. */
  load(number: number, fresh = false) {
    if (!this.once(`f${number}`, `${gh.tick}`, fresh)) return;
    ghRequest<PrFiles>('prFiles', { number, fresh: fresh ? 1 : null }).then(
      (f) => {
        for (const [k, s] of this.sending) if (k.startsWith(`${number}:`)) f.viewed[k.slice(`${number}:`.length)] = s;
        this.files = { ...this.files, [number]: f };
      },
      () => {},
    );
  }

  /** `sha`'s annotations, again once per refresh and whenever another of its checks is over. */
  loadNotes(sha: string) {
    if (!this.once(`n${sha}`, `${gh.tick}:${checks.details[sha]?.counts.done ?? ''}`)) return;
    ghRequest<CommitAnnotations>('annotations', { sha }).then(
      (n) => (this.notes = { ...this.notes, [sha]: n }),
      () => {},
    );
  }

  private once(what: string, key: string, fresh = false) {
    if (!fresh && this.seen.get(what) === key) return false;
    this.seen.set(what, key);
    return true;
  }

  private mark(number: number, path: string, s: ViewedState) {
    const f = this.files[number];
    if (f) this.files = { ...this.files, [number]: { ...f, viewed: { ...f.viewed, [path]: s } } };
  }

  /** Mark `path` of pull request `number` viewed or not; true when GitHub took it. */
  async setViewed(number: number, path: string, on: boolean): Promise<boolean> {
    const was = this.files[number]?.viewed[path];
    if (!was) return false;
    const want: ViewedState = on ? 'VIEWED' : 'UNVIEWED';
    const key = `${number}:${path}`;
    this.sending.set(key, want);
    this.mark(number, path, want);
    try {
      await ghPost('prFileViewed', { number, path, viewed: on });
      return true;
    } catch (e) {
      if (this.files[number]?.viewed[path] === want) this.mark(number, path, was);
      toast.error(e);
      return false;
    } finally {
      if (this.sending.get(key) === want) this.sending.delete(key);
    }
  }

  /** A diff view's handler for the shortcut, while it shows; returns what to call when it goes. */
  onKey(fn: () => void): () => void {
    this.keys.push(fn);
    return () => (this.keys = this.keys.filter((k) => k !== fn));
  }

  /** The shortcut: Viewed on the file the diff is on. */
  key() {
    this.keys[this.keys.length - 1]?.();
  }

  private parsed = new Map<string, OwnerRule[]>();

  rules(text: string): OwnerRule[] {
    let r = this.parsed.get(text);
    if (!r) {
      if (this.parsed.size > 8) this.parsed.clear();
      this.parsed.set(text, (r = parseCodeowners(text)));
    }
    return r;
  }
}

export const tracking = new Tracking();

/**
 * What one diff shows of it. Viewed marks show on any diff of the pull request's commits (GitHub's
 * mark is per file, whichever part of its change is shown); files viewed start folded only in its
 * whole diff, since one commit shows only part of a file's change. Owners show on any diff of the
 * pull request's branch, and annotations wherever the new side is its head, since their lines are the head's.
 */
export class DiffTrack {
  review: DiffReview;

  constructor(review: DiffReview) {
    this.review = review;
  }

  pr = $derived.by(() => this.review.pr);
  data = $derived(this.pr ? (tracking.files[this.pr.number] ?? null) : null);
  /** The pull request's whole diff (all its commits, up to its head). */
  whole = $derived.by(() => this.review.ctx.head && this.review.ctx.base);
  /** Of its commits only: its files can be marked viewed. */
  viewable = $derived.by(() => {
    const d = this.review.data;
    return !!this.data && !!d && (this.whole || (this.review.shas.length > 0 && this.review.shas.every((c) => d.commits.includes(c))));
  });
  head = $derived.by(() => (this.review.ctx.head ? (this.review.data?.headSha ?? null) : null));

  private rules = $derived(this.data?.codeowners ? tracking.rules(this.data.codeowners.text) : []);
  private owned = $derived.by(() => {
    void this.rules;
    return new Map<string, Owners | null>();
  });

  private notesByPath = $derived.by(() => {
    const m = new Map<string, Annotation[]>();
    for (const a of (this.head && tracking.notes[this.head]?.annotations) || []) {
      const list = m.get(a.path);
      if (list) list.push(a);
      else m.set(a.path, [a]);
    }
    return m;
  });

  /** Keep this pull request's files and its head's annotations loaded (call in an effect). */
  load() {
    void gh.tick;
    if (this.pr) tracking.load(this.pr.number);
    if (this.head) tracking.loadNotes(this.head);
  }

  /** Its mark, when it shows here: the file's in the pull request and this is a diff of its commits. */
  viewed(path: string): ViewedState | null {
    return (this.viewable && this.data?.viewed[path]) || null;
  }

  setViewed(path: string, on: boolean) {
    return this.pr ? tracking.setViewed(this.pr.number, path, on) : Promise.resolve(false);
  }

  owners(path: string): Owners | null {
    const m = this.owned;
    if (!m.has(path)) m.set(path, ownersOf(this.rules, path));
    return m.get(path)!;
  }

  /** The viewer is one of the file's owners by name. */
  mine(path: string): boolean {
    return ownedBy(this.owners(path)?.owners ?? [], this.data?.viewer ?? '');
  }

  /** How many of the files the viewer owns. */
  ownsAny(paths: string[]): number {
    return this.rules.length ? paths.filter((p) => this.mine(p)).length : 0;
  }

  get codeowners() {
    return this.data?.codeowners?.path ?? null;
  }

  notes(path: string): Annotation[] {
    return this.notesByPath.get(path) ?? [];
  }

  counts(path: string): NoteCounts | null {
    return countNotes(this.notes(path));
  }

  place(path: string, rows: RowsLike): { placed: PlacedNote[]; elsewhere: Annotation[] } {
    return placeNotes(this.notes(path), rows);
  }
}
