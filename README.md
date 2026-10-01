# legit

A tiny, fast UI to rewrite git history: edit commit metadata, split commits line by line,
squash, reorder and drop, without running an interactive rebase.

```sh
npm install           # also builds the UI
npm run install:app   # builds Legit.app and copies it to /Applications
npm link              # puts `legit` on your PATH
legit [path]          # opens the repo at path (default: .) in Legit.app
```

`legit` opens the app when it's installed and falls back to the browser otherwise (`--browser` forces
the browser; `--port N` and `--no-open` apply there). In the app, **File ▸ Open Repository…** (<kbd>⌘O</kbd>) opens
more repos, each in its own window, and launching it again reopens the last repo. The app remembers the last 30
repos you opened: **File ▸ Open Recent**, or click the repo name in the header (<kbd>⌘T</kbd>) to filter them, switch
to one (its window opens, or comes to the front), remove one from the list, or open another.

Needs Node ≥ 23.6 and a recent git (tested with 2.54; needs `merge-tree --stdin` with tree arguments). The app itself
is self-contained: it doesn't use your installed Node, only `git`.

## What it does

| | |
|---|---|
| **Edit** | Title, description, author and co-authors (`Co-authored-by` trailers) of any commit. Titles and descriptions show as markdown; click one (or tab to it) to edit it. <kbd>⌘↵</kbd> saves, <kbd>esc</kbd> reverts. |
| **Links** | Web links in messages, and `#123`, `GH-123` or `owner/repo#123`, which open the GitHub issue or pull request (of the remote you push to, else `origin`). In the commit list, <kbd>⌘</kbd>-click them: a click selects the row. |
| **Split** | Click, drag or shift-click lines in a commit's diff, or use the strip left of the line numbers to pick whole blocks of consecutive changes (hunk headers and file checkboxes pick more). Then split them into a new commit placed *after* (or *before*) the original. |
| **Edit the diff** | Change what a commit does, right in its diff. Pick lines and press **Remove** (<kbd>⌫</kbd>), or right-click one: an added line is no longer added (*Don't add this line*), a removed line stays (*Keep this removed line*); right-click a file to take all of its changes out. Double-click an added or unchanged line (or right-click ▸ *Edit line*) to edit it in place: <kbd>↵</kbd> saves, <kbd>⇧↵</kbd> adds a line, <kbd>esc</kbd> cancels. The commits after it are replayed on top, like `git rebase -i` with an amended commit, so the change carries through to them and your files (it's refused when you have uncommitted changes). If a later commit touches the same lines, the replay continues as a `git rebase` that stops on the conflict, like any other: resolve it and continue, or abort to put everything back. <kbd>⌘Z</kbd> undoes it. |
| **Edit files** | **Edit files** on a commit (or in its right-click menu) checks it out: your files become what they were in that commit, and you change anything in your editor, new files included. **Finish editing** (<kbd>⌘↵</kbd>) amends your changes into the commit and replays the commits after it; if one conflicts, you resolve it in the conflict view and continue, as in any rebase. **Cancel** puts everything back (your edits are saved first, under `refs/legit/aborted`). It's a `git rebase -i` stopped at the commit, as `edit` does, so an edit stop you started from a terminal shows up the same way. It needs a clean working tree; untracked files that were already there are left alone and never folded into the commit. <kbd>⌘Z</kbd> undoes it once finished. |
| **Squash** | <kbd>⌘</kbd>/<kbd>⇧</kbd>-click several commits; they're folded into the oldest one, with a combined message you can edit. Other authors become co-authors. |
| **Reorder** | Drag commits, or <kbd>⌥↑</kbd>/<kbd>⌥↓</kbd> (<kbd>K</kbd>/<kbd>J</kbd>). |
| **Drop** | Trash button on a commit (click twice). |
| **Undo** | <kbd>⌘Z</kbd>/<kbd>⌘⇧Z</kbd> (per branch), plus the backups panel (clock icon) for anything older. Undoing a commit, amend or uncommit only moves the branch: what's staged and your files stay as they are. |
| **Uncommitted changes** | When there are any, an *Uncommitted changes* entry sits above the newest commit. It shows a commit form plus what's **staged** and **unstaged** (untracked files included), live as files change. Pick lines, blocks or files like in a commit and press <kbd>s</kbd> to stage or <kbd>u</kbd> to unstage (or *Stage all* / *Unstage all*), then <kbd>⌘↵</kbd> to commit. **Amend last commit** folds what's staged into the last commit and lets you edit its message. **Undo commit** (on the newest commit, its right-click menu, or under the commit form) moves the branch back one commit, with that commit's changes staged and its message back in the form. <kbd>⌘Z</kbd> undoes commits and amends the same way. Staging only changes the index, never your files, and refuses if a file changed after it was shown. Commits go through `git commit`, so hooks and signing apply. |
| **Discard** | Throw away unstaged changes: picked lines (**Discard** next to *Stage*), a whole file (right-click it), or everything (**Discard all**), untracked files included. Staged changes can be discarded the same way: they leave both the index and your files, and any unstaged edits to the same files are kept (it refuses if they overlap). Each takes a second click. What's thrown away is saved first, so the toast's **Undo**, or **Restore** under *Discarded changes* in the backups panel (kept for two weeks), puts it back, staged changes included. Files over 20 MB go to the Trash instead. |
| **Context** | The arrows on a hunk's header show the unchanged lines hidden above it, 20 at a time (from just above the hunk, or just below the one before), or all at once when there are only a few; the row after the last hunk shows the rest of the file. |
| **Files** | Right-click a file name (in the diff or the file tree beside it) or a diff line: **Open in Zed** (the repo as the project, at that line or the file's first change), **Copy path**, **Copy relative path**. |
| **Sync** | In the header: **Fetch** (with when it last happened; it also runs every five minutes while the window is open, and on focus after a minute), then the next step: **Publish** a branch with no upstream, **Push ↑N** when ahead, **Pull ↓N** when behind (a fast-forward; uncommitted changes come along unless they'd be overwritten). When the remote has commits you don't, and you have commits it doesn't, **Pull** offers **Rebase** (your commits replayed on top, in memory; refused if anything conflicts or if they include a merge) or **Merge** (a real `git merge`, which may stop on conflicts). When it's diverged because you rewrote commits that were already pushed (its tip was once on your branch), the button is **Force push** instead (click twice). Force pushes use `--force-with-lease --force-if-includes`, so git refuses if the remote has commits you haven't fetched *and* integrated. Pulls, merges and rebases can be undone. |
| **Merge & rebase** | Right-click a branch in the branch list: **Merge it into** the current branch (`git merge`) or **Rebase** the current branch **onto** it (in memory, refused on conflicts). |
| **Conflicts** | When a merge, rebase, cherry-pick or revert stops halfway (here or in a terminal), *Uncommitted changes* becomes *Merge in progress* (etc.) and shows the conflicted files, each with **Open in Zed** (at the first conflict marker) and **Mark resolved** (`git add`; it asks again while the file still has `<<<<<<<`/`=======`/`>>>>>>>` lines), plus the diff of what finishing would change. **Commit merge** / **Continue** is enabled once nothing is conflicted; **Abort** (click twice) saves your files first. |
| **Branches** | Click the branch name or press <kbd>b</kbd>, type to filter, <kbd>↵</kbd> to switch. Typing a new name offers **Create branch** (from HEAD); a commit's right-click menu has **New branch from here…**. Right-click a branch to **rename** it (its undo history and backups follow) or **delete** it (click twice; not the one you're on), and to delete its upstream on the remote, which is a separate confirmed action. **Remote branches** without a local one are listed too; choosing one checks it out as a local tracking branch. **Recently deleted** branches are listed for two weeks; choosing one brings it back. |
| **Switching with changes** | If you have uncommitted changes, legit asks: **Leave my changes on** the current branch (they're stashed with `git stash push --include-untracked`) or **Bring my changes to** the new one (`git switch`, which refuses if they'd be overwritten). Coming back to a branch with changes left on it offers to **Restore** them. |
| **Stashes** | The box icon in the header lists stashes: **Restore** (apply, then remove from the list), **Apply** (keep it), **Drop** (click twice), and **Stash all changes**. Click one (or **View** on the *Stashed changes* banner) to see its changes in place of the commit: staged and unstaged together, then its untracked files; <kbd>esc</kbd> closes it. Dropped and restored stashes stay listed for two weeks and can still be viewed and applied. |

Generated files (lockfiles, minified bundles, source maps, snapshots, protobuf output… see `src/server/generated.ts`)
start collapsed with a *generated* badge. Anything marked `linguist-generated` in `.gitattributes` counts too (and
`-linguist-generated` opts a file back in).

**Settings** (the gear in the header, or <kbd>⌘,</kbd>) add to that, and pick how files are highlighted. Each list has
a part for this repo (stored in `.git/legit/settings.json`, so not committed) and one for all repos (in
`~/Library/Application Support/legit/settings.json`); both apply, the repo's winning. Changes save as you type, and
the open diff takes them right away.

- **Collapsed files**: more patterns to collapse, e.g. `docs/*.html`. (These used to be `git config legit.hide`;
  existing values are copied in the first time, and git config isn't read after that.)
- **Syntax highlighting**: diffs are highlighted with Prism, by file extension. Files it doesn't know, or gets wrong,
  can use a tree-sitter grammar instead, e.g. `*.out` → `ullbc`: the name of a grammar in Zed's installed extensions
  (the field suggests them), or a folder with a compiled grammar (`*.wasm`, from `tree-sitter build --wasm`) and its
  `highlights.scm` (at the top, in `queries/`, or in `languages/*/`, as in a Zed extension). A grammar that can't be
  found gets a warning next to it; one that won't load falls back to Prism. The last matching rule wins.

Patterns without a slash match the file name at any depth.

Authors show their GitHub avatar (initials otherwise). GitHub no-reply emails map to one directly. For other
emails, if the repo has a github.com remote, legit asks GitHub's API for a commit by that email in that repo, which
returns the linked account. Emails are only sent to `api.github.com`, and only for repos hosted there. It uses
`GITHUB_TOKEN`/`GH_TOKEN` or the `gh` CLI's login when available (read-only), and results are cached in
`~/Library/Caches/legit/avatars.json`.

<kbd>j</kbd>/<kbd>k</kbd> move the selection, and <kbd>?</kbd> lists every shortcut. The list follows the first-parent history of `HEAD`, and older
history loads as you scroll. Everything from the first merge commit down is shown but can't be rewritten. Click the
arrow on a merge (or press <kbd>→</kbd>/<kbd>←</kbd>) to list the commits it brought in under it.

## How it stays safe

Losing work is the one failure that matters, so every operation is built to be refused rather than risky:

- **Nothing is ever deleted.** Rewrites only *add* commits; the old ones stay in the object store.
- **Backups.** Before HEAD moves, the old tip is saved as `refs/legit/backups/<branch>/<time>-<op>`.
  These survive restarts and `git gc`. The backups panel restores any of them, and a restore takes its own backup first.
- **Kept for two weeks.** Backups (and legit's other safety refs) are for undoing a mistake you notice soon, not an
  archive, and each one keeps its objects alive. So refs older than two weeks (or beyond 500 per branch) are pruned,
  after which `git gc` can reclaim what only they kept.
- **Deleted branches come back.** Before a branch is deleted, its tip is saved as `refs/legit/deleted/<branch>/<time>`
  (outside the backups, so a restore can't move HEAD to it), and the delete itself is a compare-and-swap. Deleting a
  branch on a remote saves the tip you last fetched as `refs/legit/deleted/<branch>/<time>-<remote>`, and the push is
  leased on it, so commits you haven't fetched are never deleted. Both are kept for two weeks and listed under
  *Recently deleted*; restoring recreates the branch in one transaction that refuses if the name is taken.
- **Stashes only apply cleanly.** A stash is applied only if no uncommitted change touches its files, none of the files it
  creates already exist, and its changes merge onto HEAD without conflicts (checked in memory with `git merge-tree`);
  otherwise nothing is changed. Restoring (pop) removes it from the stash list only after a clean apply, and before
  any stash leaves the list it's saved as `refs/legit/stashes/<time>-<pop|drop>`, kept for two weeks. If a switch
  fails after stashing, the changes are put back.
- **Discarding saves first.** Before a discard touches anything, the files as they are on disk (bytes, modes,
  symlinks, untracked files) are committed on HEAD as `refs/legit/discarded/<time>`, whose second parent holds the
  files as the discard leaves them. Each file is compared byte for byte right before it's written, so an edit made in
  the meantime stops the discard instead of being lost (and the error says where the snapshot is). Discarding unstaged
  changes never touches the index; discarding staged ones also saves the index entries before and after (the third
  and fourth parents), and only updates the index if nothing restaged those files meanwhile. Files over 20 MB aren't put in git: they go to the macOS Trash, and if that fails they're left alone.
  Restoring refuses files that changed since the discard unless you confirm, and then saves them first.
- **The final snapshot can't change unless you're dropping commits or editing a diff.** Edit, split, squash and reorder only restructure
  history. If the rewritten tip's tree isn't byte-identical to the current one, the operation is aborted.
- **Your working tree is left alone.** Most operations don't touch it at all. When one would (drop, undo, restore),
  it's refused if you have any uncommitted changes to tracked files, and git itself refuses to overwrite untracked files.
- **All in memory until the last step.** Cherry-picks run through `git merge-tree` (no checkout, no index); a conflict
  aborts with nothing changed. The one exception is editing a commit's diff when a later commit conflicts with the
  change: then the edited commit is written, the tip backed up, and the later commits handed to `git rebase`, which
  stops on the conflict. Editing a commit's files is a real `git rebase -i` too. Both only start from a clean
  working tree, after a backup of the tip, so aborting always gets back to where you were. New commits are read back through git and checked before HEAD moves.
- **Atomic.** HEAD is moved with a compare-and-swap (`git update-ref HEAD new old`), so if anything else changed the
  branch in the meantime the operation fails instead of clobbering it. Every move also lands in the reflog as
  `legit: <op>`.
- **Force pushes can't clobber other people's work**: they only happen after an explicit confirmation, and use
  `--force-with-lease --force-if-includes`, so they fail if the remote has commits this repo hasn't fetched and
  integrated.
- **Pulls and rebases carry your changes like `git switch`.** A fast-forward or a rebase onto another branch moves
  HEAD once (after a backup, with a compare-and-swap) through a two-way `git read-tree -m -u`: uncommitted changes
  come along, and if one (or an untracked file) would be overwritten, git refuses and nothing changes. Rebases are
  replayed in memory, so a conflict refuses the whole rebase rather than stopping halfway.
- **Merges start clean.** `git merge --abort` can't always restore changes that were there before a merge, so legit
  only merges when there are no uncommitted changes to tracked files (untracked files are fine).
- **Aborting keeps your resolutions.** Before aborting a merge, rebase, cherry-pick or revert, the working-tree
  version of every changed or conflicted file is committed on top of HEAD (in a throwaway index) and saved as
  `refs/legit/aborted/<branch>/<time>-<kind>`, kept for two weeks; `git restore -s <ref> -- <file>` brings a file back.
  Continuing backs up the tip it replaces first.
- **Fetching can't hang or get in the way.** Git never prompts (`GIT_TERMINAL_PROMPT=0`, and SSH runs with
  `BatchMode=yes` unless you set your own SSH command), fetches time out after two minutes, and they only update
  remote-tracking refs, so they run alongside other operations. Nothing is pruned.
- **No rewriting mid-merge.** History rewriting refuses to run during a rebase, merge, cherry-pick, revert or bisect.

Rewritten commits get you as committer (like `git rebase`); authors and dates are kept. Signatures are dropped from
rewritten commits, since they would no longer be valid.

### Recovering by hand

```sh
git for-each-ref refs/legit/backups       # every backup, newest last
git reflog                                # every HEAD move, including legit's
git reset --keep refs/legit/backups/main/<time>-<op>   # put the branch back
git for-each-ref --format='delete %(refname)' refs/legit/backups | git update-ref --stdin  # remove all backups
git for-each-ref refs/legit/deleted       # deleted branches (and remote branches, ending in -<remote>)
git branch feature refs/legit/deleted/feature/<time>   # bring one back
git for-each-ref refs/legit/stashes       # stashes that were dropped or restored
git stash apply refs/legit/stashes/<time>-drop         # apply one again
git stash store -m 'back' refs/legit/stashes/<time>-drop  # or put it back in the stash list
git for-each-ref refs/legit/discarded     # every discard, newest last
git diff <ref>^2 <ref>                    # what it threw away, as a patch (pipe it to `git apply`)
git show <ref>:<path> > <path>            # one file back, byte for byte
git show <ref>^3:<path>                   # for a discard of staged changes: what was staged
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
- `src/server/repo.ts` holds the operations, backups and safety checks. `sync.ts` fetches, pulls, merges and rebases onto other branches, and finishes or aborts conflicted operations. `diff.ts` parses diffs and rebuilds files from a subset of lines.
  `branches.ts` creates, renames, deletes and restores branches and switches between them; `stash.ts` stashes and
  applies changes, and checks a stash can't conflict before applying it.
  `discard.ts` discards uncommitted changes and puts them back.
- `src-tauri/` is the desktop shell (Tauri 2). Each window starts its own `legit-server` sidecar: the same engine,
  built by `scripts/build-sidecar.mjs` into a standalone binary with Node's single-executable support, which is why
  the app is ~145 MB (almost all of it Node). The window loads the UI from that server. A server exits when its window closes, and only after
  any running operation has finished (or when the app dies, since it holds the server's stdin). The recent list is
  `recent-repos` in the app's config dir. The page can call only four app commands (`capabilities/default.json`):
  list the recent repos, open one *from that list*, show the folder picker, and remove one from the list.
- `src/ui/` is a Svelte 5 UI built on [purr](https://github.com/N1ark/purr), the components, icons and styles
  shared with N1ark's other apps, pinned to a release tag in `package.json` (`npm link ../purr` to work on it live). The diff view (`DiffView.svelte`) is virtualized. Rows have a fixed
  height and never wrap, so the full layout comes from a per-file summary (`/api/diff/<sha>`) before any content
  loads. Only files and rows near the viewport are mounted, and file contents are fetched in batches as they
  scroll into view (`/api/diff/<sha>/files?i=…`). Showing the lines between hunks loads the file's old version
  (`/api/diff/<sha>/old?i=…`) and rebuilds its rows (`lib/rows.ts`); the summary counts the row after the last
  hunk wherever the file may go on, so nothing moves before you click. Syntax highlighting (Prism) runs in a web worker
  (`lib/highlight.worker.ts`), nearest file first, and comes back as transferable typed arrays. Grammars are
  lazy-loaded per language (add one in `lib/languages.ts`). Hovering or moving next to a commit prefetches its diff.
