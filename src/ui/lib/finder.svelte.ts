// ⌘F: one query over every diff on screen (the uncommitted changes view shows two), in page order.

/** A diff view that can be searched. */
export interface FindSource {
  el: HTMLElement;
  /** Its matches of the query (reactive). */
  count(): number;
  /** Scroll match k into view. */
  show(k: number): void;
}

class Finder {
  open = $state(false);
  query = $state('');
  /** Index of the current match among all of them. */
  current = $state(0);
  sources = $state.raw<FindSource[]>([]);
  /** Bumped to ask the bar to take focus again. */
  focusTick = $state(0);
  /** Show the current match once there is one (the query changed). */
  private pending = false;

  register(s: FindSource): () => void {
    const all = [...this.sources, s];
    all.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    this.sources = all;
    return () => (this.sources = this.sources.filter((x) => x !== s));
  }

  get total(): number {
    return this.sources.reduce((n, s) => n + s.count(), 0);
  }

  /** The current match as (source, index in it), or null. */
  private locate(): [FindSource, number] | null {
    let k = this.current;
    for (const s of this.sources) {
      const n = s.count();
      if (k < n) return [s, k];
      k -= n;
    }
    return null;
  }

  /** Index of the current match within `s`, or -1. */
  currentIn(s: FindSource): number {
    const at = this.locate();
    return at && at[0] === s ? at[1] : -1;
  }

  show() {
    const total = this.total;
    if (!total) return void (this.pending = true);
    this.pending = false;
    if (this.current >= total) this.current = 0;
    this.locate()?.[0].show(this.locate()![1]);
  }

  /** Matches came in: show the first one if the query asked to. */
  settle() {
    if (this.pending && this.total) this.show();
  }

  step(by: number) {
    const total = this.total;
    if (!total) return;
    this.current = (this.current + by + total) % total;
    this.show();
  }

  search(query: string) {
    this.query = query;
    this.current = 0;
    this.pending = true;
    this.settle();
  }

  start() {
    this.open = true;
    this.focusTick++;
  }

  close() {
    this.open = false;
  }
}

export const finder = new Finder();
