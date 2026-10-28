<script lang="ts">
  // ⌘K: go anywhere from one field. A branch (local, checked out in another worktree, or a remote
  // one to check out), a worktree, a recent repository (in the app), or a commit: one listed, or
  // any by SHA or `HEAD~3`, the list loading older history down to it.
  import { CommandPalette, IS_TAURI, rank, toast, type PaletteItem } from 'purr';
  import { CloudArrowDownRegular, FolderSimpleRegular, FoldersRegular, GitBranchRegular, GitCommitRegular, MagnifyingGlassRegular } from 'purr/glyphs';
  import { onMount } from 'svelte';
  import type { BranchInfo, RemoteBranchInfo, WorktreeInfo } from '../shared/types.ts';
  import { app, shortSha } from './lib/app.svelte.ts';
  import { lists, switchOp } from './lib/branches.svelte.ts';
  import { invoke } from './lib/desktop.ts';
  import { listWorktrees, openWorktree, worktreeList } from './lib/worktrees.svelte.ts';

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
  /** Nothing is listed until every list is here, so the cursor doesn't jump as they arrive. */
  let loaded = $state(false);

  onMount(() => {
    // What was listed in this same state shows at once, as it's asked for again.
    const [kept, keptRemote, keptTrees] = [lists.local.cached, lists.remote.cached, worktreeList.cached];
    const cached = !!(kept && keptRemote && keptTrees);
    if (kept && keptRemote && keptTrees) [locals, remotes, trees] = [kept, keptRemote, keptTrees];
    const fresh = Promise.allSettled([
      lists.local.load().then((r) => (locals = r), toast.error),
      lists.remote.load().then((r) => (remotes = r), toast.error),
      listWorktrees().then((r) => (trees = r), () => {}),
    ]);
    Promise.allSettled([
      !cached && fresh,
      IS_TAURI && invoke<RecentRepo[]>('recent_repos').then((r) => (recent = r), () => {}),
    ]).then(() => (loaded = true));
  });

  const folder = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

  function openRepo(path: string) {
    if (app.switchBlocker) return toast(app.switchBlocker);
    // The app asks the page before switching (App.svelte `leave`), which keeps what it shows.
    invoke('open_repo', { path }).catch(toast.error);
  }

  /** Switching branch waits for what's in progress to end; it says so rather than leave the branch out. */
  const unlessBlocked = (run: () => unknown) => () => (app.repo?.blocked ? toast(`${app.repo.blocked} Finish or abort it first.`) : run());

  const items = $derived.by((): PaletteItem[] => {
    if (!loaded) return [];
    const out: PaletteItem[] = [];
    for (const b of locals) {
      if (b.current) continue;
      out.push({
        id: `local:${b.name}`,
        label: b.name,
        detail: b.worktree ? `in ${folder(b.worktree)} · ${b.subject}` : b.subject,
        icon: GitBranchRegular,
        run: b.worktree ? () => openWorktree(b.worktree!) : unlessBlocked(() => switchOp('switch', { branch: b.name }, b.name)),
      });
    }
    for (const w of trees) {
      if (w.current || w.missing) continue;
      out.push({ id: `tree:${w.path}`, label: w.name, detail: `${w.branch ?? 'detached'} · ${w.short}`, icon: FolderSimpleRegular, run: () => openWorktree(w.path) });
    }
    for (const r of recent) {
      if (!r.current) out.push({ id: `repo:${r.path}`, label: r.name, detail: r.short, icon: FoldersRegular, run: () => openRepo(r.path) });
    }
    for (const b of remotes) {
      out.push({
        id: `remote:${b.ref}`,
        label: `${b.remote}/${b.name}`,
        detail: b.subject,
        icon: CloudArrowDownRegular,
        run: unlessBlocked(() => switchOp('checkoutRemote', { ref: b.ref }, b.name)),
      });
    }
    for (const c of app.commits) {
      out.push({
        id: `commit:${c.sha}`,
        label: c.subject,
        detail: `${shortSha(c)} · ${c.author.name}`,
        icon: GitCommitRegular,
        run: () => {
          app.select(c.sha);
          app.reveal?.(c.sha);
        },
      });
    }
    return out;
  });

  const isSha = (q: string) => /^[0-9a-f]{4,64}$/i.test(q);

  /** A query that could be a SHA matches commits by its start only: fuzzily, it's in most SHAs somewhere. */
  function search(query: string) {
    const q = query.trim().toLowerCase();
    if (!isSha(q)) return rank(items, query, { keys: [(i) => i.label, (i) => i.detail ?? ''], limit: 200 });
    return items.filter((i) => i.id.startsWith(`commit:${q}`)).map((item) => ({ item, score: 0, field: 1, indices: [] }));
  }

  /** Any other revision (a SHA not listed, a tag, `HEAD~3`) is looked for in the branch's history. */
  function goTo(query: string): PaletteItem | null {
    if (query.startsWith('-') || /\s/.test(query)) return null;
    if (isSha(query) && app.commits.some((c) => c.sha.startsWith(query.toLowerCase()))) return null;
    return { id: 'goto', label: `Go to commit ${query}`, icon: MagnifyingGlassRegular, run: () => app.goTo(query) };
  }
</script>

<CommandPalette
  {items}
  {onclose}
  {search}
  create={goTo}
  label="Go to"
  placeholder={IS_TAURI ? 'Branch, commit or repository…' : 'Branch, commit or worktree…'}
  chooseLabel="go"
  emptyText={(q) => (!loaded ? 'Loading…' : q.trim() ? `Nothing matches “${q.trim()}”.` : 'Nothing to go to.')}
/>
