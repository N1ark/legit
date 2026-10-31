# Changelog

## Unreleased

- A stash that conflicts with your branch can be restored or applied anyway: the error offers **Restore anyway** / **Apply anyway**, and the conflicts are resolved in the conflict view, like a merge's. **Done** keeps the result as uncommitted changes; **Abort** puts the stash's files back (your other changes stay) and a restored stash back in the list. Files left conflicted by a `git stash pop` in a terminal show there too.
- Scrolled down a commit (or any view), a **Back to top** button in the bottom right corner jumps back up.
- With the find bar (⌘F) open, clicking a commit and pressing ↑/↓ moves through the commits again instead of scrolling the diff; esc closes the bar while it has the focus.
- Right-click a folder in the file tree: **Open in Zed**, **Copy path**, **Copy relative path**, and, in a commit, **Remove folder from commit**; in *Uncommitted changes*, **Stage folder**, **Unstage folder** and **Discard this folder's changes**.
- A worktree with submodules can be removed (git refused: "working trees containing submodules cannot be moved or removed"). Its submodules go with it, once they have no uncommitted changes and no commits that aren't on a remote.
- A commit's title starts as one naming what's staged (*Update auth.ts*, *Add a.ts and b.ts*, *Update 4 files in src/ui*), so ⌘↵ commits right away; click it to type over it.
- **Stage all**, **Unstage all** and **Discard all** sit at the left of the bar above the uncommitted changes, with the file count on the right.

## 0.18.1 — 2026-10-31

- In a rendered markdown diff, inline code is tinted green or red with what was added or removed, instead of keeping its grey box.

## 0.18.0 — 2026-10-30

- A rendered markdown file shows what the commit changed, as GitHub's rich diff does: added blocks green, removed ones red where they were, edited paragraphs, list items, table cells and code lines marked word by word or line by line. Only the changes show, with a little around them; the rest folds into gaps that open with the arrows, as in a code diff.
- Switching a file between its diff and its rendered view keeps your place, and so do images loading or the window resizing while you read it.
- Rendered files are much faster: they show the moment they're switched on, stay rendered at no cost as you go through commits, and never freeze the window, however big (markdown up to 1 MB, CSV and TSV up to 5 MB).

## 0.17.0 — 2026-10-30

- Markdown, CSV and TSV files can be shown rendered instead of as a diff: the eye button in a file's header (or its menu) shows markdown as GitHub does (code highlighted, tables, task lists, alerts) and CSV/TSV as a table, with what the commit changed washed green. The choice sticks to the file as you go through commits.
- Inline code in commit messages is monospace again.

## 0.16.0 — 2026-10-29

- A diff's file count, totals and **Hide whitespace** sit above the file tree, beside the diff, and that column is never taller than the part of the diff on screen: the tree can always be scrolled to its first and last file, even with the commit's message still in view. The "Click line numbers to pick" hint is gone.
- A commit's top bar (its SHA, date, **Edit files**, **Undo commit**…) stays in view as you scroll its diff.

## 0.15.0 — 2026-10-28

- Labels and reviewers on a pull request, and labels and assignees on a new issue, are picked as on GitHub: tick as many as you like, filtering as you type (↵ ticks), and they're applied together when the picker closes. Labels show their descriptions, and the new ones show at once.

## 0.14.0 — 2026-10-28

- The branch list shows how far a branch is from its upstream as ↑2 ↓1 instead of "ahead 2, behind 1" (hover for it in words).
- Icons are lighter: the first screen loads a fifth less code, and rows in the commit list, the branch list, diffs and ⌘K draw their icons in about half the time.

## 0.13.0 — 2026-10-28

