<script lang="ts">
  import { Avatar, Button, ConfirmButton, Kbd, matches } from 'purr';
  import { ArrowsMerge, Trash } from 'purr/icons';
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { CommitInfo, DiffSummary } from '../shared/types.ts';
  import Coauthors from './Coauthors.svelte';
  import DiffView from './DiffView.svelte';
  import Markdown from './Markdown.svelte';
  import { app, avatarUrl, shortSha } from './lib/app.svelte.ts';
  import { formatPerson, parsePeople } from './lib/people.ts';
  import { squashDiffKey, squashFields } from './lib/squash.ts';

  /** Newest first. */
  let { commits }: { commits: CommitInfo[] } = $props();

  const editable = $derived(commits.every((c) => c.editable) && !app.repo?.blocked);
  const oldest = $derived(commits[commits.length - 1]);

  const key = $derived(commits.map((c) => c.sha).join(' '));
  // The message as it was edited, if the window comes back to this repo.
  type Kept = { key: string; subject: string; body: string; coauthors: string[] };
  const back = app.restore<Kept>('squash', (k) => k.key === untrack(() => key));

  let subject = $state(back?.subject ?? '');
  let body = $state(back?.body ?? '');
  let coauthors = $state<string[]>(back?.coauthors ?? []);
  let edited = $state(!!back);
  const people = $derived(parsePeople(coauthors));
  const valid = $derived(subject.trim() !== '' && people !== null);
  $effect(() => app.keep('squash', () => (edited ? { key, subject, body, coauthors } : null)));

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

  // The squashed commit's changes, read-only; DiffView wants a (never filled) selection per file.
  const diffKey = $derived(squashDiffKey(commits, app.commits));
  let changes = $state.raw<{ diff: DiffSummary; sel: Record<string, SvelteSet<number>> } | null>(null);
  let error = $state<string | null>(null);
  $effect(() => {
    const k = diffKey;
    error = null;
    app.diff(k).then(
      (diff) => {
        if (k === diffKey) changes = { diff, sel: Object.fromEntries(diff.files.map((f) => [f.path, new SvelteSet<number>()])) };
      },
      (e) => {
        if (k === diffKey) error = e instanceof Error ? e.message : String(e);
      },
    );
  });

  function squash() {
    if (!editable || !valid) return;
    app.squash(commits);
  }

  function onkeydown(e: KeyboardEvent) {
    if (matches('⌘↩', e)) {
      e.preventDefault();
      squash();
    }
  }
</script>

<div class="view">
  <div class="top">
    <h2><ArrowsMerge /> Squash {commits.length} commits</h2>
    <p class="muted">
      Changes are combined into <span class="mono sha">{shortSha(oldest)}</span>, the oldest selected commit, keeping its
      author and date. Commits in between are replayed on top. Below is what the squashed commit changes.
    </p>

    <ol class="picked">
      {#each commits.toReversed() as c (c.sha)}
        <li>
          <span class="mono sha">{shortSha(c)}</span>
          <Markdown text={c.subject} inline />
          <span class="muted who">
            <Avatar name={c.author.name} src={avatarUrl(c.author.email, 14)} seed={c.author.email.toLowerCase()} size={14} round />
            {c.author.name}
          </span>
        </li>
      {/each}
    </ol>

    {#if editable}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="form" {onkeydown} oninput={() => (edited = true)}>
        <input class="field-input subject" bind:value={subject} placeholder="Commit title" spellcheck="true" />
        <textarea class="field-input body" bind:value={body} placeholder="Description" rows="6" spellcheck="true"></textarea>
        <div class="people">
          <span class="muted label">Co-authors</span>
          <Coauthors bind:value={coauthors} oninput={() => (edited = true)} />
        </div>
      </div>
      <div class="actions">
        <Button variant="primary" onclick={squash} disabled={!valid || app.busy}>
          <ArrowsMerge /> Squash <Kbd hint="⌘↩" />
        </Button>
        {#if edited}
          <Button onclick={reset}>Reset message</Button>
        {/if}
        <span class="spacer"></span>
        <ConfirmButton
          variant="ghost"
          class="btn--danger"
          timeout={3000}
          confirmLabel="Click again to drop {commits.length} commits"
          onconfirm={() => app.op('drop', { shas: commits.map((c) => c.sha) })}
          disabled={app.busy}
        >
          <Trash /> Drop all
        </ConfirmButton>
      </div>
    {:else}
      <p class="muted">Some of the selected commits can't be rewritten.</p>
    {/if}
  </div>

  {#if error}
    <p class="muted note">{error}</p>
  {:else if changes}
    {#key changes.diff.sha}
      <DiffView summary={changes.diff} sel={changes.sel} readonly={true} />
    {/key}
  {:else}
    <p class="muted note">Loading changes…</p>
  {/if}
</div>

<style>
  .view {
    display: flex;
    flex-direction: column;
    min-height: 100%;
  }

  .top {
    padding: var(--sp-5) calc(var(--sp-5) + var(--sp-4));
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    border-bottom: 1px solid var(--border);
  }

  .top > * {
    max-width: 820px;
  }

  .note {
    padding: var(--sp-5);
  }

  h2 {
    display: flex;
    align-items: center;
    gap: var(--gap-4);
    margin: 0;
    font-size: var(--fs-xl);
    color: var(--color2);
  }

  h2 :global(svg) {
    color: var(--theme2);
  }

  p {
    margin: 0;
  }

  .sha {
    color: var(--theme2);
  }

  .who {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-2);
    margin-left: var(--gap-2);
  }

  .picked {
    margin: 0;
    padding: var(--gap-4) var(--sp-4) var(--gap-4) 32px;
    background: var(--bg2);
    border-radius: var(--radius);
    box-shadow: var(--box-shadow);
    display: flex;
    flex-direction: column;
    gap: var(--gap-1);
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: var(--gap-4);
  }

  .subject {
    font-size: var(--fs-xl);
    font-weight: 600;
    padding: var(--sp-3) var(--sp-4);
  }

  .body {
    field-sizing: content;
    min-height: 110px;
    max-height: 50vh;
    font-size: var(--fs-base);
    line-height: 1.5;
    padding: var(--sp-3) var(--sp-4);
  }

  .people {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--gap-3) var(--sp-4);
    align-items: start;
  }

  .label {
    padding-top: var(--gap-3);
    font-size: var(--fs-sm);
  }

  .actions {
    display: flex;
    gap: var(--gap-3);
    align-items: center;
  }

  .spacer {
    flex: 1;
  }
</style>
