// Keeping track during a review, for the diffs: each pull request's files marked viewed and its
// CODEOWNERS (one request per refresh, by number). Marking a file viewed shows at once, and goes
// back if GitHub refuses.
// `DiffTrack` is what one diff view shows of it.

import { toast } from 'purr';
import { gh, ghPost, ghRequest } from './github.svelte.ts';
import type { DiffReview } from './gh-review.svelte.ts';
import { type OwnerRule, type Owners, ownedBy, ownersOf, parseCodeowners } from './codeowners.ts';
import type { PrFiles, ViewedState } from '../../shared/gh-files.ts';

class Tracking {
  /** By pull request number. */
  files = $state.raw<Record<number, PrFiles>>({});
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
 * What one diff shows of it. Viewed marks show on the pull request's whole diff (all its commits
 * up to its head): GitHub's mark is on a file's change in the pull request, which one commit only
 * shows part of. Owners show on any diff of the pull request's branch.
 */
export class DiffTrack {
  review: DiffReview;

  constructor(review: DiffReview) {
    this.review = review;
  }

  pr = $derived.by(() => this.review.pr);
  data = $derived(this.pr ? (tracking.files[this.pr.number] ?? null) : null);
  viewable = $derived.by(() => !!this.data && this.review.ctx.head && this.review.ctx.base);

  private rules = $derived(this.data?.codeowners ? tracking.rules(this.data.codeowners.text) : []);
  private owned = $derived.by(() => {
    void this.rules;
    return new Map<string, Owners | null>();
  });

  /** Keep this pull request's files loaded (call in an effect). */
  load() {
    void gh.tick;
    if (this.pr) tracking.load(this.pr.number);
  }

  /** Its mark, when it shows here: the file's in the pull request and this is its whole diff. */
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
}
