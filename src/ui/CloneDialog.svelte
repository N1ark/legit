<script lang="ts">
  // "Clone repository": a URL, or `owner/name` picked from your GitHub repositories listed under it
  // (↑/↓ and ↵, or a click, fill it in), and its folder, beside this repository by default. It
  // stays open with git's progress while cloning, then switches to the clone.
  import { Button, Highlight, Modal, TextField, formatRelative, rank, toast } from 'purr';
  import { GitForkRegular, LockSimpleRegular } from 'purr/glyphs';
  import { cloneName } from '../shared/clone.ts';
  import type { CloneInfo, GithubRepoInfo } from '../shared/types.ts';
  import { app, request } from './lib/app.svelte.ts';
  import { cloning, openCloned } from './lib/clone.svelte.ts';
  import { ghRequest } from './lib/github.svelte.ts';
  import { progressSummary } from './lib/progress.ts';

  let url = $state('');
  let path = $state('');
  let info = $state.raw<CloneInfo | null>(null);
  let repos = $state.raw<GithubRepoInfo[] | null>(null);
  let reposError = $state<string | null>(null);
  /** The listed repository ↑/↓ moved to, -1 for none. */
  let cursor = $state(-1);
  let busy = $state(false);
  let listEl = $state<HTMLElement>();

  // Fresh fields each time it opens; the lists load while it shows.
  $effect.pre(() => {
    if (!cloning.open) return;
    url = path = '';
    cursor = -1;
    busy = false;
    let live = true;
    request<CloneInfo>('/api/clone/info').then(
      (i) => live && (info = i),
      () => {},
    );
    reposError = null;
    ghRequest<GithubRepoInfo[]>('myRepos').then(
      (r) => live && (repos = r),
      (e: Error) => live && (reposError = e.message),
    );
    return () => (live = false);
  });

  const typed = $derived(url.trim());
  const rows = $derived(repos ? rank(repos, typed, { keys: [(r) => r.fullName, (r) => r.description ?? ''] }).slice(0, 50) : []);
  const name = $derived(cloneName(typed));
  const progress = $derived(Object.values(app.progress).filter((p) => p.op === 'clone'));

  function close() {
    if (!busy) cloning.open = false;
  }

  function pick(r: GithubRepoInfo) {
    url = r.fullName;
    cursor = -1;
  }

  async function confirm() {
    if (!typed || busy) return;
    busy = true;
    try {
      const r = await request<{ path: string }>('/api/clone', { url: typed, path: path.trim() || undefined });
      cloning.open = false;
      await openCloned(r.path);
    } catch (e) {
      toast.error(e);
    } finally {
      busy = false;
    }
  }

  function onkeydown(e: KeyboardEvent) {
    const inUrl = e.target instanceof HTMLInputElement && e.target.dataset.url !== undefined;
    if (inUrl && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && rows.length) {
      e.preventDefault();
      const n = rows.length + 1;
      cursor = ((cursor + 1 + (e.key === 'ArrowDown' ? 1 : n - 1)) % n) - 1;
      listEl?.querySelector(`[data-row="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      if (inUrl && rows[cursor]) pick(rows[cursor].item);
      else confirm();
    }
  }
</script>

{#if cloning.open}
  <Modal label="Clone repository" title="Clone repository" onclose={close} layer="dialog" align="top" width="min(480px, calc(100vw - 32px))" mobile="keep" padded {onkeydown}>
    <div class="form">
      <div>
        <TextField
          label="Repository"
          bind:value={url}
          oninput={() => (cursor = -1)}
          placeholder={repos?.length ? 'Pick one below, or give a URL' : 'owner/name, or a URL'}
          spellcheck="false"
          autocomplete="off"
          disabled={busy}
          hint={reposError ? `Any URL works; to list your GitHub repositories here: ${reposError}` : undefined}
          data-url
          data-autofocus
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls="clone-repos"
        />
        {#if repos === null && !reposError}
          <p class="muted loading">Loading your GitHub repositories…</p>
        {:else if rows.length && !busy}
          <ol id="clone-repos" bind:this={listEl} role="listbox" aria-label="Your GitHub repositories">
            {#each rows as r, k (r.item.fullName)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <li
                class="row-item"
                class:is-cursor={k === cursor}
                class:is-current={r.item.fullName === typed}
                role="option"
                aria-selected={k === cursor}
                data-row={k}
                title={r.item.description ?? undefined}
                onmousedown={(e) => e.preventDefault()}
                onclick={() => pick(r.item)}
              >
                <span class="name mono"><Highlight text={r.item.fullName} indices={r.field === 0 ? r.indices : []} /></span>
                {#if r.item.private}<span class="icon muted" aria-label="Private"><LockSimpleRegular /></span>{/if}
                {#if r.item.fork}<span class="icon muted" aria-label="Fork"><GitForkRegular /></span>{/if}
                <span class="muted when">{r.item.pushedAt ? formatRelative(r.item.pushedAt) : ''}</span>
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
        disabled={busy}
        placeholder={info ? `${info.parent}/${name || 'name'}` : ''}
        hint={info ? `Relative to ${info.parent}; ~ is your home folder.` : undefined}
      />
      {#if busy}
        <p class="muted status" role="status">{progress.length ? progressSummary(progress) : 'Cloning…'}</p>
      {/if}
    </div>
    {#snippet footer()}
      <Button onclick={close} disabled={busy}>Cancel</Button>
      <Button variant="primary" disabled={!typed || busy} onclick={confirm}>{busy ? 'Cloning…' : 'Clone'}</Button>
    {/snippet}
  </Modal>
{/if}

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }

  p {
    margin: var(--gap-2) 0 0;
    font-size: var(--fs-sm);
  }

  ol {
    list-style: none;
    margin: var(--gap-2) 0 0;
    padding: 0;
    max-height: calc(var(--row-h) * 8);
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

  .icon {
    display: flex;
    flex-shrink: 0;
    font-size: var(--icon-sm);
  }

  .when {
    flex-shrink: 0;
    font-size: var(--fs-xs);
  }
</style>
