// The order files are listed in, as in Zed's project panel.

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Two names in a folder: case-insensitive, numbers by value; ties broken by bytes so the order is total. */
export const compareNames = (x: string, y: string) => collator.compare(x, y) || (x < y ? -1 : x > y ? 1 : 0);

/**
 * Compare two repo paths folder by folder: at each level folders come before files, and names
 * compare case-insensitively with numbers by value, so `soteria/` comes before `soteria-rust/`.
 */
export function comparePaths(a: string, b: string): number {
  const pa = a.split('/');
  const pb = b.split('/');
  for (let i = 0; ; i++) {
    const aDir = i < pa.length - 1;
    const bDir = i < pb.length - 1;
    if (aDir !== bDir) return aDir ? -1 : 1;
    const c = compareNames(pa[i], pb[i]);
    if (c || !aDir) return c;
  }
}
