// Bringing another branch into the current one, for a branch's right-click menu.

import type { MenuEntry } from 'purr';
import { GitMerge, GitPullRequest } from 'purr/icons';
import { app } from './app.svelte.ts';

/**
 * "Merge <branch> into <current>" (`git merge`, which may stop on conflicts to resolve here)
 * and "Rebase <current> onto <branch>" (in memory, refused on any conflict). `name` is a local
 * or remote-tracking branch; `close` runs first, e.g. to close the branch picker.
 */
export function integrateEntries(name: string, current: boolean, close?: () => void): MenuEntry[] {
  const here = app.repo?.branch;
  if (current || !here) return [];
  const why = app.repo?.blocked ?? null;
  const go = (op: 'merge' | 'rebase') => () => {
    close?.();
    app.sync(op, { branch: name });
  };
  return [
    {
      label: `Merge ${name} into ${here}`,
      icon: GitMerge,
      disabled: !!why || app.busy,
      note: why ?? 'Needs no uncommitted changes. Conflicts can be resolved here, or aborted.',
      run: go('merge'),
    },
    {
      label: `Rebase ${here} onto ${name}`,
      icon: GitPullRequest,
      disabled: !!why || app.busy,
      note: why ?? `Replays the commits only on ${here} on top of ${name}. Refused if anything conflicts.`,
      run: go('rebase'),
    },
  ];
}
