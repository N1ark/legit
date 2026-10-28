# Changelog

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
