# Changelog

## 0.29.1 — 2026-11-20

- Amending no longer gives the last commit another commit's message: with **Amend last commit** on, moving commits (or an undo, a pull) that put another one on top left the old one's message in the form, and amending renamed the new one to it. The form now follows the new last commit, or, if you'd edited the message, turns amending off and says so.
- A pull request's files load again in repositories without a CODEOWNERS in each of GitHub's three places (most of them), instead of failing with *Could not resolve file for path 'CODEOWNERS'*.

## 0.29.0 — 2026-11-18

- The branch list shows each local branch's pull request whichever branch is checked out: on a fork, while on `main` (which tracks `upstream`), branches pushed to the fork showed none, as only pull requests from `upstream` were taken for theirs.
- A message being typed (a commit's, a squash's, the uncommitted changes' commit form) is kept when another commit is shown and back, not only across repositories; so are an unsent pull request comment or review, and a new pull request's title and description when its dialog is closed.
- GitHub's background refreshes (each focus, each change, the poll) no longer redraw open diffs, their review threads and pull request conversations when nothing changed; the squash view no longer lays its threads out again as older history loads.
- Uncommitted changes in a big working tree list two to three times faster (about 50 ms instead of 120 with 50,000 files), with fewer git runs on every refresh.
- Filtering the branch list keeps up with tens of thousands of remote branches (a letter typed takes a few milliseconds instead of up to 100).
- The branch list keeps its cursor on the branch you arrowed to while it reloads, so <kbd>↵</kbd> no longer switches to another one.
- <kbd>⌘F</kbd> and <kbd>⌘G</kbd> leave an open dialog, menu or settings alone instead of opening the find bar behind it; <kbd>↵</kbd> while an input method is composing no longer picks a branch or repository or splits a commit.
- Commits moved with <kbd>⌥↑</kbd>/<kbd>⌥↓</kbd> stay in view.
- A commit's diff, the stash list, backups, conflicts, editing files and uncommitted changes say why when they can't be loaded, instead of *Loading…* or *None* for good; so does a new pull request whose base can't be compared.
- A pull request overview no longer goes back to how it was before a change you just made (a comment, an edit, closing it) when an older load lands after it.
- Repositories kept in the background trim their caches once no window has shown them for a minute (on a big repository, from about 120 MB to 20), keeping what was on screen; a kept job log no longer holds the whole downloaded log; GitHub answers, avatars, highlighted code and prefetched pull request overviews are kept within a size.
- Author emails are only ever sent to GitHub for repositories on github.com itself: a host merely ending in it (`corp-github.com`) no longer counts.
- An author or co-author with `<`, `>` or a line break is refused, instead of writing a commit `git fsck` rejects.
- Applying a review suggestion to a file that isn't UTF-8 is refused instead of mangling its other characters.
- A fetch, push or clone stuck in a credential or remote helper stops at its timeout.
- Uncommitted changes to a file with a quote, tab or newline in its name no longer take another file's diff.
- Opening a repository while another git holds a lock (a `gc`) no longer fails on pruning old backups; that's tried again later.
- In a bare repository, worktrees are removed and switched to properly (none is taken for the main one).
- Copy to branch no longer refuses `feat` because `feat-x` is checked out elsewhere; cloning `../repo` no longer goes to GitHub.
- Case-insensitive find highlights the right characters after an `İ`.
- Stash conflict messages show file names as they are, not git-quoted; folders that become ignored stop being watched.
- Smaller fixes: an empty drop is refused clearly, staging the same line twice stages one line, settings saved at the same moment can't collide, an interrupted autostash restore is retried, `legit --port abc` says what's wrong, and malformed requests get a 400.

## 0.28.0 — 2026-11-18

- Submodules are handled: a diff shows a submodule as the commits it moved between instead of *Subproject commit* lines, says when one has changes of its own, isn't checked out or is a nested repository (which staging adds as a submodule), and opens it in legit. Switching branch, rewriting history, pulling, merging, undoing and editing files move the submodules they change, leaving one you moved yourself; before, it stayed behind and showed as a change that, committed, put the old commit back. A submodule's new commit can be discarded (and restored), a submodule conflict is resolved by picking a side, stashing only submodule changes says git can't, clones and new worktrees get their submodules, and committing inside a submodule refreshes the window.

## 0.27.0 — 2026-11-18

- Pressing <kbd>⌫</kbd> outside a field (or swiping back) no longer takes the window back to the repository shown before; a web link that would open in the window opens in the browser.
- Picking another repository or worktree while a switch is still on its way ends on the one picked last, not whichever was quicker to load; the repository picker's tick then always marks the repository shown.
- Holding <kbd>⌫</kbd> on picked changes removes them once, rather than trying again with every key repeat.
- A view kept for coming back to a repository is only restored in that repository: a page that finds another's (its port used again by another server) starts afresh instead of taking its selection and drafts.
- When the window's connection to its server drops and comes back (a busy or sleeping Mac), it loads the state again, so changes made in between (a commit from a terminal) show without having to focus the window.
- Publishing a branch says *Published to …* again, not *Pushed to …*.
- Changing a setting twice in quick succession can no longer leave open diffs wrapped or highlighted by the first change.
- A worktree deleted, moved or removed outside legit while it's shown (`rm -rf`, `git worktree remove`, its repository moved) no longer fills the window with errors: within a moment it goes to where `git worktree move` took it, else the main worktree (else another that's still there), or, when the whole repository is gone, says so and offers another.
- On Linux, ignored folders (node_modules, build output, target) aren't watched for changes any more: a big one no longer uses up the system's file watches (leaving legit blind to changes) or keeps the server busy while a build writes into it. A folder deleted and made again (by a build, a stash, a branch switch) is watched again; before, changes in it went unseen.
- While files keep changing (a build, an install), the window looks for uncommitted changes less and less often, down to every 2 seconds, instead of four times a second.
- An operation that meets another git process's lock (a `git commit` waiting on its editor in a terminal) says *Another git process is running in this repository* instead of git's long message.
- A huge commit's file list opens faster: counting its whitespace-only and side-by-side rows takes a third of the time, and the uncommitted changes count only the files that changed since the last look.
- Big uncommitted changes refresh several times faster: only the files that changed since the last look are diffed again.
- Uncommitted changes asked for again while they're still being read (files changing quickly, a slow machine) are read once more for all who asked, instead of once each at the same time.
- On a busy machine, the commit you select shows sooner: git runs a few at a time, the most recent request first, instead of every prefetched diff at once.
- Editing a big file with uncommitted changes no longer piles up memory: past 64 MB, only the last few versions of the changes are kept.
- A pull request's diff since your last review, after a force-push, shows files with non-ASCII names too.
- Looking for uncommitted changes no longer takes git's index lock each time (only once after files were merely touched), so a `git add` or `git commit` in a terminal no longer fails now and then with *index.lock: File exists* while legit is open.
- Showing a big merge's commits again (after hiding them, or coming back to the repo) is instant: what it brought in is worked out once.
- A repository with tens of thousands of remote branches no longer lists them all again on every refresh (each focus, each file saved): only once they may have changed, so the window keeps up while you edit (about 120 ms of work down to 20 with 30,000).
- The fetch every five minutes waits while the window is minimized or hidden, instead of running git in the background; it catches up when the window shows again.
- On a long history, a commit made (or dropped) while you're looking far down the list no longer sends the list back to its first thousand commits and the selection to the top.
- Stepping through commits (holding <kbd>↓</kbd>) no longer lays the page out as each commit's view opens, only once it's drawn; and the file tree no longer throws when the diff is closed as it scrolls.
- Dragging the scrollbar through a big diff (or jumping far in it) keeps up better: while it moves, only the lines in view are drawn, and the ones around them fill in once it stops.
- Typing in ⌘F over a big diff is quicker: each letter typed only looks again at the lines the text so far matched, and only redraws the lines whose matches changed.
- Scrolling a big diff near its top (with the commit's message above it) or its end no longer restyles every line on screen each frame, so it stays smooth on a busy machine.

## 0.26.0 — 2026-11-15

- A pull request's overview is one conversation in the order things happened, as on GitHub: comments, reviews, pushes (each commit with its checks, opening its diff), force-pushes and events, interleaved, instead of a list of commits above it. **Oldest first** / **Newest first** above it picks which end comes first, and is remembered; newest first puts the comment box at the top.
- Each review in a pull request's conversation shows its comments on the diff right under it, instead of only how many there were: each thread with its file and lines, the lines it was made on, its replies, and reply and resolve as in the diff. Comments made alone show at their own time, and your pending review where its latest comment is. The separate list of review threads above the conversation is gone; **N unresolved threads** goes to each in turn.
- Reacting to a review comment picks from a 4×2 grid of the eight emoji, without their names (they show on hover); the arrow keys move around it, and your own reactions show pressed.
- Right-clicking lines in a pull request's **Files changed** offers **Copy GitHub link** and **New issue from these lines…** too, to those lines at its head.
- Pick lines to comment on in a pull request's **Files changed** and its other read-only diffs: click a line, drag or <kbd>⇧</kbd>-click for a range (unchanged lines too), or click a hunk's header or a block's strip for all of it; **Comment** in the bar that shows (or <kbd>c</kbd>, in any diff) starts a comment on them, and <kbd>Esc</kbd> lets go.
- **Viewed** is a clear button in each file's header, in any diff of a pull request's commits (one commit too, not only its whole diff), and never squeezed out: a long path gives way first. <kbd>v</kbd> and **Mark as viewed** in the file tree's menu work there too; files viewed start folded only in the whole diff.
- The file tree beside a pull request's diff shows which files have review threads: how many are unresolved (in colour), or a quiet tick for resolved ones only. Click the count to go to the first; a comment on the whole file of a folded file now unfolds it.
- The purple bar beside the lines a thread is on lines up with the edge of the line numbers, and stays there as the code scrolls sideways.
- A review thread, comment or CI annotation in the middle of added lines sits on their green (removed lines: their red), so the change still reads as one block; side by side, each side keeps its own.
- **Side by side** works in a laptop-sized window, beside the commit list and the file tree (it needed the diff alone to be 760 px wide, so it silently stayed one above the other); where the diff really is too narrow, the switch says *too narrow here*.
- The counts above a diff's file tree (*2 generated*, *3 whitespace-only*) wrap onto their own line in a narrow window instead of overlapping the switches below.
- **Show in diff** sits in each thread's header in the conversation, inside its card.
- GitHub's emoji shortcodes (`:+1:`, `:tada:`, `:octocat:`) show as emoji in comments, descriptions, commit messages and markdown files.
- A long pull request's conversation and review threads come whole: every entry and thread, not only the last 100, so each review shows all its comments.
- Checking out a fork's pull request that lets maintainers push (or is your own fork) adds the fork as a remote and tracks its branch, so **Push** sends your commits there. Any other fork's branch no longer offers **Publish** to your own remote.
- Each worktree of a repository fetches the pull requests it reads for itself, so closing one in a worktree no longer deletes it from under another that's reading it.
- Removed lines of a file a pull request renames take comments, read against the file's old name as GitHub's diff does.
- A stacked pull request's whole diff (all its commits selected) leaves out what merging the branch below into it brought, as it already did for main.
- The pull request lists (<kbd>⇧P</kbd>) come whole, past their first 50: the rest load while a list is shown, so filtering finds any of them.
- Picking assignees or reviewers searches GitHub as you type, so anyone who can be assigned is found, not only the first 100.
- Link issues to a pull request from **Closes** in its overview, or unlink one: that adds or takes out a "Closes #N" line in the description, which is how GitHub links them.
- Code owners count your teams: a file CODEOWNERS gives to a team you're on is yours, in its header and in **Files you own**.
- CI annotations on lines a diff doesn't show are listed from the file's header (*1 annotation off the diff*), each with **Show line N**, which opens the lines there and goes to it.
- **Files you own** leaves the other files out of the diff too, not only the file tree (*1 of 3 files*), keeping your place.
- Side by side, a hunk's header reads across both halves: each side's lines, and the function they're in.
- Comments on a whole file show above it when it's shown rendered (markdown, CSV, JSON) too.
- The shortcuts list (<kbd>?</kbd>) has the pull request list's keys: <kbd>⇥</kbd> for the next list, <kbd>⌘↩</kbd> to check one out, <kbd>⌥↩</kbd> to review it in a worktree.

## 0.25.0 — 2026-11-15

- In a pull request's whole diff (all its commits selected), each file has **Viewed**, kept on GitHub as its own box is: ticking it folds the file, unticking unfolds it, and files you've viewed start folded. <kbd>v</kbd> ticks the file at the top of the diff; right-click a file (or its row in the file tree) for **Mark as viewed**. The tree ticks viewed files and counts them (*3 of 8 files viewed*); a file changed since you viewed it says **Changed since viewed**.
- Each file's header names its code owners, from the base branch's CODEOWNERS (**you** when you're one of them), and the file tree marks yours; **Files you own** lists only those.
- CI's annotations (a lint warning, a failed test…) show under their lines in the pull request's diffs, with the check they're from; each file's header and its row in the file tree count them, and a click on the count goes to the first.
- The repository's pull requests, in GitHub's lists: **Review requested** (from you, or a team you're on), **Yours**, **Assigned** and **All open**, each with its author, head and base, review decision, checks and last update. Open it with <kbd>⇧P</kbd>, the pull requests button in the header (which counts the reviews waiting for you) or **Pull requests…** in the GitHub menu; type to filter, <kbd>⇥</kbd> for the next list, <kbd>↩</kbd> to open one's overview. `#123`, `123` or a pull request's URL opens any one, closed or merged too.
- **Check out** in a pull request's overview (or <kbd>⌘↩</kbd> in the list) fetches it, a fork's too, and switches to its branch, made or fast-forwarded, tracking the head branch when it's on a remote you have. A branch of yours that has diverged from it is never overwritten: it asks whether to reset it (its commits kept in Backups) or check out on another branch. **Review in a worktree** (<kbd>⌥↩</kbd>) does the same in a new worktree next to the repository and shows it, leaving your checkout as it is.
- Assign people to a pull request from its overview, picked as labels are (tick several, applied together when the picker closes), or **assign yourself** when no one is. Assigning shows in the conversation.
- A pull request's overview shows its milestone, how far along it is and when it's due; set or clear it from the side panel.
- The overview's side panel lists the issues a pull request will close, open or closed; click one to open it on GitHub. “Closes #N” in the description links one.
- Diffs can be shown side by side (**Side by side** above the diff, or <kbd>S</kbd>): old lines on the left, new ones on the right, each removed line beside the line it became with its changed words marked. Picking lines, commenting, review threads, ⌘F, wrapping and showing more lines between changes all work there; editing a line goes back to one above the other while you edit, and a narrow window always shows it so.
- Read any pull request without checking it out: opening its overview fetches it into hidden refs (no branch, file or remote branch changes, and nothing new in the branch list or Backups), deleted again once you leave it, and **Files changed** shows its diff from where it branched off its base, as GitHub's tab does, with its review threads. Every commit in the overview opens, whether or not it's in your history, and all of them are listed, not just the last 100. Offline, it says why and shows what it fetched before.
- **Changes since your review** in the overview shows what changed since the commit you last reviewed. After a rebase or force-push it compares the two versions in the files the pull request changes, and says so.
- Each push in a pull request's timeline has **Compare**: the commits it added together, or what a force-push changed (rebases handled as above). An old commit GitHub no longer has says so.
- Selecting a branch's commits for its whole diff no longer shows what merging main into it midway brought in.
- Comment on a whole file: the comment button in a file's header in the diff, or **Comment on this file…** in its right-click menu (in the file tree too), alone or in your review. Comments on whole files show at the top of the file's diff, instead of in a list behind its header.
- Comment on any line of a file a pull request changes, lines shown by expanding the diff too; on removed lines in any commit of it (not only its first); and on ranges spanning removed and added lines. A line GitHub won't take a comment on (in a file the pull request doesn't change by then) says why in its menu, instead of failing when you post.
- Your pending review is listed above the review threads (the **N unresolved** button and the overview) and in **Review**: each comment's file and line and its first words; click one to show it in the diff, edit or delete it, or **Discard review** (click twice) to throw it all away. **Review** says what it will submit (*2 comments on 1 file*) above the verdicts, and its count follows comments added from the diff.
- In the overview's reviewers, hover someone who has reviewed to **Re-request review** (the arrows), or to **Dismiss** their approval or request for changes, with the message GitHub asks for; GitHub's refusal shows when you can't.
- Commit several suggestions at once, as GitHub's **Commit suggestions** does: **Add to batch** on each, then **Apply N suggestions** (beside the threads button, and in the overview) writes them all into your files and makes one commit, *Apply suggestions from code review*, with their authors as co-authors, and resolves their threads if you like. Ones whose lines have changed, that overlap another, or whose file has uncommitted changes are left out, and it says which. It needs the pull request's branch checked out at its head on GitHub; <kbd>⌘Z</kbd> undoes it like a commit.

## 0.24.0 — 2026-11-14

- In the diff's file tree, once you've clicked a file, <kbd>↑</kbd>/<kbd>↓</kbd> go to the file above or below instead of the next commit.
- **Keep HEAD** and **Keep *feature*** are tinted like the side of the conflict they keep, in the diff and in the conflicted files' list.
- JSON files can be shown rendered (the eye in their header): a tree of their values to open and close, the parts holding a change open from the start and changed entries washed green. Right-click an entry for **Expand all**, **Collapse all**, **Copy as JSON** and **Copy path**. Comments and trailing commas (`tsconfig.json`, say) are fine.
- The conflict view's diff lists conflicted files first, tagged **conflicted**, with a **Merged** rule before the rest; the file tree beside it has a **Conflicted** tree above the rest's. Each conflict stands out: its markers in amber, HEAD's side tinted blue and the incoming side purple (diff3's base grey).
- Editing lines in a diff: <kbd>⌘↩</kbd> adds a line below (indented like the one above), <kbd>⌘⇧K</kbd> deletes the caret's line, and deleting every line in the field takes them out of the commit. A line's menu also has **Insert line below** and **Delete line**.
- Review comments on unchanged lines (just below a change, say) show in a rewritten commit's diff too, once the lines around them are shown.

## 0.23.0 — 2026-11-10

- When your branch and the remote's have diverged, **Pull** also offers **Reset to *origin/main***: your branch takes the remote's commits, yours kept in Backups and undoable, uncommitted changes coming along.
- New untracked images show in the uncommitted changes' diff, and more formats show: APNG, `.jfif`, `.cur`, and TIFF, HEIC and JPEG XL in the app. An image that can't be decoded says so instead of showing broken.

## 0.22.0 — 2026-11-09

- On a fork, **Rebase on upstream/main** shows beside **Rebase on main** when the `upstream` remote's default branch has commits your fork's main doesn't yet: one click instead of pulling main from upstream first.
- Uncommitted changes no longer stop anything. Editing a commit's diff, dropping, undoing, pulling, switching with **Bring my changes** and the like merge them onto the result (staged ones stay staged); if they'd conflict, they come back with the conflicts for the conflict view (**Abort** puts them in the stash list). Rebases, merges and cherry-picks that stop on conflicts, and **Edit files**, put them aside in the stash list and bring them back once finished or aborted.
- Delete the branch you're on: legit switches to the default branch first (else the most recent other one), your changes coming along.
- Remove any worktree but the main one, whatever its state: locked, mid-merge, with uncommitted changes or untracked files (stashed on its branch first), or the one you're in (the window moves to the main worktree). When its submodules have work only they have, it asks first.
- **Create PR** pushes or publishes the branch first, and when the remote's copy has commits yours doesn't, asks, then force pushes, instead of refusing.
- A push the remote rejects as not a fast-forward (a branch of the same name already there, say) offers **Force push anyway**, and pushing works while a merge or rebase is stopped.
- Restoring a stash over uncommitted changes to the same files merges them, unless they conflict.
- In the uncommitted changes' diff, the stripes of lines *staged differently* line up across consecutive lines.

## 0.21.0 — 2026-11-09

- A conflicted file's row in the conflict view has **Keep HEAD**, **Keep *feature*** and **Keep both**, settling every conflict in it at once (also in its right-click menu); the toast's **Undo** puts it back.
- Resolving a conflict, or files changing on disk, no longer moves the diff: it stays on the same lines, and unchanged lines you showed between changes stay shown.
- Editing lines in a diff: <kbd>↑</kbd> on the field's first line or <kbd>↓</kbd> on its last takes in the line beyond it, so several lines are edited as one text and saved together (two comment lines rewritten as one, say).
- Lean files (and ```lean code blocks in markdown) are syntax-highlighted.
- **Clone Repository…**, in the repository list (⌘T) and the **File** menu: pick one of your GitHub repositories or give any URL, and the window switches to the clone.

## 0.20.0 — 2026-10-31

- In the conflict view's file list, **Mark resolved** and **Open in Zed** come first, on the left, with the file's path and tags on the right. Double-click a path to open it in Zed, or right-click it for **Open in Zed**, **Mark resolved**, **Copy path** and **Copy relative path**.
- Resolve conflicts right in the conflict view's diff: each conflict's `<<<<<<<` line has **Keep HEAD**, **Keep *feature*** (named as its markers name the sides) and **Keep both**. The file is rewritten at once, and marked resolved when no conflict is left in it; the toast's **Undo** puts it back.

## 0.19.0 — 2026-10-31

- A stash that conflicts with your branch can be restored or applied anyway: the error offers **Restore anyway** / **Apply anyway**, and the conflicts are resolved in the conflict view, like a merge's. **Done** keeps the result as uncommitted changes; **Abort** puts the stash's files back (your other changes stay) and a restored stash back in the list. Files left conflicted by a `git stash pop` in a terminal show there too.
- Working on a fork, `#123` links in messages open the issue or pull request on the original repository: the `upstream` remote's, or, without one, the repository GitHub says your fork is of. **Copy GitHub link** on a line still links to your fork, where your commits are.
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
