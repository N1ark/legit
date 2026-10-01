// How long legit keeps its safety refs (backups, discarded changes, deleted branches, dropped
// stashes). They exist to undo a mistake noticed soon after, not to archive everything, and
// each one keeps its objects alive, so old ones are pruned. Once a ref is gone, `git gc`
// eventually removes what only it kept.

import type { Git } from './git.ts';

export const ROOT = 'refs/legit/';
/** Entries older than this are pruned. */
export const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** And never more than this many per directory (e.g. per branch's backups), newest kept. */
export const MAX_COUNT = 500;

/**
 * Delete refs under refs/legit/ whose last path component is `<ms-timestamp>` or
 * `<ms-timestamp>-<label>` and that are older than MAX_AGE_MS or beyond the newest MAX_COUNT
 * in their directory. Anything not named that way is left alone, so every kind of safety ref
 * just needs that naming to be covered.
 */
export async function pruneRefs(git: Git, now = Date.now()) {
  const refs = (await git.text(['for-each-ref', '--format=%(refname)', ROOT])).split('\n').filter(Boolean);
  const dirs = new Map<string, { ref: string; time: number }[]>();
  for (const ref of refs) {
    const slash = ref.lastIndexOf('/');
    const time = Number(/^(\d{10,})(?:-[\w-]+)?$/.exec(ref.slice(slash + 1))?.[1]);
    if (!Number.isFinite(time)) continue;
    const dir = ref.slice(0, slash);
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir)!.push({ ref, time });
  }
  const stale: string[] = [];
  for (const list of dirs.values()) {
    list.sort((a, b) => b.time - a.time);
    list.forEach((r, i) => (i >= MAX_COUNT || now - r.time > MAX_AGE_MS) && stale.push(r.ref));
  }
  if (stale.length) {
    await git.run(['update-ref', '--stdin'], { input: stale.map((r) => `delete ${r}\n`).join('') });
  }
}
