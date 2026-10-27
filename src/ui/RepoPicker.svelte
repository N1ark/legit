<script lang="ts">
  // The repository name in the header. It opens this repository's other worktrees, to switch to
  // one, add one or remove one; in the desktop app, the recent repositories too: pick one to
  // switch to it, or open another. Right-click a row, or the name, for its menu.
  import { ConfirmButton, Highlight, IS_TAURI, IconButton, Popover, menu, rank, toast, tooltip, type MaybeEntry } from 'purr';
  import { ArrowsLeftRight, CaretDown, Check, Copy, FolderOpen, FolderPlus, LockSimple, Trash, X } from 'purr/icons';
  import type { WorktreeInfo } from '../shared/types.ts';
  import { app, shortSha } from './lib/app.svelte.ts';
  import { invoke } from './lib/desktop.ts';
  import { startCursor } from './lib/picker.ts';
  import { tip } from './lib/tip.ts';
  import { listWorktrees, newWorktree, openWorktree, removeWorktree, removeWorktreeTip, worktreeList } from './lib/worktrees.svelte.ts';

  interface RecentRepo {
    path: string;
    name: string;
    /** "~/code/legit". */
    short: string;
    current: boolean;
  }

  /** `field` is which of the row's keys the filter matched, `indices` the characters within it. */
  type Row =
    | { kind: 'worktree'; w: WorktreeInfo; score: number; field: number; indices: number[] }
    | { kind: 'new'; score?: undefined }
    | { kind: 'recent'; r: RecentRepo; score: number; field: number; indices: number[] }
    | { kind: 'open'; score?: undefined };

  let open = $state(false);
  let list = $state<RecentRepo[] | null>(null);
  let trees = $state.raw<WorktreeInfo[] | null>(null);
  let filter = $state('');
  /** The row arrowed or hovered to; until then the cursor is on the best match. */
  let picked = $state<number | null>(null);
  /** Enter pressed before the lists loaded: choose once they have. */
  let pending = false;
  let button = $state<HTMLButtonElement>();
  let listEl = $state<HTMLElement>();

  const rows = $derived.by((): Row[] => {
    const out: Row[] = [];
    // A repository without other worktrees only offers to add one.
    if (trees && trees.length > 1) {
      const keys = [(w: WorktreeInfo) => w.name, (w: WorktreeInfo) => w.branch ?? '', (w: WorktreeInfo) => w.short];
      for (const { item, ...m } of rank(trees, filter, { keys })) out.push({ kind: 'worktree', w: item, ...m });
    }
    out.push({ kind: 'new' });
    if (!IS_TAURI) return out;
    for (const { item, ...m } of rank(list ?? [], filter, { keys: [(r) => r.name, (r) => r.short] })) out.push({ kind: 'recent', r: item, ...m });
    out.push({ kind: 'open' });
    return out;
  });

  const opens = (r: Row) => (r.kind === 'worktree' && !r.w.current && !r.w.missing) || (r.kind === 'recent' && !r.r.current);
  // With nothing matching, a filter in the app is more likely a repository to open than a branch.
  const active = $derived(
    picked === null ? startCursor(rows, opens, IS_TAURI && filter.trim() ? rows.length - 1 : 0) : Math.min(picked, rows.length - 1),
  );
  const loading = $derived(trees === null || (IS_TAURI && list === null));
  const shownTrees = $derived(rows.filter((r) => r.kind === 'worktree').length);
  const shownRecent = $derived(rows.filter((r) => r.kind === 'recent').length);

  async function load() {
    const [recent, worktrees] = await Promise.allSettled([
      IS_TAURI ? invoke<RecentRepo[]>('recent_repos') : Promise.resolve([]),
      listWorktrees(),
    ]);
    if (recent.status === 'rejected') toast.error(recent.reason);
    list = recent.status === 'fulfilled' ? recent.value : [];
    trees = worktrees.status === 'fulfilled' ? worktrees.value : [];
    if (pending && open) choose(rows[active]);
    pending = false;
  }

  export function show() {
    open = true;
    filter = '';
    picked = null;
    pending = false;
    trees = worktreeList.cached;
    load();
  }

  async function choose(r: Row | undefined) {
    if (!r) return;
    if (r.kind === 'worktree' && r.w.missing) return toast(`${r.w.short} is gone: click its bin twice to forget it.`);
    open = false;
    if (r.kind === 'new') return newWorktree();
    if (r.kind === 'worktree') {
      if (r.w.current) return;
      return openWorktree(r.w.path);
    }
    if (r.kind === 'recent' && r.r.current) return;
    if (app.switchBlocker) return toast(app.switchBlocker);
    try {
      // The app asks the page before switching (App.svelte `leave`), which keeps what it shows.
      if (r.kind === 'open') await invoke('pick_repo');
      else await invoke('open_repo', { path: r.r.path });
    } catch (e) {
      toast.error(e);
    }
  }

  async function forget(r: RecentRepo) {
    try {
      await invoke('forget_repo', { path: r.path });
      await load();
    } catch (e) {
      toast.error(e);
    }
  }

  async function remove(w: WorktreeInfo) {
    if (await removeWorktree(w)) load();
  }

  const copyPath = (path: string): MaybeEntry => ({ label: 'Copy path', icon: Copy, run: () => app.copy(path, 'the path') });

  /** A worktree's or a recent repository's menu: what its row and its buttons do. */
  function rowMenu(r: Row): MaybeEntry[] {
    if (r.kind === 'worktree') {
      const w = r.w;
      return [
        opens(r) && { label: 'Switch to it', icon: ArrowsLeftRight, run: () => choose(r) },
        copyPath(w.path),
        !w.main && !w.current && w.locked === null && 'separator',
        !w.main &&
          !w.current &&
          w.locked === null && {
            label: w.missing ? 'Forget' : 'Remove',
            icon: Trash,
            danger: true,
            note: w.missing ? 'Its folder is already gone' : `Deletes its folder${w.branch ? `; ${w.branch} stays` : ''}`,
            confirm: w.missing ? `Forget ${w.name}` : `Remove ${w.name}`,
            run: () => remove(w),
          },
      ];
    }
    if (r.kind === 'recent') {
      return [
        opens(r) && { label: 'Open', icon: FolderOpen, run: () => choose(r) },
        copyPath(r.r.path),
        'separator',
        { label: 'Remove from the list', icon: X, run: () => forget(r.r) },
      ];
    }
    return [];
  }

  function oncontextmenu(e: MouseEvent, r: Row, k: number) {
    e.preventDefault();
    picked = k;
    menu.show(e, rowMenu(r), r.kind === 'worktree' ? r.w.name : r.kind === 'recent' ? r.r.name : null);
  }

  /** This repository's menu, from a right-click on its name. */
  function buttonMenu(e: MouseEvent) {
    const root = app.repo?.root;
    menu.show(
      e,
      [
        { label: 'New worktree…', icon: FolderPlus, run: () => choose({ kind: 'new' }) },
        IS_TAURI && { label: 'Open Repository…', icon: FolderOpen, run: () => choose({ kind: 'open' }) },
        !!root && copyPath(root),
      ],
      app.repo?.name,
    );
  }

  /** Switching away is refused while something runs; adding or removing a worktree isn't. */
  const switches = (r: Row) => r.kind === 'open' || (r.kind === 'recent' && !r.r.current) || (r.kind === 'worktree' && !r.w.current && !r.w.missing);

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows.length;
      picked = (active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      listEl?.querySelector(`[data-row="${picked}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (loading && picked === null) pending = true;
      else choose(rows[active]);
    }
  }
</script>

<button
  bind:this={button}
  class="btn btn--ghost repo"
  onclick={() => (open ? (open = false) : show())}
  oncontextmenu={buttonMenu}
  aria-expanded={open}
  use:tooltip={IS_TAURI ? `${app.repo?.root} (⌘T)` : app.repo?.root}
>
  <span>{app.repo?.name}</span>
  <CaretDown />
</button>
{#if open && button}
  <Popover
    anchor={button}
    label={IS_TAURI ? 'Switch repository' : 'Worktrees'}
    onclose={() => (open = false)}
    width="min(560px, calc(100vw - 32px))"
    padding="var(--gap-4)"
    autofocus
  >
    <div class="panel">
      <input
        bind:value={filter}
        oninput={() => (picked = null)}
        {onkeydown}
        placeholder="Filter…"
        spellcheck="false"
        class="field-input"
      />
      {#if app.switchBlocker}
        <p class="blocked">{app.switchBlocker}</p>
      {/if}
      {#if trees === null}
        <p class="muted">Loading…</p>
      {/if}
      <ol bind:this={listEl} role="listbox" aria-label={IS_TAURI ? 'Worktrees and recent repositories' : 'Worktrees'}>
        {#each rows as r, k (r.kind === 'worktree' ? `w:${r.w.path}` : r.kind === 'recent' ? `r:${r.r.path}` : r.kind)}
          {#if r.kind === 'worktree' && rows[k - 1]?.kind !== 'worktree'}
            <li class="heading muted" role="presentation">Worktrees</li>
          {:else if r.kind === 'recent' && rows[k - 1]?.kind !== 'recent'}
            <li class="heading muted" role="presentation">Recent repositories</li>
          {:else if r.kind === 'open' && list && !shownRecent}
            <li class="heading muted" role="presentation">{list.length ? 'No match' : 'No recent repositories'}</li>
          {/if}
          {@const off = switches(r) && !!app.switchBlocker}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            class="row-item"
            class:is-cursor={k === active}
            class:current={(r.kind === 'worktree' && r.w.current) || (r.kind === 'recent' && r.r.current)}
            class:action={r.kind === 'new' || r.kind === 'open'}
            class:disabled={off}
            role="option"
            aria-selected={k === active}
            aria-disabled={off}
            data-row={k}
            onclick={() => choose(r)}
            oncontextmenu={(e) => oncontextmenu(e, r, k)}
            onmousemove={() => (picked = k)}
          >
            {#if r.kind === 'worktree'}
              {@const w = r.w}
              <span class="check">{#if w.current}<Check weight="bold" />{/if}</span>
              <span class="name" class:gone={w.missing}><Highlight text={w.name} indices={r.field === 0 ? r.indices : []} /></span>
              <span class="branch mono">
                {#if w.branch}<Highlight text={w.branch} indices={r.field === 1 ? r.indices : []} />{:else}detached @ {w.head ? shortSha(w.head) : '?'}{/if}
              </span>
              <span class="path muted" use:tooltip={w.path}>
                {#if w.missing}missing{:else}<Highlight text={w.short} indices={r.field === 2 ? r.indices : []} />{/if}
              </span>
              {#if w.locked !== null}
                <span class="lock muted" use:tooltip={`Locked${w.locked ? `: ${w.locked}` : ''}`}><LockSimple /></span>
              {:else if !w.main && !w.current}
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <span class="forget" onclick={(e) => e.stopPropagation()}>
                  <ConfirmButton
                    variant="ghost"
                    size="sm"
                    class="btn--danger"
                    confirmLabel={w.missing ? 'Click again to forget' : 'Click again to remove'}
                    onconfirm={() => remove(w)}
                    aria-label={w.missing ? 'Forget this worktree' : 'Remove this worktree'}
                    {@attach tip(removeWorktreeTip(w))}
                  >
                    <Trash />
                  </ConfirmButton>
                </span>
              {/if}
            {:else if r.kind === 'new'}
              <span class="check"><FolderPlus /></span>
              <span class="name" use:tooltip={'Check a branch out in a folder of its own'}>New worktree…</span>
            {:else if r.kind === 'recent'}
              {@const repo = r.r}
              <span class="check">{#if repo.current}<Check weight="bold" />{/if}</span>
              <span class="name"><Highlight text={repo.name} indices={r.field === 0 ? r.indices : []} /></span>
              <span class="path muted" use:tooltip={repo.path}><Highlight text={repo.short} indices={r.field === 1 ? r.indices : []} /></span>
              <span class="forget">
                <IconButton label="Remove from the list" size="sm" onclick={(e) => (e.stopPropagation(), forget(repo))}>
                  <X />
                </IconButton>
              </span>
            {:else}
              <span class="check"><FolderOpen /></span>
              <span class="name">Open Repository…</span>
            {/if}
          </li>
        {/each}
      </ol>
      {#if filter && trees && trees.length > 1 && !shownTrees}
        <p class="muted">No match</p>
      {/if}
    </div>
  </Popover>
{/if}

<style>
  .repo {
    font-weight: 600;
    color: var(--color2);
  }

  button.repo {
    gap: var(--gap-2);
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
  }

  p {
    margin: var(--gap-2) var(--gap-3);
  }

  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 50vh;
    overflow: auto;
  }

  li {
    cursor: pointer;
    font-size: var(--fs-base);
  }

  li.disabled {
    cursor: default;
    opacity: 0.5;
  }

  .blocked {
    font-size: var(--fs-sm);
    color: var(--warn);
  }

  li.action:not(:first-child) {
    margin-top: var(--gap-2);
    border-top: 1px solid var(--border);
  }

  li.heading {
    cursor: default;
    font-size: var(--fs-xs);
    padding: var(--sp-4) var(--gap-3) var(--gap-2);
  }

  li.heading:first-child {
    padding-top: var(--gap-2);
  }

  .branch {
    flex-shrink: 0;
    max-width: 30%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-sm);
    color: var(--color2);
  }

  .name.gone {
    color: var(--muted);
    text-decoration: line-through;
  }

  .lock {
    display: flex;
    font-size: var(--icon-sm);
  }

  .check {
    width: 14px;
    display: flex;
    flex-shrink: 0;
    font-size: var(--icon-sm);
    color: var(--theme2);
  }

  .name {
    color: var(--color2);
    flex-shrink: 0;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  li.current .name {
    color: var(--theme2);
  }

  .path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-sm);
  }

  .forget {
    visibility: hidden;
  }

  li:hover .forget,
  li.is-cursor .forget,
  .forget:focus-within {
    visibility: visible;
  }
</style>
