// Ranking a long list (thousands of branches) as the user types, as purr's `rank` would with one key, for a
// fraction of the work: each item's text is built and lower-cased once per list, typing on only looks again at
// what the last query matched, items whose text doesn't hold the query's letters in order are dropped before
// they're scored (no tier matches without that), and the survivors are sorted once rather than inserted one by
// one. The matched letters, for highlighting, are worked out only for the rows that show them.

/** purr's scoring (`matchScore`, `fuzzyMatch`), passed in so this stays plain TypeScript. */
export interface Scorer {
  /** Higher is better; null for a miss. */
  score(query: string, text: string): number | null;
  /** The matched positions in `text`, for highlighting. */
  indices(query: string, text: string): number[];
}

export interface Hit<T> {
  item: T;
  /** Worked out when first read. */
  readonly indices: number[];
}

/** `needle`'s characters appear in `hay` in order. */
function subsequence(needle: string, hay: string): boolean {
  if (needle.length > hay.length) return false;
  let j = 0;
  for (let i = 0; i < needle.length; i++) {
    j = hay.indexOf(needle[i], j);
    if (j < 0) return false;
    j++;
  }
  return true;
}

const NO_INDICES: number[] = [];

export class ListRanker<T> {
  readonly items: readonly T[];
  private readonly texts: string[];
  private readonly lowers: string[];
  private readonly scorer: Scorer;
  /** The last query (trimmed, lower case) and the items that held its letters in order. */
  private last: { needle: string; at: number[] } | null = null;

  constructor(items: readonly T[], key: (item: T) => string, scorer: Scorer) {
    this.items = items;
    this.texts = items.map(key);
    this.lowers = this.texts.map((t) => t.toLowerCase());
    this.scorer = scorer;
  }

  /** The items matching `query`, best first; equal scores, and an empty query, keep the list's order. */
  rank(query: string): Hit<T>[] {
    const q = query.trim();
    const needle = q.toLowerCase();
    if (!needle) return this.items.map((item) => ({ item, indices: NO_INDICES }));
    // A longer query only matches what the shorter one did (each tier needs its letters in order).
    const from = this.last && needle.startsWith(this.last.needle) ? this.last.at : null;
    const at: number[] = [];
    if (from) {
      for (const i of from) if (subsequence(needle, this.lowers[i])) at.push(i);
    } else {
      for (let i = 0; i < this.lowers.length; i++) if (subsequence(needle, this.lowers[i])) at.push(i);
    }
    this.last = { needle, at };
    const scored: { i: number; s: number }[] = [];
    for (const i of at) {
      const s = this.scorer.score(q, this.texts[i]);
      if (s !== null) scored.push({ i, s });
    }
    scored.sort((a, b) => b.s - a.s || a.i - b.i);
    const { items, texts, scorer } = this;
    return scored.map(({ i }) => {
      let indices: number[] | undefined;
      return {
        item: items[i],
        get indices() {
          return (indices ??= scorer.indices(q, texts[i]));
        },
      };
    });
  }
}
