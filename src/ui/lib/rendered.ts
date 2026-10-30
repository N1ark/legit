// Files shown rendered (markdown as a document, CSV and TSV as a table) rather than as their diff.

import { renderKind } from '../../shared/files.ts';
import type { FileSummary, HunkData } from '../../shared/types.ts';
import { whitespacePairs } from '../../shared/whitespace.ts';

/** Files shown rendered, by path, for the session: the next commit's view shows them so too (and its text is fetched with it). */
export const renderedPaths = new Set<string>();

/** The side of file f to show rendered (the old one of a deleted file), when it can be. */
export const renderSide = (f: FileSummary): 'old' | 'new' | null =>
  renderKind(f.path) && !f.binary && (f.rows || f.status === 'R' || f.status === 'C') ? (f.status === 'D' ? 'old' : 'new') : null;

/** Whether file f shows rendered as the diff of its two versions (an edited markdown file), rather than as one of them. */
export const renderedDiff = (f: FileSummary): boolean =>
  renderKind(f.path) === 'markdown' && !f.binary && f.rows > 0 && f.status !== 'A' && f.status !== 'D';

const added = [new WeakMap<HunkData[], ReadonlySet<number>>(), new WeakMap<HunkData[], ReadonlySet<number>>()];

/** New-side line numbers of the lines a file's hunks add, as its rows show them (`ws`: whitespace hidden, so a line
 *  only re-indented isn't added); the same set for the same hunks. */
export function addedLines(hunks: HunkData[], ws: boolean): ReadonlySet<number> {
  const cache = added[+ws];
  let set = cache.get(hunks);
  if (set) return set;
  const s = new Set<number>();
  for (const h of hunks) {
    const ends = ws ? new Set(h.eof) : null;
    const paired = ws ? new Set(whitespacePairs(h.types, h.text, (j) => ends!.has(j)).values()) : null;
    let n = h.newStart;
    for (let j = 0; j < h.types.length; j++) {
      const t = h.types[j];
      if (t === '-') continue;
      if (t === '+' && !paired?.has(j)) s.add(n);
      n++;
    }
  }
  cache.set(hunks, (set = s));
  return set;
}
