/**
 * Where a filtered picker's keyboard cursor starts: on the best-scoring row (on a tie, one that
 * `opens` something, then the earlier), or on `fallback` when no row has a score.
 */
export function startCursor<T extends { score?: number }>(
  rows: readonly T[],
  opens: (row: T) => boolean = () => true,
  fallback = 0,
): number {
  let best = -1;
  for (let k = 0; k < rows.length; k++) {
    const s = rows[k].score;
    if (s === undefined) continue;
    const b = best < 0 ? undefined : rows[best].score!;
    if (b === undefined || s > b || (s === b && opens(rows[k]) && !opens(rows[best]))) best = k;
  }
  return best >= 0 ? best : Math.min(Math.max(fallback, 0), Math.max(rows.length - 1, 0));
}

/** A multi-select list's selection: the rows picked, the last ⌘-clicked, and what was picked then. */
export interface Picks {
  chosen: string[];
  anchor: string | null;
  base: string[];
}

/**
 * A ⌘/Ctrl-click (`range` false) or ⇧-click on row `name`, as in Finder: ⌘ adds or removes it and
 * makes it the anchor; ⇧ picks the rows from the anchor to it, keeping what was picked before
 * (another ⇧-click only changes that range). `order` is the rows as listed.
 */
export function pick(s: Picks, order: readonly string[], name: string, range: boolean): Picks {
  const from = s.anchor === null ? -1 : order.indexOf(s.anchor);
  const to = order.indexOf(name);
  if (range && from >= 0 && to >= 0) {
    // What was picked when the anchor was set, minus what was cleared since.
    const base = s.base.filter((x) => s.chosen.includes(x));
    const span = new Set([...base, ...order.slice(Math.min(from, to), Math.max(from, to) + 1)]);
    // Rows filtered out of the list stay picked.
    return { chosen: [...base.filter((x) => !order.includes(x)), ...order.filter((x) => span.has(x))], anchor: s.anchor, base };
  }
  const chosen = s.chosen.includes(name) ? s.chosen.filter((x) => x !== name) : [...s.chosen, name];
  return { chosen, anchor: name, base: chosen };
}
