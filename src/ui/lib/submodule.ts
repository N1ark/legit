// What a submodule's card in a diff says, and how tall it is (fixed, so the view can lay it out before anything loads).

import type { SubmoduleChange, SubmoduleLog } from '../../shared/types.ts';

/** Fixed geometry (px) of the card: padding, its line, its note, and the commit list's rows (it scrolls past them). */
export const SUB = { PAD: 8, LINE: 26, NOTE: 19, ROW: 19, ROWS: 6 };

const short = (sha?: string) => sha?.slice(0, 7) ?? '';

export interface SubmoduleCard {
  /** "1a2b3c4 → 5d6e7f8", "added at 5d6e7f8"... */
  change: string;
  /** Tags: what's going on inside it, in the working tree. */
  badges: { label: string; tip: string; warn?: boolean }[];
  /** It moved between two commits: their log shows. */
  log: boolean;
  /** A note under its line (why there's nothing to stage, say). */
  note?: string;
  /** It's checked out, so it can be opened. */
  openable: boolean;
}

/** The card of a submodule change; `note`: the server's word on what's staged, shown with the uncommitted changes. */
export function submoduleCard(s: SubmoduleChange, note?: string): SubmoduleCard {
  const { old, new: now } = s;
  const change =
    s.nested ? `nested repository${now ? ` at ${short(now)}` : ''}`
    : old && now ? (old === now ? `at ${short(old)}` : `${short(old)} → ${short(now)}`)
    : now ? `added at ${short(now)}`
    : old ? `removed (was ${short(old)})`
    : 'no commit';
  const badges: SubmoduleCard['badges'] = [];
  if (s.dirty?.modified) badges.push({ label: 'modified content', tip: 'Files tracked in it have uncommitted changes: commit them in the submodule', warn: true });
  if (s.dirty?.untracked) badges.push({ label: 'untracked content', tip: 'It has untracked files: commit them in the submodule (or ignore them there)' });
  if (s.missing) badges.push({ label: 'not checked out', tip: "Its folder is empty here (git submodule update --init fills it): what's inside can't be read" });
  if (s.nested) badges.push({ label: 'nested repository', tip: s.url ? `A git repository of its own: staging adds it as a submodule cloned from ${s.url}` : 'A git repository of its own, without a remote: staging adds it as a submodule nobody else can clone' });
  return { change, badges, log: !!old && !!now && old !== now, note, openable: !s.missing };
}

/** The card's height: its line, its note, and the log's rows when it has one. */
export const submoduleHeight = (c: SubmoduleCard) => 2 * SUB.PAD + SUB.LINE + (c.note ? SUB.NOTE : 0) + (c.log ? SUB.ROWS * SUB.ROW + SUB.PAD : 0);

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** What a log says in a few words: "3 new commits", "went back 2 commits", or both. */
export function logSummary(log: SubmoduleLog): string {
  if (log.unavailable === 'not-checked-out') return 'Not checked out here, so its commits can’t be listed';
  if (log.unavailable === 'missing-commit') return 'A commit it points at isn’t in the submodule: fetch it there';
  const added = log.added.length + log.more.added;
  const removed = log.removed.length + log.more.removed;
  const parts = [];
  if (added) parts.push(removed ? `${plural(added, 'commit')} added` : plural(added, 'new commit'));
  if (removed) parts.push(added ? `${plural(removed, 'commit')} dropped` : `went back ${plural(removed, 'commit')}`);
  return parts.join(', ') || 'No commits between them';
}

/** The log's rows, newest first: what it gained, then what it lost, each with how many more weren't listed. */
export type LogRow = { kind: '+' | '-'; sha: string; subject: string; author: string; time: number } | { kind: 'more'; side: '+' | '-'; n: number };

export function logRows(log: SubmoduleLog): LogRow[] {
  const rows: LogRow[] = log.added.map((c) => ({ kind: '+' as const, ...c }));
  if (log.more.added) rows.push({ kind: 'more', side: '+', n: log.more.added });
  for (const c of log.removed) rows.push({ kind: '-', ...c });
  if (log.more.removed) rows.push({ kind: 'more', side: '-', n: log.more.removed });
  return rows;
}

/**
 * A submodule's changes are picked whole: it has nothing to stage when it points where it did (its changes are
 * inside it), unless the index has it elsewhere (then that can be unstaged).
 */
export const inert = (f: { submodule?: SubmoduleChange; untracked?: boolean; stage?: string }) =>
  !!f.submodule && !f.untracked && f.submodule.old === f.submodule.new && f.stage !== 'some' && f.stage !== 'all';

/** Files as the diff lays them out: a submodule shows as its card, not its "Subproject commit" lines. The same array when there's none. */
export function asLaidOut<F extends { submodule?: SubmoduleChange; rows: number; width: number; ws: number; paired: number; pairedWs: number }>(files: F[]): F[] {
  if (!files.some((f) => f.submodule)) return files;
  return files.map((f) => (f.submodule ? { ...f, rows: 0, width: 0, ws: 0, paired: 0, pairedWs: 0 } : f));
}
