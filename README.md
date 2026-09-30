# legit

A tiny, fast UI to rewrite git history: edit commit metadata, split commits line by line,
squash, reorder and drop, without running an interactive rebase.

```sh
npm install        # also builds the UI
npm link           # puts `legit` on your PATH
legit [path]       # opens the UI for the repo at path (default: .)
```

Options: `--port N`, `--no-open`. Needs Node ≥ 23.6 and a recent git (tested with 2.54; needs `merge-tree --stdin` with tree arguments).

## What it does

| | |
|---|---|
| **Edit** | Title, description, author and co-authors (`Co-authored-by` trailers) of any commit. <kbd>⌘↵</kbd> saves, <kbd>esc</kbd> reverts. |
| **Split** | Click, drag or shift-click lines (or whole files/hunks) in a commit's diff, then split them into a new commit placed *after* (or *before*) the original. |
| **Squash** | <kbd>⌘</kbd>/<kbd>⇧</kbd>-click several commits; they're folded into the oldest one, with a combined message you can edit. Other authors become co-authors. |
| **Reorder** | Drag commits, or <kbd>⌥↑</kbd>/<kbd>⌥↓</kbd> (<kbd>K</kbd>/<kbd>J</kbd>). |
| **Drop** | Trash button on a commit (click twice). |
| **Undo** | <kbd>⌘Z</kbd>/<kbd>⌘⇧Z</kbd>, plus the backups panel (clock icon) for anything older. |

<kbd>j</kbd>/<kbd>k</kbd> move the selection. The list follows the first-parent history of `HEAD` down to the first
merge commit; the history below a merge is shown but can't be rewritten.

## How it stays safe

Losing work is the one failure that matters, so every operation is built to be refused rather than risky:

- **Nothing is ever deleted.** Rewrites only *add* commits; the old ones stay in the object store.
- **Backups.** Before HEAD moves, the old tip is saved as `refs/legit/backups/<branch>/<time>-<op>`.
  These survive restarts and `git gc` (the newest 500 per branch are kept). The backups panel restores any of them,
  and a restore takes its own backup first.
- **The final snapshot can't change unless you're dropping commits.** Edit, split, squash and reorder only restructure
  history. If the rewritten tip's tree isn't byte-identical to the current one, the operation is aborted.
- **Your working tree is left alone.** Most operations don't touch it at all. When one would (drop, undo, restore),
  it's refused if you have any uncommitted changes to tracked files, and git itself refuses to overwrite untracked files.
- **All in memory until the last step.** Cherry-picks run through `git merge-tree` (no checkout, no index); a conflict
  aborts with nothing changed. New commits are read back through git and checked before HEAD moves.
- **Atomic.** HEAD is moved with a compare-and-swap (`git update-ref HEAD new old`), so if anything else changed the
  branch in the meantime the operation fails instead of clobbering it. Every move also lands in the reflog as
  `legit: <op>`.
- **Refuses to run** during a rebase, merge, cherry-pick, revert or bisect.

Rewritten commits get you as committer (like `git rebase`); authors and dates are kept. Signatures are dropped from
rewritten commits, since they would no longer be valid.

### Recovering by hand

```sh
git for-each-ref refs/legit/backups       # every backup, newest last
git reflog                                # every HEAD move, including legit's
git reset --keep refs/legit/backups/main/<time>-<op>   # put the branch back
git for-each-ref --format='delete %(refname)' refs/legit/backups | git update-ref --stdin  # remove all backups
```

## Development

```sh
npm run dev    # same server, with Vite + HMR for the UI
npm test       # engine tests against throwaway repos, plus a split fuzz test
npm run check  # svelte-check + tsc
```

- `bin/legit.ts` is the CLI. Node runs the TypeScript directly, with no build step for the server.
- `src/server/git.ts` handles git access: `cat-file --batch` for reading, direct loose-object writes (so no process per
  commit), and a persistent `merge-tree --stdin` for cherry-picks.
- `src/server/repo.ts` holds the operations, backups and safety checks. `diff.ts` parses diffs and rebuilds files from a subset of lines.
- `src/ui/` is a Svelte 5 UI with Phosphor icons.
