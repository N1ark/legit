// What a running operation is called, to say why switching repo has to wait for it.

const NAMES: Record<string, string> = {
  commit: 'the commit', uncommit: 'undoing the commit', edit: 'saving the commit', split: 'the split', squash: 'the squash',
  reorder: 'the reorder', drop: 'the drop', undo: 'the undo', redo: 'the redo', restore: 'the restore',
  removeChanges: 'the change to the diff', editLine: 'the change to the diff', push: 'the push', pull: 'the pull',
  fetch: 'the fetch', merge: 'the merge', rebase: 'the rebase', abort: 'the abort', continue: 'continuing',
  resolve: 'marking the file resolved', editStart: 'checking out the commit', editFinish: 'finishing the edit',
  editCancel: 'cancelling the edit', stage: 'staging', unstage: 'unstaging', discard: 'the discard',
  restoreDiscarded: 'restoring the discarded changes', stash: 'the stash', stashApply: 'applying the stash',
  stashPop: 'restoring the stash', stashDrop: 'dropping the stash', switch: 'the branch switch',
  createBranch: 'creating the branch', checkoutRemote: 'the checkout', renameBranch: 'the rename',
  deleteBranch: 'deleting the branch', deleteRemoteBranch: 'deleting the remote branch', restoreBranch: 'restoring the branch',
};

/** Why the window can't switch repo while operation `op` (its API name) runs. */
export function switchRefusal(op: string | null): string {
  return `Wait for ${(op && NAMES[op]) || 'the current operation'} to finish before switching repos.`;
}
