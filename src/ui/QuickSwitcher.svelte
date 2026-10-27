<script lang="ts">
  // ⌘K: go anywhere from one field. A branch (local, checked out in another worktree, or a remote
  // one to check out), a worktree, a recent repository (in the app), or a commit: one listed, or
  // any by SHA or `HEAD~3`, the list loading older history down to it.
  import { CommandPalette, IS_TAURI, toast, type PaletteItem } from 'purr';
  import { CloudArrowDown, FolderSimple, Folders, GitBranch, GitCommit, MagnifyingGlass } from 'purr/icons';
  import { onMount } from 'svelte';
  import type { BranchInfo, RemoteBranchInfo, WorktreeInfo } from '../shared/types.ts';
  import { app, request, shortSha } from './lib/app.svelte.ts';
  import { switchOp } from './lib/branches.svelte.ts';
  import { invoke } from './lib/desktop.ts';
  import { listWorktrees, openWorktree } from './lib/worktrees.svelte.ts';

  interface Props {
    onclose: () => void;
  }
  let { onclose }: Props = $props();

  interface RecentRepo {
    path: string;
    name: string;
    short: string;
    current: boolean;
  }

  let locals = $state.raw<BranchInfo[]>([]);
  let remotes = $state.raw<RemoteBranchInfo[]>([]);
  let trees = $state.raw<WorktreeInfo[]>([]);
  let recent = $state.raw<RecentRepo[]>([]);

  onMount(() => {
    request<BranchInfo[]>('/api/branches').then((r) => (locals = r), toast.error);
    request<RemoteBranchInfo[]>('/api/branches/remote').then((r) => (remotes = r), toast.error);
    listWorktrees().then((r) => (trees = r), () => {});
    if (IS_TAURI) invoke<RecentRepo[]>('recent_repos').then((r) => (recent = r), () => {});
  });

  const folder = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

  function openRepo(path: string) {
    if (app.switchBlocker) return toast(app.switchBlocker);
    // The app asks the page before switching (App.svelte `leave`), which keeps what it shows.
    invoke('open_repo', { path }).catch(toast.error);
  }

  const items = $derived.by((): PaletteItem[] => {
    const blocked = !!app.repo?.blocked;
    const out: PaletteItem[] = [];
    for (const b of locals) {
      if (b.current) continue;
      out.push({
        id: `local:${b.name}`,
        label: b.name,
        detail: b.worktree ? `in ${folder(b.worktree)} · ${b.subject}` : b.subject,
        icon: GitBranch,
        disabled: blocked && !b.worktree,
        run: () => (b.worktree ? openWorktree(b.worktree) : switchOp('switch', { branch: b.name }, b.name)),
      });
    }
    for (const w of trees) {
      if (w.current || w.missing) continue;
      out.push({ id: `tree:${w.path}`, label: w.name, detail: `${w.branch ?? 'detached'} · ${w.short}`, icon: FolderSimple, run: () => openWorktree(w.path) });
    }
    for (const r of recent) {
      if (!r.current) out.push({ id: `repo:${r.path}`, label: r.name, detail: r.short, icon: Folders, run: () => openRepo(r.path) });
    }
    for (const b of remotes) {
      out.push({
        id: `remote:${b.ref}`,
        label: `${b.remote}/${b.name}`,
        detail: b.subject,
        icon: CloudArrowDown,
        disabled: blocked,
        run: () => switchOp('checkoutRemote', { ref: b.ref }, b.name),
      });
    }
    for (const c of app.commits) {
      out.push({
        id: `commit:${c.sha}`,
        label: c.subject,
        detail: `${shortSha(c)} · ${c.author.name}`,
        icon: GitCommit,
        keywords: [c.sha],
        run: () => {
          app.select(c.sha);
          app.reveal?.(c.sha);
        },
      });
    }
    return out;
  });

  /** A SHA not listed, or a revision like `HEAD~3` or `v1.2^`: looked for in the branch's history. */
  function goTo(query: string): PaletteItem | null {
    const q = query.toLowerCase();
    const sha = /^[0-9a-f]{4,64}$/.test(q);
    if (!(sha || /[~^]/.test(query)) || query.startsWith('-') || /\s/.test(query)) return null;
    if (sha && app.commits.some((c) => c.sha.startsWith(q))) return null;
    return { id: 'goto', label: `Go to commit ${query}`, icon: MagnifyingGlass, run: () => app.goTo(query) };
  }
</script>

<CommandPalette
  {items}
  {onclose}
  create={goTo}
  label="Go to"
  placeholder={IS_TAURI ? 'Branch, commit or repository…' : 'Branch, commit or worktree…'}
  chooseLabel="go"
  emptyText={(q) => (q.trim() ? `Nothing matches “${q.trim()}”.` : 'Loading…')}
/>
