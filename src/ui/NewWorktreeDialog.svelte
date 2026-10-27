<script lang="ts">
  // "New worktree": the branch, typed (an existing local one, or a new one) or picked from the
  // local branches not checked out anywhere, listed under it (↑/↓ and ↵, or a click, fill it in),
  // and its folder. Branching from a given commit (a remote branch) lists none.
  import { Button, Checkbox, Highlight, Modal, TextField, formatRelative, rank } from 'purr';
  import type { BranchInfo } from '../shared/types.ts';
  import { app } from './lib/app.svelte.ts';
  import { lists } from './lib/branches.svelte.ts';
  import { worktreeQuestion } from './lib/worktrees.svelte.ts';

  const q = $derived(worktreeQuestion.pending);

  let branch = $state('');
  let path = $state('');
  let open = $state(true);
  let branches = $state.raw<BranchInfo[] | null>(null);
  /** The listed branch ↑/↓ moved to, -1 for none. */
  let cursor = $state(-1);
  let listEl = $state<HTMLElement>();

  // Fresh fields each time it's asked, before the dialog renders.
  $effect.pre(() => {
    const p = worktreeQuestion.pending;
    if (!p) return;
    branch = p.start.branch ?? '';
    path = '';
    open = true;
    cursor = -1;
    branches = lists.local.cached;
    let live = true;
    lists.local.load().then(
      (b) => live && (branches = b),
      () => {},
    );
    return () => (live = false);
  });

  const from = $derived(q?.start.what ?? app.repo?.branch ?? 'HEAD');
  const name = $derived(branch.trim());
  const existing = $derived(branches?.find((b) => b.name === name));
  const rows = $derived(
    q?.start.from || !branches ? [] : rank(branches.filter((b) => !b.current && !b.worktree), name, { keys: [(b) => b.name] }),
  );
  const error = $derived(
    !existing
      ? undefined
      : q?.start.from
        ? 'A branch by that name already exists'
        : existing.current
          ? "It's checked out here"
          : existing.worktree
            ? `It's checked out in ${existing.worktree.split(/[\\/]/).pop()}`
            : undefined,
  );
  const hint = $derived(error ? undefined : existing ? 'Existing branch' : `New branch from ${from}`);

  function confirm() {
    if (name && !error) q?.answer({ branch: name, path: path.trim(), open });
  }

  function pick(b: BranchInfo) {
    branch = b.name;
    cursor = -1;
  }

  function onkeydown(e: KeyboardEvent) {
    const inBranch = e.target instanceof HTMLInputElement && e.target.dataset.branch !== undefined;
    if (inBranch && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && rows.length) {
      e.preventDefault();
      const n = rows.length + 1;
      cursor = ((cursor + 1 + (e.key === 'ArrowDown' ? 1 : n - 1)) % n) - 1;
      listEl?.querySelector(`[data-row="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      if (inBranch && rows[cursor]) pick(rows[cursor].item);
      else confirm();
    }
  }
</script>

{#if q}
  <Modal label="New worktree" title="New worktree" onclose={() => q.answer(null)} layer="dialog" align="top" width="min(420px, calc(100vw - 32px))" mobile="keep" padded {onkeydown}>
    <div class="form">
      <div>
        <TextField
          label="Branch"
          bind:value={branch}
          oninput={() => (cursor = -1)}
          placeholder={rows.length ? 'Pick one below, or name a new one' : 'my-feature'}
          spellcheck="false"
          autocomplete="off"
          {hint}
          {error}
          data-branch
          data-autofocus="select"
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls="worktree-branches"
        />
        {#if rows.length}
          <ol id="worktree-branches" bind:this={listEl} role="listbox" aria-label="Local branches">
            {#each rows as r, k (r.item.name)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <li
                class="row-item"
                class:is-cursor={k === cursor}
                class:is-current={r.item.name === name}
                role="option"
                aria-selected={k === cursor}
                data-row={k}
                onmousedown={(e) => e.preventDefault()}
                onclick={() => pick(r.item)}
              >
                <span class="name mono"><Highlight text={r.item.name} indices={r.indices} /></span>
                <span class="muted">{formatRelative(r.item.time * 1000)}</span>
              </li>
            {/each}
          </ol>
        {/if}
      </div>
      <TextField
        label="Folder"
        bind:value={path}
        spellcheck="false"
        autocomplete="off"
        placeholder={`Next to the repository, as ${app.repo?.name ?? 'repo'}-<branch>`}
        hint="Relative to this worktree's folder; ~ is your home folder."
      />
      <Checkbox label="Switch to it" bind:checked={open} />
    </div>
    {#snippet footer()}
      <Button onclick={() => q.answer(null)}>Cancel</Button>
      <Button variant="primary" disabled={!name || !!error} onclick={confirm}>Create worktree</Button>
    {/snippet}
  </Modal>
{/if}

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }

  ol {
    list-style: none;
    margin: var(--gap-2) 0 0;
    padding: 0;
    max-height: calc(var(--row-h) * 6);
    overflow: auto;
  }

  li {
    cursor: pointer;
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  li .muted {
    flex-shrink: 0;
    font-size: var(--fs-xs);
  }
</style>
