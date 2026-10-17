# Changelog

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
