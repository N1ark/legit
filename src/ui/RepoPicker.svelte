<script lang="ts">
  // The repository name in the header. It opens this repository's other worktrees, to switch to
  // one, add one or remove one; in the desktop app, the recent repositories too: pick one to
  // switch to it, or open another.
  import { Highlight, IS_TAURI, IconButton, Popover, rank, toast } from 'purr';
  import { CaretDown, Check, FolderOpen, FolderPlus, LockSimple, Trash, X } from 'purr/icons';
  import type { WorktreeInfo } from '../shared/types.ts';
  import { app, shortSha } from './lib/app.svelte.ts';
  import { invoke } from './lib/desktop.ts';
  import { listWorktrees, newWorktree, openWorktree, removeWorktree } from './lib/worktrees.svelte.ts';

  interface RecentRepo {
    path: string;
    name: string;
    /** "~/code/legit". */
    short: string;
    current: boolean;
  }

  type Row =
    | { kind: 'worktree'; w: WorktreeInfo; indices: number[] }
    | { kind: 'new' }
    | { kind: 'recent'; r: RecentRepo; indices: number[] }
    | { kind: 'open' };

  let open = $state(false);
  let list = $state<RecentRepo[] | null>(null);
  let trees = $state<WorktreeInfo[] | null>(null);
  let filter = $state('');
  let active = $state(0);
  let button = $state<HTMLButtonElement>();
  let listEl = $state<HTMLElement>();

  const rows = $derived.by((): Row[] => {
    const out: Row[] = [];
    // A repository without other worktrees only offers to add one.
    if (trees && trees.length > 1) {
      const keys = [(w: WorktreeInfo) => w.name, (w: WorktreeInfo) => w.branch ?? '', (w: WorktreeInfo) => w.short];
      for (const { item, indices } of rank(trees, filter, { keys })) out.push({ kind: 'worktree', w: item, indices });
    }
    out.push({ kind: 'new' });
    if (!IS_TAURI) return out;
    for (const { item, indices } of rank(list ?? [], filter, { keys: [(r) => r.name, (r) => r.short] })) out.push({ kind: 'recent', r: item, indices });
    out.push({ kind: 'open' });
    return out;
  });
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
  }

  export function show() {
    open = true;
    filter = '';
    active = 0;
    load();
  }

  async function choose(r: Row | undefined) {
    if (!r) return;
    open = false;
    if (r.kind === 'new') return newWorktree();
    if (r.kind === 'worktree') {
      if (r.w.current) return;
      if (r.w.missing) return removeWorktree(r.w);
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
    open = false;
    if (await removeWorktree(w)) show();
  }

  /** Switching away is refused while something runs; adding or removing a worktree isn't. */
  const switches = (r: Row) => r.kind === 'open' || (r.kind === 'recent' && !r.r.current) || (r.kind === 'worktree' && !r.w.current && !r.w.missing);

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows.length;
      active = (active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      listEl?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(rows[active]);
    }
  }
</script>

<button
  bind:this={button}
  class="btn btn--ghost repo"
  onclick={() => (open ? (open = false) : show())}
  aria-expanded={open}
  title={IS_TAURI ? `${app.repo?.root}: switch repository or worktree (⌘T)` : `${app.repo?.root}: worktrees`}
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
        oninput={() => (active = 0)}
        {onkeydown}
        placeholder={IS_TAURI ? 'Filter repositories and worktrees…' : 'Filter worktrees…'}
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
            <li class="heading muted" role="presentation">{list.length ? 'No matching repository.' : 'No recent repositories.'}</li>
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
            onmousemove={() => (active = k)}
          >
            {#if r.kind === 'worktree'}
              {@const w = r.w}
              <span class="check">{#if w.current}<Check weight="bold" />{/if}</span>
              <span class="name" class:gone={w.missing}><Highlight text={w.name} indices={r.indices} /></span>
              <span class="branch mono">{w.branch ?? `detached @ ${w.head ? shortSha(w.head) : '?'}`}</span>
              <span class="path muted" title={w.path}>{w.missing ? 'missing' : w.short}</span>
              {#if w.locked !== null}
                <span class="lock muted" title="Locked{w.locked ? `: ${w.locked}` : ''}"><LockSimple /></span>
              {:else if !w.main && !w.current}
                <span class="forget">
                  <IconButton label={w.missing ? 'Forget this worktree' : 'Remove this worktree…'} size="sm" onclick={(e) => (e.stopPropagation(), remove(w))}>
                    <Trash />
                  </IconButton>
                </span>
              {/if}
            {:else if r.kind === 'new'}
              <span class="check"><FolderPlus /></span>
              <span class="name">New worktree…</span>
              {#if trees && trees.length < 2}<span class="path muted">Check a branch out in a folder of its own</span>{/if}
            {:else if r.kind === 'recent'}
              {@const repo = r.r}
              <span class="check">{#if repo.current}<Check weight="bold" />{/if}</span>
              <span class="name"><Highlight text={repo.name} indices={r.indices} /></span>
              <span class="path muted" title={repo.path}>{repo.short}</span>
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
        <p class="muted">No matching worktree.</p>
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
  li.is-cursor .forget {
    visibility: visible;
  }
</style>
