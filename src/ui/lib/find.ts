// Finding text in a diff's lines: where a query matches, and a line's segments cut at the matches.

/** A run of a line's text and its highlighting class (as `highlighter.ts` cuts them). */
interface Segment {
  t: string;
  c: string;
}

/** Case-insensitive unless the query has a capital letter (as in Zed and Vim's smartcase). */
export const caseSensitive = (query: string) => query !== query.toLowerCase();

/** Starts of the (non-overlapping) matches of `query` in `text`. */
export function matchesIn(text: string, query: string, sensitive = caseSensitive(query)): number[] {
  if (!query) return [];
  const hay = sensitive ? text : text.toLowerCase();
  const needle = sensitive ? query : query.toLowerCase();
  const out: number[] = [];
  for (let k = hay.indexOf(needle); k >= 0; k = hay.indexOf(needle, k + needle.length)) out.push(k);
  return out;
}

/** `segs` cut where matches of length `len` start (`starts`, ascending): `m` is 1 in a match, 2 in the current one. */
export function markSegments<S extends Segment>(segs: S[], starts: number[], len: number, current = -1): (S & { m: number })[] {
  if (!starts.length) return segs.map((s) => ({ ...s, m: 0 }));
  const out: (S & { m: number })[] = [];
  let pos = 0;
  let k = 0;
  for (const s of segs) {
    let from = 0;
    while (from < s.t.length) {
      const at = pos + from;
      while (k < starts.length && starts[k] + len <= at) k++;
      const inside = k < starts.length && starts[k] <= at;
      const end = inside ? starts[k] + len : k < starts.length ? starts[k] : Infinity;
      const to = Math.min(s.t.length, end - pos);
      out.push({ ...s, t: s.t.slice(from, to), m: inside ? (starts[k] === current ? 2 : 1) : 0 });
      from = to;
    }
    pos += s.t.length;
  }
  return out;
}