- Switching back to the window, or several changes at once, reload the repository once instead of several times over, and an operation's own changes no longer reload what it just showed.
- Uncommitted changes refresh much faster, and use far less memory, with many or large untracked files or a big partly staged file.
- Huge commits open about twice as fast, and scrolling fast through one with thousands of files stays smooth: files you only fly past are no longer fetched or highlighted. Wrapped diffs of very long files scroll smoothly too.
- Code is highlighted as soon as a diff first shows, and the file you're reading comes before the ones around it, even in the middle of a long file.
- Looking through many commits with huge diffs uses about half the memory, and long sessions in deep history stay light: what's kept for going back is bounded by size.
- The branch list and ⌘K open at once when opened again, and the branch list follows a fetch or a terminal commit while it's open. Repos with many branches list them faster.
- Coming back to a repo in the app shows the diffs you'd opened without working them out again, and switching repos readies the new one while the current window is still keeping its view.
- `legit <path>` opens the repository in the app about twice as fast.
- In dark mode, the window no longer flashes white while a repository loads.
- GitHub is asked less: every 5 minutes while the window is in the background (focusing it still updates at once), CI once per branch switch and not again when files are saved, and unchanged CI steps cost no rate limit.
- A pull request's overview, the checks popover and notifications show at once when opened again, and update in the background. A finished job's log opens at once the second time, and logs of thousands of lines open and scroll without a stall.
- When GitHub's rate limit runs out, legit waits for it to reset and says how long that is, rather than asking again.
- On Linux, opening a big repository no longer takes seconds or crashes when the system runs out of file watches; if watching stops, legit looks again whenever the window is focused.
- Collapsed-file and syntax rules edited by hand in the settings file apply to diffs already viewed.
- A branch with the same name as a tag is listed under its own name, not `heads/<name>`.
- Long lists (the commit list, the branch list, diffs) scroll and step with **j**/**k** more smoothly.

## 0.12.0 — 2026-10-27

- **⌘K** goes anywhere from one field: a branch, a worktree, a recent repository or a commit, by its title, its SHA or `HEAD~3`.
- Every branch in the branch list shows its pull request, however many there are.
- Draft pull requests and ones waiting in a merge queue look different from open ones, everywhere a pull request shows.
- Switching repos is quicker.
- The commit list no longer gets stuck on "Loading…" after switching branch or pulling, or at the end of a shallow clone.

## 0.11.0 — 2026-10-24

- The diff of uncommitted changes stays where you were reading as files change, instead of jumping back to the top.

## 0.10.0 — 2026-10-23

- Right-clicking the branch or repository name in the top bar opens its menu, as do worktrees and recent repositories in the repository list.

## 0.9.0 — 2026-10-23

- A new worktree can be made for an existing branch picked from a list, instead of typing its name.

## 0.8.0 — 2026-10-23

- Reordering, dropping or squashing commits that conflict stops at the conflict for you to resolve (or abort), instead of refusing.

## 0.7.0 — 2026-10-20

- Switching repos is quicker, and going back to one of the last few is quicker still.
- Notifications show whether each pull request or issue is open, a draft, merged or closed.
- The window is ready sooner: the commit list, the first diff, and the branch's pull request, checks and notifications all show up faster.
- Long histories and branch lists stay smooth: scrolling, **j**/**k** and filtering no longer lag.
- Big commits open several times faster (thousands of files, huge or minified files), and diffs come up already highlighted.
- Staging, committing, undoing and switching branches are quicker, and a big file that's partly staged no longer takes seconds to show.
- Changes to ignored files (build output, `node_modules`) no longer refresh the window, and a hidden window stops asking GitHub for updates.
- A branch with the same name as a tag can be pushed again.

## 0.6.0 — 2026-10-19

