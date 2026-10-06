<script lang="ts">
  // The repository name in the header. In the desktop app it opens the recent repositories: pick
  // one to switch to it, or open another. In the browser it's just the name.
  import { Highlight, IS_TAURI, IconButton, Popover, rank, toast } from 'purr';
  import { CaretDown, Check, FolderOpen, X } from 'purr/icons';
  import { app } from './lib/app.svelte.ts';
  import { invoke, remember } from './lib/desktop.ts';

  interface RecentRepo {
    path: string;
    name: string;
    /** "~/code/legit". */
    short: string;
    current: boolean;
  }

  let open = $state(false);
  let list = $state<RecentRepo[] | null>(null);
  let filter = $state('');
  let active = $state(0);
  let button = $state<HTMLButtonElement>();
  let listEl = $state<HTMLElement>();

  const shown = $derived(rank(list ?? [], filter, { keys: [(r) => r.name, (r) => r.short] }));
  // "Open Repository…" is the entry after the last repository.
  const count = $derived(shown.length + 1);

  async function load() {
    try {
      list = await invoke<RecentRepo[]>('recent_repos');
    } catch (e) {
      toast.error(e);
      list = [];
    }
  }

  export function show() {
    if (!IS_TAURI) return;
    open = true;
    filter = '';
    active = 0;
    load();
  }

  async function choose(k: number) {
    const r = shown[k]?.item;
    open = false;
    if (r?.current) return;
    try {
      // Coming back to this repo later finds it as it is now.
      await remember(app.snapshot());
      if (!r) await invoke('pick_repo');
      else await invoke('open_repo', { path: r.path });
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

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : count - 1)) % count;
      listEl?.children[active]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active);
    }
  }
</script>

{#if !IS_TAURI}
  <span class="repo" title={app.repo?.root}>{app.repo?.name}</span>
{:else}
  <button
    bind:this={button}
    class="btn btn--ghost repo"
    onclick={() => (open ? (open = false) : show())}
    aria-expanded={open}
    title="{app.repo?.root}: switch repository (⌘T)"
  >
    <span>{app.repo?.name}</span>
    <CaretDown />
  </button>
  {#if open && button}
    <Popover
      anchor={button}
      label="Switch repository"
      onclose={() => (open = false)}
      width="min(520px, calc(100vw - 32px))"
      padding="var(--gap-4)"
      autofocus
    >
      <div class="panel">
        <input
          bind:value={filter}
          oninput={() => (active = 0)}
          {onkeydown}
          placeholder="Filter repositories…"
          spellcheck="false"
          class="field-input"
        />
        {#if list === null}
          <p class="muted">Loading…</p>
        {:else if !shown.length}
          <p class="muted">{list.length ? 'No matching repository.' : 'No recent repositories.'}</p>
        {/if}
        <ol bind:this={listEl} role="listbox" aria-label="Recent repositories">
          {#each shown as { item: r, indices }, k (r.path)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <li
              class="row-item"
              class:is-cursor={k === active}
              class:current={r.current}
              role="option"
              aria-selected={k === active}
              onclick={() => choose(k)}
              onmousemove={() => (active = k)}
            >
              <span class="check">{#if r.current}<Check weight="bold" />{/if}</span>
              <span class="name"><Highlight text={r.name} {indices} /></span>
              <span class="path muted" title={r.path}>{r.short}</span>
              <span class="forget">
                <IconButton label="Remove from the list" size="sm" onclick={(e) => (e.stopPropagation(), forget(r))}>
                  <X />
                </IconButton>
              </span>
            </li>
          {/each}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            class="row-item open"
            class:is-cursor={active === shown.length}
            role="option"
            aria-selected={active === shown.length}
            onclick={() => choose(shown.length)}
            onmousemove={() => (active = shown.length)}
          >
            <span class="check"><FolderOpen /></span>
            <span class="name">Open Repository…</span>
          </li>
        </ol>
      </div>
    </Popover>
  {/if}
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

  li.open {
    margin-top: var(--gap-2);
    border-top: 1px solid var(--border);
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
