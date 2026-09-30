<script lang="ts">
  import ArrowsMergeIcon from 'phosphor-svelte/lib/ArrowsMergeIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
  import { untrack } from 'svelte';
  import type { CommitInfo } from '../shared/types.ts';
  import Avatar from './Avatar.svelte';
  import Coauthors from './Coauthors.svelte';
  import { app, shortSha } from './lib/app.svelte.ts';
  import { formatPerson, parsePeople } from './lib/people.ts';
  import { squashFields } from './lib/squash.ts';

  /** Newest first. */
  let { commits }: { commits: CommitInfo[] } = $props();

  const mod = navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl';
  const editable = $derived(commits.every((c) => c.editable) && !app.repo?.blocked);
  const oldest = $derived(commits[commits.length - 1]);

  let subject = $state('');
  let body = $state('');
  let coauthors = $state<string[]>([]);
  let edited = $state(false);
  const people = $derived(parsePeople(coauthors));
  const valid = $derived(subject.trim() !== '' && people !== null);
  const key = $derived(commits.map((c) => c.sha).join(' '));

  function reset() {
    const f = squashFields(commits);
    subject = f.subject;
    body = f.body;
    coauthors = f.coauthors.map(formatPerson);
    edited = false;
  }

  // Keep the proposal in sync with the selection until the user edits it.
  $effect(() => {
    void key;
    if (!untrack(() => edited)) untrack(reset);
  });
  // The commit list's context menu squashes with the edited message too.
  $effect(() => {
    app.squashDraft = edited && people ? { key, subject, body, coauthors: people } : null;
  });

  function squash() {
    if (!editable || !valid) return;
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
      <li>
        <span class="mono sha">{shortSha(c)}</span>
        {c.subject}
        <span class="dim who"><Avatar email={c.author.email} name={c.author.name} size={14} /> {c.author.name}</span>
      </li>
    {/each}
  </ol>

  {#if editable}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="form" {onkeydown} oninput={() => (edited = true)}>
      <input class="subject" bind:value={subject} placeholder="Commit title" spellcheck="true" />
      <textarea class="body" bind:value={body} placeholder="Description" rows="6" spellcheck="true"></textarea>
      <div class="people">
        <span class="dim label">Co-authors</span>
        <Coauthors bind:value={coauthors} oninput={() => (edited = true)} />
      </div>
    </div>
    <div class="actions">
      <button class="primary" onclick={squash} disabled={!valid || app.busy}>
        <ArrowsMergeIcon size={14} /> Squash <kbd>{mod}↵</kbd>
      </button>
      {#if edited}
        <button onclick={reset}>Reset message</button>
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

  .who {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: 4px;
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

  .form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .subject {
    font-size: 16px;
    font-weight: 600;
    color: var(--color2);
    padding: 7px 10px;
  }

  .body {
    field-sizing: content;
    min-height: 110px;
    max-height: 50vh;
    line-height: 1.5;
    padding: 7px 10px;
  }

  .people {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 12px;
    align-items: start;
  }

  .label {
    padding-top: 6px;
    font-size: 12px;
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