- **Help ▸ Logs** (or Settings ▸ Logs) shows what went wrong lately — failed requests, and GitHub calls that failed or were slow — to copy into a bug report.
- The branch list shows remote branches' pull requests too, and remote branches can be selected and deleted along with local ones. Deleting a remote branch that's already gone there removes it (kept under Recently deleted).
- **P** shows the current branch's pull request from anywhere, and its title in the pull request card opens it.
- Open a pull request's checks from its merge box and its commit list.
- Review threads mark the lines they're about with a bar, and the pull request view fits a narrow pane.
- ⇧-clicking a range of branches keeps the ⌘-clicked ones, as in Finder; a worktree is removed with two clicks on its bin, like other deletions.
- Less text everywhere, with tooltips that show at once; the branch list shows only the current branch's upstream.
- GitHub keeps working after the Mac sleeps or the network changes, without reloading: dropped connections are retried on fresh ones, the token is looked for again, and the branch's pull request comes back.
- The branch list no longer waits for GitHub, and legit asks GitHub less on every local change.
- A branch not pushed yet, or tracking another branch, no longer shows that branch's CI as its own.
- Click the name in the header.

## 0.5.0 — 2026-10-18

- The header shows the branch's pull request and its stack of pull requests; click one in the stack to switch to its branch, and restack a branch when the one under it moved or was merged.
- **Create pull request** from the header, pushing the branch first and offering to stack it on the branch below.
- Review comments sit under their lines in a commit's diff: reply, resolve, apply a suggested change to your files, and comment on picked lines (or start a review).
- A pull request's overview: description, commits, conversation, reviewers, labels, reviews, and merging.
- CI status for the branch and for each pushed commit, with each job's steps and logs, and re-running or cancelling runs.
- GitHub notifications behind a bell in the header; a pull request of this repo opens in legit.
- The GitHub menu in the header: new issue, new pull request, and the repo's pages on GitHub.
- `#123` references show whether they're open, closed or merged, and `#` suggests issues while writing a commit message.
- Right-click diff lines to copy their GitHub link or open an issue about them.

## 0.4.0 — 2026-10-17

- ⌘T: ↵ opens the repository or worktree your filter matches best, rather than creating a worktree.
- A commit's author is one `Name <email>` field, like a co-author, and suggests people from the history too.
- Rebuild a branch on another with only the commits you select (right-click ▸ **Rebuild on…**), resolving conflicts commit by commit.
- **Hide whitespace** above a diff shows lines that only changed whitespace as unchanged.
- In a partly changed line, the words that changed are highlighted.
- Change the remote branch a branch tracks, or stop tracking it, from its right-click menu; the branch list shows each one's upstream.
- ⌘/⇧-click branches in the branch list to delete several at once.

## 0.3.0 — 2026-10-13

- Worktrees: switch between a repo's worktrees from the repo name in the header, create one for a branch, and remove one.

## 0.2.0 — 2026-10-13

- ⌘F finds text in the diff, collapsed files included; ⌘G / ⇧⌘G or ↵ / ⇧↵ move between matches.
- Select and copy text in diffs by dragging over the code; click or drag the line numbers to pick lines.
- Long lines in diffs can wrap to the window or at a column, with optional guide lines (Settings ▸ Lines).
- The strip that picks a whole block of changes is three times wider.
- Renamed files show as old → new, with only their changes.
- See images before and after in diffs (side by side, slider or onion skin), and every binary file's size change.
- Staging is now just checking lines: each file shows one diff, and clicking a line, block or file stages or unstages it at once; right-click to discard.
- ⌘↵ works wherever the focus is, and continues a merge.
- Conflicts: **Mark all resolved** stages every conflicted file at once.
- The **Bring my changes to…** button no longer looks broken when hovered.
- The file tree shows even for one file, sorts like Zed, and double-clicking a file opens it in Zed.
- Right-click a commit to copy its hash, or to drop it; the toast offers Undo.
- The split's new commit gets a default title, so you can split without typing one.
- Editing a commit's files, splitting it or saving its message keeps its diff where you were.
- Cherry-pick commits onto another branch, or pick another branch's commits onto this one.
- A rebase that conflicts stops at each conflicting commit for you to resolve, instead of being refused.
- Force push is always available when the remote has commits you don't, and a refused force push says why and offers to force push anyway.
- Fetch, pull and push show their progress.
- Avatars already shown somewhere appear instantly everywhere else.
- Keyboard shortcuts are listed in Settings and the Help menu.
