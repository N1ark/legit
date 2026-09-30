# legit

A tiny, fast UI to rewrite git history: edit commit metadata, split commits line by line,
squash, reorder and drop, without running an interactive rebase.

```sh
npm install           # also builds the UI
npm run app:install   # builds Legit.app and copies it to /Applications
npm link              # puts `legit` on your PATH
legit [path]          # opens the repo at path (default: .) in Legit.app
```

`legit` opens the app when it's installed and falls back to the browser otherwise (`--browser` forces
the browser; `--port N` and `--no-open` apply there). In the app, **File ▸ Open Repository…** (<kbd>⌘O</kbd>) opens
more repos, each in its own window, and launching it again reopens the last repo.

Needs Node ≥ 23.6 and a recent git (tested with 2.54; needs `merge-tree --stdin` with tree arguments). The app itself
is self-contained: it doesn't use your installed Node, only `git`.

## What it does

| | |
|---|---|
| **Edit** | Title, description, author and co-authors (`Co-authored-by` trailers) of any commit. <kbd>⌘↵</kbd> saves, <kbd>esc</kbd> reverts. |
| **Split** | Click, drag or shift-click lines in a commit's diff, or use the strip left of the line numbers to pick whole blocks of consecutive changes (hunk headers and file checkboxes pick more). Then split them into a new commit placed *after* (or *before*) the original. |
| **Squash** | <kbd>⌘</kbd>/<kbd>⇧</kbd>-click several commits; they're folded into the oldest one, with a combined message you can edit. Other authors become co-authors. |
| **Reorder** | Drag commits, or <kbd>⌥↑</kbd>/<kbd>⌥↓</kbd> (<kbd>K</kbd>/<kbd>J</kbd>). |
| **Drop** | Trash button on a commit (click twice). |
| **Undo** | <kbd>⌘Z</kbd>/<kbd>⌘⇧Z</kbd> (per branch), plus the backups panel (clock icon) for anything older. Undoing a commit, amend or uncommit only moves the branch: what's staged and your files stay as they are. |
| **Uncommitted changes** | When there are any, an *Uncommitted changes* entry sits above the newest commit. It shows a commit form plus what's **staged** and **unstaged** (untracked files included), live as files change. Pick lines, blocks or files like in a commit and press <kbd>s</kbd> to stage or <kbd>u</kbd> to unstage (or *Stage all* / *Unstage all*), then <kbd>⌘↵</kbd> to commit. **Amend last commit** folds what's staged into the last commit and lets you edit its message. **Undo commit** (on the newest commit, its right-click menu, or under the commit form) moves the branch back one commit, with that commit's changes staged and its message back in the form. <kbd>⌘Z</kbd> undoes commits and amends the same way. Staging only changes the index, never your files, and refuses if a file changed after it was shown. Commits go through `git commit`, so hooks and signing apply. |
| **Files** | Right-click a file name or a diff line: **Open in Zed** (the repo as the project, at that line or the file's first change), **Copy path**, **Copy relative path**. |
| **Push** | One button in the header: **Publish** a branch with no upstream, **Push ↑N** when ahead, or, after rewriting commits that were already pushed, **Force push ↑N ↓M** (click twice). Force pushes use `--force-with-lease --force-if-includes`, so git refuses if the remote has commits you haven't fetched *and* integrated. |
| **Branches** | Click the branch name or press <kbd>b</kbd>, type to filter, <kbd>↵</kbd> to switch. Uses `git switch`, so uncommitted changes come along and it refuses if they'd be overwritten. |

Generated files (lockfiles, minified bundles, source maps, snapshots, protobuf output… see `src/server/generated.ts`)
start collapsed with a *generated* badge. Anything marked `linguist-generated` in `.gitattributes` counts too (and
`-linguist-generated` opts a file back in). You can add your own patterns:

```sh
git config --add legit.hide 'docs/*.html'     # this repo; use --global for all repos
```

Authors show their GitHub avatar (initials otherwise). GitHub no-reply emails map to one directly. For other
emails, if the repo has a github.com remote, legit asks GitHub's API for a commit by that email in that repo, which
returns the linked account. Emails are only sent to `api.github.com`, and only for repos hosted there. It uses
`GITHUB_TOKEN`/`GH_TOKEN` or the `gh` CLI's login when available (read-only), and results are cached in
`~/Library/Caches/legit/avatars.json`.

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
- **Force pushes can't clobber other people's work**: they only happen after an explicit confirmation, and use
  `--force-with-lease --force-if-includes`, so they fail if the remote has commits this repo hasn't fetched and
  integrated.
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
npm run dev        # browser version, with Vite + HMR for the UI
npm run app:dev    # desktop app in dev mode
npm test           # engine tests against throwaway repos, plus a split fuzz test
npm run check      # svelte-check + tsc
```

- `bin/legit.ts` is the CLI. Node runs the TypeScript directly, with no build step for the server.
- `src/server/git.ts` handles git access: `cat-file --batch` for reading, direct loose-object writes (so no process per
  commit), and a persistent `merge-tree --stdin` for cherry-picks.
- `src/server/repo.ts` holds the operations, backups and safety checks. `diff.ts` parses diffs and rebuilds files from a subset of lines.
- `src-tauri/` is the desktop shell (Tauri 2). Each window starts its own `legit-server` sidecar: the same engine,
  built by `scripts/build-sidecar.mjs` into a standalone binary with Node's single-executable support, which is why
  the app is ~145 MB (almost all of it Node). The window loads the UI from that server. A server exits when its window closes, and only after
  any running operation has finished (or when the app dies, since it holds the server's stdin).
- `src/ui/` is a Svelte 5 UI built on [purr](../purr), the components, icons and styles shared with N1ark's
  other apps (a `file:../purr` dependency, so it needs checking out next to this repo). The diff view (`DiffView.svelte`) is virtualized. Rows have a fixed
  height and never wrap, so the full layout comes from a per-file summary (`/api/diff/<sha>`) before any content
  loads. Only files and rows near the viewport are mounted, and file contents are fetched in batches as they
  scroll into view (`/api/diff/<sha>/files?i=…`). Syntax highlighting (Prism) runs in a web worker
  (`lib/highlight.worker.ts`), nearest file first, and comes back as transferable typed arrays. Grammars are
  lazy-loaded per language (add one in `lib/languages.ts`). Hovering or moving next to a commit prefetches its diff.
