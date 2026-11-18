// Finding text in a diff's lines: where a query matches, and a line's segments cut at the matches.

/** A run of a line's text and its highlighting class (as `highlighter.ts` cuts them). */
interface Segment {
  t: string;
  c: string;
}

/** Case-insensitive unless the query has a capital letter (as in Zed and Vim's smartcase). */
export const caseSensitive = (query: string) => query !== query.toLowerCase();

/**
 * `s` lowercased, each character keeping its length, so a match's place in it is its place in `s`: the
 * few whose lowercase is longer (İ becomes i and a combining dot) stay as they are.
 */
export function fold(s: string): string {
  const l = s.toLowerCase();
  if (l.length === s.length) return l;
  let out = '';
  for (const ch of s) {
    const c = ch.toLowerCase();
    out += c.length === ch.length ? c : ch;
  }
  return out;
}

/** Starts of the (non-overlapping) matches of `query` in `text`. */
export function matchesIn(text: string, query: string, sensitive = caseSensitive(query)): number[] {
  if (!query) return [];
  const hay = sensitive ? text : fold(text);
  const needle = sensitive ? query : fold(query);
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

/** A match: file i, row r, from character `start`. */
export interface Match {
  i: number;
  r: number;
  start: number;
}

/** Lines lowercased, once per array of them: typing a query searches them again at every key. */
const lowered = new WeakMap<readonly string[], string[]>();
function lower(lines: readonly string[]): string[] {
  let l = lowered.get(lines);
  if (!l) lowered.set(lines, (l = lines.map(fold)));
  return l;
}

/**
 * Every match of `query` in files 0..n-1's lines, in order: `lines(i)` gives file i's (null to leave it out), `skip(i, r)`
 * leaves out a row. `within`: an earlier search's matches for a query this one starts with, over the same lines; only
 * their rows can match, so only those are looked at.
 */
export function findAll(
  query: string,
  n: number,
  lines: (i: number) => readonly string[] | null,
  skip: (i: number, r: number) => boolean,
  within?: readonly Match[],
): Match[] {
  const out: Match[] = [];
  if (!query) return out;
  const sensitive = caseSensitive(query);
  const needle = sensitive ? query : fold(query);
  const scan = (i: number, r: number, hay: string) => {
    for (let k = hay.indexOf(needle); k >= 0; k = hay.indexOf(needle, k + needle.length)) out.push({ i, r, start: k });
  };
  if (within) {
    let last: Match | null = null;
    for (const m of within) {
      if (last && last.i === m.i && last.r === m.r) continue;
      last = m;
      const text = lines(m.i);
      if (text) scan(m.i, m.r, sensitive ? text[m.r] : lower(text)[m.r]);
    }
    return out;
  }
  for (let i = 0; i < n; i++) {
    const text = lines(i);
    if (!text) continue;
    const hay = sensitive ? text : lower(text);
    for (let r = 0; r < hay.length; r++) if (!skip(i, r) && hay[r].includes(needle)) scan(i, r, hay[r]);
  }
  return out;
}
