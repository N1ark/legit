// A map that forgets what was used least recently, past a number of entries or a total weight
// (lines, say, so a few huge files don't hold as much memory as thousands of small ones).

export class Lru<K, V> {
  private map = new Map<K, { value: V; weight: number }>();
  private total = 0;
  private readonly max: number;
  private readonly budget: number;

  constructor(max: number, budget = Infinity) {
    this.max = max;
    this.budget = budget;
  }

  get size() {
    return this.map.size;
  }

  /** The total weight held. */
  get weight() {
    return this.total;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** The value, now the most recently used. */
  get(key: K): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  /** Add or replace; the oldest entries go until it fits (the one just set always stays). */
  set(key: K, value: V, weight = 1) {
    this.delete(key);
    this.map.set(key, { value, weight });
    this.total += weight;
    for (const [k, e] of this.map) {
      if (k === key || (this.map.size <= this.max && this.total <= this.budget)) break;
      this.map.delete(k);
      this.total -= e.weight;
    }
  }

  /** Set the weight of `key` once it's known, if it still holds `value`. */
  weigh(key: K, value: V, weight: number) {
    const e = this.map.get(key);
    if (e?.value !== value) return;
    this.map.delete(key);
    this.total -= e.weight;
    this.set(key, value, weight);
  }

  /** Remove `key`; given `value`, only if it still holds that one. */
  delete(key: K, value?: V) {
    const e = this.map.get(key);
    if (!e || (value !== undefined && e.value !== value)) return;
    this.map.delete(key);
    this.total -= e.weight;
  }

  clear() {
    this.map.clear();
    this.total = 0;
  }
}
