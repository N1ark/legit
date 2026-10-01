<script lang="ts">
  // The branch list: local branches, a "Create branch" entry for a new name, remote branches
  // without a local one, and recently deleted branches. Type to filter, ↑/↓ and ↵, or right-click
  // a row for its menu.
  import { Highlight, Popover, formatRelative, menu, rank, type MaybeEntry } from 'purr';
  import {
    ArrowCounterClockwise, ArrowsLeftRight, CaretDown, Check, CloudArrowDown, Copy, GitBranch, PencilSimple, Plus, Trash,
  } from 'purr/icons';
  import type { BranchInfo, DeletedBranch, RemoteBranchInfo } from '../shared/types.ts';
  import { app, shortSha } from './lib/app.svelte.ts';
  import { deleteBranch, deleteRemoteBranch, newBranch, renameBranch, restoreBranch, switchOp } from './lib/branches.svelte.ts';
  import { integrateEntries } from './lib/integrate.ts';
  import Markdown from './Markdown.svelte';

  type Row =
    | { kind: 'local'; b: BranchInfo; indices: number[] }
    | { kind: 'create'; name: string }
    | { kind: 'remote'; b: RemoteBranchInfo; indices: number[] }
    | { kind: 'deleted'; b: DeletedBranch; indices: number[] };

  /** Deleted branches shown while the filter is empty. */
  const DELETED_SHOWN = 8;

  let open = $state(false);
  let local = $state<BranchInfo[] | null>(null);
  let remote = $state<RemoteBranchInfo[]>([]);
  let deleted = $state<DeletedBranch[]>([]);
  let filter = $state('');
  let active = $state(0);
  let button = $state<HTMLButtonElement>();
  let listEl = $state<HTMLElement>();

  const disabled = $derived(!!app.repo?.blocked || app.busy);
  const names = $derived(new Set((local ?? []).map((b) => b.name)));

  const rows = $derived.by((): Row[] => {
    if (!local) return [];
    const typed = filter.trim();
    const out: Row[] = rank(local, filter, { keys: [(b) => b.name] }).map(({ item, indices }) => ({ kind: 'local', b: item, indices }));
    if (typed && !names.has(typed) && !/\s/.test(typed)) out.push({ kind: 'create', name: typed });
    for (const { item, indices } of rank(remote, filter, { keys: [(b) => `${b.remote}/${b.name}`] })) {
      out.push({ kind: 'remote', b: item, indices });
    }
    const gone = rank(deleted, filter, { keys: [(b) => b.name] });
    for (const { item, indices } of typed ? gone : gone.slice(0, DELETED_SHOWN)) out.push({ kind: 'deleted', b: item, indices });
    return out;
  });

  const key = (r: Row) => (r.kind === 'create' ? `create:${r.name}` : r.kind === 'local' ? `local:${r.b.name}` : `${r.kind}:${r.b.ref}`);
  const HEADINGS: Partial<Record<Row['kind'], string>> = { remote: 'Remote branches', deleted: 'Recently deleted' };

  async function load() {
    const get = <T,>(path: string): Promise<T> => fetch(path).then((r) => r.json());
    [local, remote, deleted] = await Promise.all([
      get<BranchInfo[]>('/api/branches'),
      get<RemoteBranchInfo[]>('/api/branches/remote'),
      get<DeletedBranch[]>('/api/branches/deleted'),
    ]);
  }

  export async function show() {
    if (disabled) return;
    open = true;
    filter = '';
    active = 0;
    await load();
  }

  /** Run an action from the list; on success the list closes, or reloads with `stay`. */
  async function act(run: () => Promise<boolean>, stay = false) {
    if (!(await run())) return;
    if (stay && open) await load();
    else open = false;
  }

  function choose(r: Row | undefined) {
    if (!r) return;
    if (r.kind === 'local') {
      if (r.b.current) open = false;
      else act(() => switchOp('switch', { branch: r.b.name }, r.b.name));
    } else if (r.kind === 'create') act(() => switchOp('createBranch', { name: r.name }, r.name));
    else if (r.kind === 'remote') act(() => switchOp('checkoutRemote', { ref: r.b.ref }, r.b.name));
    else act(() => restoreBranch(r.b, names.has(r.b.name)), true);
  }

  const copyName = (name: string): MaybeEntry => ({ label: 'Copy name', icon: Copy, run: () => app.copy(name, 'the branch name') });

  /** A local branch's menu. Entries for other actions on a branch go in their own section. */
  function localMenu(b: BranchInfo): MaybeEntry[] {
    // Only a remote-tracking upstream (`<remote>/<branch>`); the server checks it names a remote.
    const upstream = b.upstream?.includes('/') && b.track !== 'gone' ? b.upstream : '';
    return [
      !b.current && { label: 'Switch to it', icon: ArrowsLeftRight, run: () => choose({ kind: 'local', b, indices: [] }) },
      { label: 'New branch from here…', icon: Plus, run: () => act(() => newBranch(b.sha, b.name), true) },
      { label: 'Rename…', icon: PencilSimple, run: () => act(() => renameBranch(b.name), true) },
      copyName(b.name),
      'separator',
      ...integrateEntries(b.name, b.current, () => (open = false)),
      'separator',
      {
        label: 'Delete',
        icon: Trash,
        danger: true,
        disabled: b.current,
        note: b.current ? "You're on it; switch to another branch first." : 'Kept under Recently deleted for two weeks.',
        confirm: `Delete ${b.name}`,
        run: () => act(() => deleteBranch(b.name), true),
      },
      !!upstream && {
        label: `Delete ${upstream} on the remote…`,
        icon: Trash,
        danger: true,
        note: "For everyone. Refused if it moved since you last fetched.",
        confirm: `Delete ${upstream} on the remote`,
        run: () => act(() => deleteRemoteBranch(`refs/remotes/${upstream}`), true),
      },
    ];
  }

  function remoteMenu(b: RemoteBranchInfo): MaybeEntry[] {
    const short = `${b.remote}/${b.name}`;
    return [
      { label: `Check out as ${b.name}`, icon: CloudArrowDown, run: () => choose({ kind: 'remote', b, indices: [] }) },
      { label: 'New branch from here…', icon: Plus, run: () => act(() => newBranch(b.sha, short), true) },
      copyName(short),
      'separator',
      ...integrateEntries(short, false, () => (open = false)),
      'separator',
      {
        label: `Delete on ${b.remote}…`,
        icon: Trash,
        danger: true,
        note: "For everyone. Refused if it moved since you last fetched.",
        confirm: `Delete ${short} on the remote`,
        run: () => act(() => deleteRemoteBranch(b.ref), true),
      },
    ];
  }

  function deletedMenu(b: DeletedBranch): MaybeEntry[] {
    return [
      { label: 'Restore', icon: ArrowCounterClockwise, run: () => choose({ kind: 'deleted', b, indices: [] }) },
      { label: 'Restore as…', icon: PencilSimple, run: () => act(() => restoreBranch(b, true), true) },
      { label: 'Copy SHA', icon: Copy, run: () => app.copy(b.sha, shortSha(b.sha)) },
    ];
  }

  function oncontextmenu(e: MouseEvent, r: Row, k: number) {
    active = k;
    if (r.kind === 'create') return e.preventDefault();
    const list = r.kind === 'local' ? localMenu(r.b) : r.kind === 'remote' ? remoteMenu(r.b) : deletedMenu(r.b);
    menu.show(e, list, r.kind === 'remote' ? `${r.b.remote}/${r.b.name}` : r.b.name);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows.length;
      if (n) active = (active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      listEl?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(rows[active]);
    }
  }
