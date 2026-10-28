/** Commits a branch has that its upstream doesn't, and the reverse, from git's `ahead 2, behind 1`; null for anything else ("gone"). */
export function aheadBehind(track: string): { ahead: number; behind: number } | null {
  const m = /^(?:ahead (\d+)(?:, behind (\d+))?|behind (\d+))$/.exec(track);
  return m && { ahead: Number(m[1] ?? 0), behind: Number(m[2] ?? m[3] ?? 0) };
}

const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;

/** The ↑/↓ counts in words, for their tooltip. */
export function trackTip(upstream: string, ahead: number, behind: number): string {
  const has = ahead ? `${commits(ahead)} ${upstream} doesn't have` : '';
  const lacks = behind ? `${upstream} has ${commits(behind)} this branch doesn't` : '';
  return has && lacks ? `${has}; ${lacks}` : has || lacks;
}
