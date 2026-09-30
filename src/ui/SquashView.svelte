<script lang="ts">
  import ArrowsMergeIcon from 'phosphor-svelte/lib/ArrowsMergeIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
  import { untrack } from 'svelte';
  import type { CommitInfo } from '../shared/types.ts';
  import { combinedMessage } from './lib/squash.ts';
  import { app, shortSha } from './lib/app.svelte.ts';

  /** Newest first. */
  let { commits }: { commits: CommitInfo[] } = $props();

  const mod = navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl';
  const editable = $derived(commits.every((c) => c.editable) && !app.repo?.blocked);
  const oldest = $derived(commits[commits.length - 1]);

  let message = $state('');
  let edited = $state(false);
  const key = $derived(commits.map((c) => c.sha).join(' '));
  // The commit list's context menu squashes with this message too.
  $effect(() => {
    app.squashDraft = edited ? { key, message } : null;
  });
  // Keep the proposed message in sync with the selection until the user edits it.
  $effect(() => {
    const m = combinedMessage(commits);
    if (!untrack(() => edited)) message = m;
  });

  function squash() {
    if (!editable || !message.trim()) return;
    app.squash(commits);
  }

  let confirmDrop = $state(false);
  function drop() {
    if (!confirmDrop) {
      confirmDrop = true;
      setTimeout(() => (confirmDrop = false), 3000);
    } else app.op('drop', { shas: commits.map((c) => c.sha) });
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      squash();
    }
  }
</script>

<div class="view">
  <h2><ArrowsMergeIcon size={18} /> Squash {commits.length} commits</h2>
  <p class="dim">
    Changes are combined into <span class="mono sha">{shortSha(oldest)}</span>, the oldest selected commit, keeping its
    author and date. Commits in between are replayed on top.
  </p>

  <ol class="picked">
    {#each commits.toReversed() as c (c.sha)}
      <li><span class="mono sha">{shortSha(c)}</span> {c.subject} <span class="dim">· {c.author.name}</span></li>
    {/each}
  </ol>

  {#if editable}
    <textarea bind:value={message} oninput={() => (edited = true)} {onkeydown} rows="10" spellcheck="true"></textarea>
    <div class="actions">
      <button class="primary" onclick={squash} disabled={!message.trim() || app.busy}>
        <ArrowsMergeIcon size={14} /> Squash <kbd>{mod}↵</kbd>
      </button>
      {#if edited}
        <button onclick={() => { edited = false; message = combinedMessage(commits); }}>Reset message</button>
      {/if}
      <span class="spacer"></span>
      <button class="ghost danger" class:confirm={confirmDrop} onclick={drop} disabled={app.busy}>
        <TrashIcon size={15} />{confirmDrop ? `Click again to drop ${commits.length} commits` : 'Drop all'}
      </button>
    </div>
  {:else}
    <p class="dim">Some of the selected commits can't be rewritten.</p>
  {/if}
</div>

<style>
  .view {
    padding: 20px 24px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-width: 820px;
  }

  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 16px;
    color: var(--color2);
  }

  h2 :global(svg) {
    color: var(--theme);
  }

  p {
    margin: 0;
  }

  .sha {
    color: var(--theme);
  }

  .picked {
    margin: 0;
    padding: 8px 12px 8px 32px;
    background: var(--bg2);
    border-radius: 4px;
    box-shadow: var(--box-shadow);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  textarea {
    field-sizing: content;
    min-height: 160px;
    line-height: 1.5;
    padding: 8px 10px;
  }

  .actions {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .spacer {
    flex: 1;
  }

  .confirm {
    color: var(--del);
    background: var(--del-bg);
  }
</style>