</script>

<button
  bind:this={button}
  class="btn btn--ghost branch"
  onclick={() => (open ? (open = false) : show())}
  {disabled}
  aria-expanded={open}
  title="Switch branch (b)"
>
  <GitBranch />
  <span>{app.repo?.branch ?? `detached @ ${app.repo?.head ? shortSha(app.repo.head) : '?'}`}</span>
  <CaretDown />
</button>
{#if open && button}
  <Popover
    anchor={button}
    label="Branches"
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
        placeholder="Switch to or create a branch…"
        spellcheck="false"
        class="field-input mono"
      />
      {#if local === null}
        <p class="muted">Loading…</p>
      {:else if !rows.length}
        <p class="muted">No matching branch.</p>
      {:else}
        <ol bind:this={listEl} role="listbox" aria-label="Branches">
          {#each rows as r, k (key(r))}
            {#if HEADINGS[r.kind] && rows[k - 1]?.kind !== r.kind}
              <li class="heading muted" role="presentation">{HEADINGS[r.kind]}</li>
            {/if}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <li
              class="row-item"
              class:is-cursor={k === active}
              class:current={r.kind === 'local' && r.b.current}
              role="option"
              aria-selected={k === active}
              data-row={k}
              onclick={() => choose(r)}
              oncontextmenu={(e) => oncontextmenu(e, r, k)}
              onmousemove={() => (active = k)}
            >
              {#if r.kind === 'create'}
                <span class="check"><Plus weight="bold" /></span>
                <span class="name">Create branch <b class="mono">{r.name}</b></span>
                <span class="subject muted">from {app.repo?.branch ?? 'HEAD'}</span>
              {:else if r.kind === 'local'}
                {@const b = r.b}
                <span class="check">{#if b.current}<Check weight="bold" />{/if}</span>
                <span class="name mono"><Highlight text={b.name} indices={r.indices} /></span>
                <span class="subject muted" title={b.subject}><Markdown text={b.subject} inline links="off" /></span>
                {#if b.track}<span class="track">{b.track}</span>{/if}
                <span class="when muted">{formatRelative(b.time * 1000)}</span>
              {:else if r.kind === 'remote'}
                {@const b = r.b}
                <span class="check"><CloudArrowDown /></span>
                <span class="name mono"><Highlight text="{b.remote}/{b.name}" indices={r.indices} /></span>
                <span class="subject muted" title={b.subject}><Markdown text={b.subject} inline links="off" /></span>
                <span class="when muted">{formatRelative(b.time * 1000)}</span>
              {:else}
                {@const b = r.b}
                <span class="check"><ArrowCounterClockwise /></span>
                <span class="name mono gone"><Highlight text={b.name} indices={r.indices} /></span>
                <span class="subject muted" title={b.subject}>{b.remote ? `deleted on ${b.remote}` : shortSha(b.sha)} · <Markdown text={b.subject} inline links="off" /></span>
                <span class="when muted">{formatRelative(b.time)}</span>
              {/if}
            </li>
          {/each}
        </ol>
      {/if}
      <p class="foot muted">
        Right-click a branch to merge it, rebase onto it, rename or delete it. Switching with uncommitted changes asks whether to leave them on
        this branch (stashed) or bring them along.
      </p>
    </div>
  </Popover>
{/if}

<style>
  .branch {
    font-family: var(--mono);
    font-weight: 400;
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

  li.heading {
    cursor: default;
    font-size: var(--fs-xs);
    padding: var(--sp-4) var(--gap-3) var(--gap-2);
  }

  .check {
    width: 12px;
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

  .name.gone {
    color: var(--muted);
    text-decoration: line-through;
  }

  li.current .name {
    color: var(--theme2);
  }

  .subject {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-sm);
  }

  .track {
    font-size: var(--fs-xs);
    color: var(--warn);
    flex-shrink: 0;
  }

  .when {
    font-size: var(--fs-xs);
    flex-shrink: 0;
  }

  .foot {
    font-size: var(--fs-xs);
  }
</style>
