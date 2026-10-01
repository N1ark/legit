// Unchanged lines around changes, and what they say about the rest of the file.

/** Unchanged lines diffs show around each change (git's -U). */
export const CONTEXT_LINES = 3;

/**
 * A file whose unchanged lines between hunks can be shown: it was modified, so both sides exist
 * and read the same outside the hunks.
 */
export const expandable = (f: { status: string; binary: boolean }) => f.status === 'M' && !f.binary;

/**
 * Whether a modified file may go on past the diff's last hunk (its line kinds, and whether its
 * last line has no newline). A hunk ends with fewer context lines only at the end of the file;
 * a full run means there may be more, or the file may end right there.
 */
export function moreAfter(types: string, lastEof: boolean): boolean {
  if (lastEof) return false;
  let n = 0;
  for (let k = types.length - 1; k >= 0 && types[k] === ' '; k--) n++;
  return n >= CONTEXT_LINES;
}
