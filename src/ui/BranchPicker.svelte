<script lang="ts">
  // The branch list: local branches, a "Create branch" entry for a new name, remote branches
  // without a local one, and recently deleted branches. Type to filter, ↑/↓ and ↵, or right-click
  // a row for its menu. In merge or rebase mode it lists the branches to merge or rebase onto
  // instead: local ones but the current one, and every remote one; in copy mode, the local ones to
  // cherry-pick commits onto. The arrow on a branch lists its commits the current one doesn't have,
  // to cherry-pick some here.
  import { Button, Highlight, IconButton, Kbd, Popover, formatRelative, menu, rank, toast, type MaybeEntry } from 'purr';
  import {
    ArrowCounterClockwise, ArrowLeft, ArrowsLeftRight, CaretDown, CaretRight, Check, CheckSquare, CloudArrowDown, Copy, CopySimple,
    GitBranch, GitMerge, GitPullRequest, PencilSimple, Plus, Square, Trash,
  } from 'purr/icons';
  import { SvelteSet } from 'svelte/reactivity';
  import type { BranchInfo, CommitInfo, DeletedBranch, RemoteBranchInfo } from '../shared/types.ts';
  import { app, shortSha } from './lib/app.svelte.ts';
  import {
    copyRequest, deleteBranch, deleteRemoteBranch, newBranch, renameBranch, restoreBranch, switchOp,
  } from './lib/branches.svelte.ts';
  import { integrateEntries } from './lib/integrate.ts';
  import Markdown from './Markdown.svelte';

  type Row =
    | { kind: 'local'; b: BranchInfo; indices: number[] }
    | { kind: 'create'; name: string }
    | { kind: 'remote'; b: RemoteBranchInfo; indices: number[] }
    | { kind: 'deleted'; b: DeletedBranch; indices: number[] };

  /** Deleted branches shown while the filter is empty. */
  const DELETED_SHOWN = 8;

  type Mode = 'switch' | 'merge' | 'rebase' | 'copy' | 'commits';
  let mode = $state<Mode>('switch');
  let open = $state(false);
  let local = $state<BranchInfo[] | null>(null);
  let remote = $state<RemoteBranchInfo[]>([]);
  let deleted = $state<DeletedBranch[]>([]);
  let filter = $state('');
  let active = $state(0);
  let button = $state<HTMLButtonElement>();
  let listEl = $state<HTMLElement>();
  let input = $state<HTMLInputElement>();
  /** Commits to copy to the branch picked (copy mode). */
  let copying = $state<string[]>([]);
  /** The branch whose commits are listed (commits mode), those commits, and the ones picked. */
  let browsing = $state<string | null>(null);
  let theirs = $state.raw<{ commits: CommitInfo[]; total: number } | null>(null);
  const picked = new SvelteSet<string>();

  const disabled = $derived(!!app.repo?.blocked || app.busy);
  const here = $derived(app.repo?.branch ?? null);
  const names = $derived(new Set((local ?? []).map((b) => b.name)));

  const rows = $derived.by((): Row[] => {
    if (!local) return [];
    const typed = filter.trim();
    const shown = mode === 'switch' ? local : local.filter((b) => !b.current);
    const out: Row[] = rank(shown, filter, { keys: [(b) => b.name] }).map(({ item, indices }) => ({ kind: 'local', b: item, indices }));
    if (mode === 'copy' || mode === 'commits') return out;
    if (mode !== 'switch') {
      for (const { item, indices } of rank(remote, filter, { keys: [(b) => `${b.remote}/${b.name}`] })) out.push({ kind: 'remote', b: item, indices });
      return out;
    }
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

  /** The listed branch's commits, filtered by title or SHA. */
  const commitRows = $derived(
    theirs ? rank(theirs.commits, filter, { keys: [(c) => c.subject, (c) => c.sha.slice(0, 7)] }).map(({ item }) => item) : [],
  );

  async function load() {
    const get = <T,>(path: string): Promise<T> => fetch(path).then((r) => r.json());
    if (mode === 'commits') {
      const r = await fetch(`/api/branches/commits?branch=${encodeURIComponent(browsing ?? '')}`);
      const data = await r.json();
      if (!r.ok) {
        toast.error(data.error ?? r.statusText);
        return setMode('switch');
      }
      theirs = data;
      return;
    }
    [local, remote, deleted] = await Promise.all([
      get<BranchInfo[]>('/api/branches'),
      get<RemoteBranchInfo[]>(`/api/branches/remote${mode === 'switch' ? '' : '?all=1'}`),
      get<DeletedBranch[]>('/api/branches/deleted'),
    ]);
  }

  /** Open the list to switch branch, or to pick one to merge or rebase onto (or to copy commits to). */
  export async function show(m: Mode = 'switch') {
    if (disabled) return;
    if ((m === 'merge' || m === 'rebase') && !here) return toast.error('HEAD is detached: switch to a branch first.');
    open = true;
    filter = '';
    await setMode(m);
  }

  async function setMode(m: Mode) {
    mode = m;
    active = 0;
    local = null;
    theirs = null;
    filter = '';
    await load();
    input?.focus();
  }

  // Copy to branch… in the commit list opens the list to pick the branch.
  $effect(() => {
    const shas = copyRequest.shas;
    if (!shas) return;
    copyRequest.shas = null;
    copying = shas;
    show('copy');
  });

  /** List `name`'s commits that the current branch doesn't have, to cherry-pick some. */
  function browse(name: string) {
    browsing = name;
    picked.clear();
    setMode('commits');
  }

  function togglePick(sha: string) {
    if (picked.has(sha)) picked.delete(sha);
    else picked.add(sha);
  }

  function cherryPick() {
    if (!picked.size || app.busy) return;
    open = false;
    app.sync('cherryPick', { shas: [...picked] }, undefined, true);
  }

  /** Run an action from the list; on success the list closes, or reloads with `stay`. */
  async function act(run: () => Promise<boolean>, stay = false) {
    if (!(await run())) return;
    if (stay && open) await load();
    else open = false;
  }

  function choose(r: Row | undefined) {
    if (!r) return;
    if (mode === 'copy' && r.kind === 'local') {
      open = false;
      app.sync('copyTo', { shas: copying, branch: r.b.name }, undefined, true);
    } else if (mode !== 'switch' && (r.kind === 'local' || r.kind === 'remote')) {
      open = false;
      app.sync(mode, { branch: r.kind === 'local' ? r.b.name : `${r.b.remote}/${r.b.name}` });
    } else if (r.kind === 'local') {
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
      !b.current && !!here && { label: 'Cherry-pick from it…', icon: CopySimple, run: () => browse(b.name) },
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
      !!here && { label: 'Cherry-pick from it…', icon: CopySimple, run: () => browse(short) },
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

  /** The branch a row stands for, to list its commits; null for rows without any to pick. */
  function browsable(r: Row | undefined): string | null {
    if (!here || !r) return null;
    if (r.kind === 'local') return r.b.current ? null : r.b.name;
    return r.kind === 'remote' ? `${r.b.remote}/${r.b.name}` : null;
  }

  function onkeydown(e: KeyboardEvent) {
    if (mode === 'commits') return onCommitsKey(e);
    const field = e.currentTarget as HTMLInputElement;
    if (e.key === 'ArrowRight' && mode === 'switch' && field.selectionStart === field.value.length) {
      const name = browsable(rows[active]);
      if (name) {
        e.preventDefault();
        browse(name);
      }
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows.length;
      if (n) active = (active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      listEl?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(rows[active]);
    }
  }

  function onCommitsKey(e: KeyboardEvent) {
    const n = commitRows.length;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      listEl?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      cherryPick();
    } else if (e.key === 'Enter' && commitRows[active]) {
      e.preventDefault();
      togglePick(commitRows[active].sha);
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
    label={mode === 'merge'
      ? 'Merge a branch'
      : mode === 'rebase'
        ? 'Rebase onto a branch'
        : mode === 'copy'
          ? 'Copy commits to a branch'
          : mode === 'commits'
            ? `Commits on ${browsing}`
            : 'Branches'}
    onclose={() => (open = false)}
    width="min(560px, calc(100vw - 32px))"
    padding="var(--gap-4)"
    autofocus
  >
    <div class="panel">
      {#if mode !== 'switch'}
        <div class="mode">
          <IconButton label="Back to switching branches" size="sm" onclick={() => setMode('switch')}><ArrowLeft /></IconButton>
          {#if mode === 'merge'}<GitMerge /> Merge a branch into <b class="mono">{here}</b>
          {:else if mode === 'rebase'}<GitPullRequest /> Rebase <b class="mono">{here}</b> onto a branch
          {:else if mode === 'copy'}<CopySimple /> Copy {copying.length === 1 ? '1 commit' : `${copying.length} commits`} to a branch
          {:else}<GitBranch /> Commits on <b class="mono">{browsing}</b> that <b class="mono">{here}</b> doesn't have{/if}
        </div>
      {/if}
      <input
        bind:this={input}
        bind:value={filter}
        oninput={() => (active = 0)}
        {onkeydown}
        placeholder={mode === 'merge'
          ? 'Branch to merge…'
          : mode === 'rebase'
            ? 'Branch to rebase onto…'
            : mode === 'copy'
              ? 'Branch to copy to…'
              : mode === 'commits'
                ? 'Filter commits…'
                : 'Switch to or create a branch…'}
        spellcheck="false"
        class="field-input mono"
      />
      {#if mode === 'commits'}
        {#if theirs === null}
          <p class="muted">Loading…</p>
        {:else if !commitRows.length}
          <p class="muted">{theirs.commits.length ? 'No matching commit.' : `${here} already has every commit of ${browsing}.`}</p>
        {:else}
          <ol bind:this={listEl} role="listbox" aria-label="Commits on {browsing}" aria-multiselectable="true">
            {#each commitRows as c, k (c.sha)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <li
                class="row-item commit-pick"
                class:is-cursor={k === active}
                role="option"
                aria-selected={picked.has(c.sha)}
                data-row={k}
                onclick={() => togglePick(c.sha)}
                onmousemove={() => (active = k)}
              >
                <span class="check">{#if picked.has(c.sha)}<CheckSquare weight="fill" />{:else}<Square />{/if}</span>
                <span class="sha mono">{shortSha(c.sha)}</span>
                <span class="subject" title={c.subject}><Markdown text={c.subject} inline links="off" /></span>
                <span class="when muted">{c.author.name} · {formatRelative(c.author.time * 1000)}</span>
              </li>
            {/each}
            {#if theirs.total > theirs.commits.length}
              <li class="heading muted" role="presentation">…and {theirs.total - theirs.commits.length} older</li>
            {/if}
          </ol>
        {/if}
      {:else if local === null}
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
                {@render browseButton(r)}
              {:else if r.kind === 'remote'}
                {@const b = r.b}
                <span class="check"><CloudArrowDown /></span>
                <span class="name mono"><Highlight text="{b.remote}/{b.name}" indices={r.indices} /></span>
                <span class="subject muted" title={b.subject}><Markdown text={b.subject} inline links="off" /></span>
                <span class="when muted">{formatRelative(b.time * 1000)}</span>
                {@render browseButton(r)}
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
      {#if mode === 'switch'}
        <div class="modes">
          <Button size="sm" variant="ghost" disabled={!here} onclick={() => setMode('merge')} title="Pick a branch to merge into this one (m)">
            <GitMerge /> Merge…
          </Button>
          <Button size="sm" variant="ghost" disabled={!here} onclick={() => setMode('rebase')} title="Pick a branch to rebase this one onto (r)">
            <GitPullRequest /> Rebase on…
          </Button>
        </div>
        <p class="foot muted">
          Right-click a branch to rename or delete it; its arrow (or <span class="mono">→</span>) lists its commits to cherry-pick. Switching with uncommitted changes asks whether to leave them on this branch (stashed) or
          bring them along.
        </p>
      {:else if mode === 'commits'}
        <div class="pick">
          <Button variant="primary" size="sm" disabled={!picked.size || app.busy} onclick={cherryPick}>
            <CopySimple /> Cherry-pick {picked.size ? `${picked.size} ` : ''}onto {here} <Kbd hint="⌘↩" />
          </Button>
          <span class="foot muted">
            Oldest first. In memory when nothing conflicts; otherwise a real <span class="mono">git cherry-pick</span>, which stops at
            each conflict for you to resolve (it needs no uncommitted changes). <span class="mono">⌘Z</span> undoes it.
          </span>
        </div>
      {:else if mode === 'copy'}
        <p class="foot muted">
          Cherry-picks them onto the branch without switching to it, in memory: refused, changing nothing, if anything conflicts (switch to
          it and cherry-pick there to resolve conflicts). <span class="mono">⌘Z</span> undoes it.
        </p>
      {:else if mode === 'merge'}
        <p class="foot muted">
          A real <span class="mono">git merge</span>, which needs no uncommitted changes. If it conflicts, resolve the conflicts here or abort.
          <span class="mono">⌘Z</span> undoes it.
        </p>
      {:else}
        <p class="foot muted">
          Replays the commits only on {here} on top of the branch, in memory, with uncommitted changes coming along unless they'd be
          overwritten. If a commit conflicts, it's a real <span class="mono">git rebase</span> instead, which stops at each conflict for you
          to resolve (it needs no uncommitted changes). <span class="mono">⌘Z</span> undoes it.
        </p>
      {/if}
    </div>
  </Popover>
{/if}

{#snippet browseButton(r: Row)}
  {@const name = mode === 'switch' ? browsable(r) : null}
  {#if name}
    <IconButton
      size="sm"
      label="Show the commits of {name} that {here} doesn't have"
      tip="Commits to cherry-pick (→)"
      onclick={(e) => {
        e.stopPropagation();
        browse(name);
      }}
    >
      <CaretRight />
    </IconButton>
  {/if}
{/snippet}

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

  .sha {
    color: var(--theme2);
    flex-shrink: 0;
    font-size: var(--fs-sm);
  }

  .commit-pick .subject {
    color: var(--color2);
    font-size: var(--fs-base);
  }

  .pick {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    padding-top: var(--gap-3);
    border-top: 1px solid var(--border);
  }

  .pick .foot {
    flex: 1;
    margin: 0;
  }

  .mode {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    font-size: var(--fs-sm);
    color: var(--color2);
  }

  .mode :global(svg) {
    color: var(--theme2);
  }

  .modes {
    display: flex;
    gap: var(--gap-2);
    padding-top: var(--gap-2);
    border-top: 1px solid var(--border);
  }
</style>
