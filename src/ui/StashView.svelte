<script lang="ts">
  // A stash's changes (staged and unstaged together, then its untracked files), shown in place of
  // the selected commit, with what can be done with it. Esc or the close button goes back.
  import { Button, ConfirmButton, IconButton, Tag, formatAbsolute, hasOverlay, isTyping, toast } from 'purr';
  import { X } from 'purr/icons';
  import { SvelteSet } from 'svelte/reactivity';
  import type { DiffSummary } from '../shared/types.ts';
  import DiffView from './DiffView.svelte';
  import Markdown from './Markdown.svelte';
  import { type ShownStash, app, shortSha } from './lib/app.svelte.ts';

  let { stash }: { stash: ShownStash } = $props();

  let diff = $state.raw<DiffSummary | null>(null);
  let error = $state<string | null>(null);
  // Read-only, but DiffView wants a (never filled) selection per file.
  let sel: Record<string, SvelteSet<number>> = {};

  $effect(() => {
    const key = `s${stash.sha}`;
    diff = null;
    error = null;
    app.diff(key).then(
      (d) => {
        if (key !== `s${stash.sha}`) return;
        sel = Object.fromEntries(d.files.map((f) => [f.path, new SvelteSet<number>()]));
        diff = d;
      },
      (e) => (error = e instanceof Error ? e.message : String(e)),
    );
  });

  const close = () => (app.stash = null);

  async function run(op: string, done: string, closes: boolean) {
    if (!(await app.op(op, { sha: stash.sha }))) return;
    toast(done);
    if (closes) close();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.defaultPrevented || isTyping(document.activeElement) || hasOverlay()) return;
    e.preventDefault();
    close();
  }
</script>

<svelte:window {onkeydown} />

<div class="view">
  <div class="head">
    <div class="line">
      <Tag label={stash.dropped ? 'dropped stash' : 'stash'} />
      <span class="mono sha">{shortSha(stash.sha)}</span>
      <span class="muted">{formatAbsolute(stash.time)}</span>
      <span class="spacer"></span>
      {#if stash.dropped}
        <Button variant="primary" disabled={app.busy} title="Apply these changes again" onclick={() => run('stashApply', 'Applied the dropped stash', false)}>
          Apply
        </Button>
      {:else}
        <Button
          variant="primary"
          disabled={app.busy}
          title="Apply it, then remove it from the stash list"
          onclick={() => run('stashPop', 'Restored the stashed changes', true)}>Restore</Button
        >
        <Button disabled={app.busy} title="Apply it and keep it in the stash list" onclick={() => run('stashApply', 'Applied the stash; it stays in the list', false)}>
          Apply
        </Button>
        <ConfirmButton
          confirmLabel="Drop?"
          disabled={app.busy}
          onconfirm={() => run('stashDrop', 'Dropped the stash; it stays recoverable for two weeks', true)}>Drop</ConfirmButton
        >
      {/if}
      <IconButton label="Close" shortcut="Esc" onclick={close}><X /></IconButton>
    </div>
    <h2>{stash.title}</h2>
    {#if stash.message !== stash.title}<p class="muted message"><Markdown text={stash.message} inline /></p>{/if}
  </div>

  {#if error}
    <p class="muted empty">{error}</p>
  {:else if diff}
    <DiffView summary={diff} {sel} readonly={true} />
  {:else}
    <p class="muted empty">Loading changes…</p>
  {/if}
</div>

<style>
  .head {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
    padding: var(--sp-4) var(--sp-4) var(--gap-4);
    border-bottom: 1px solid var(--border);
  }

  .line {
    display: flex;
    align-items: center;
    gap: var(--gap-4);
  }

  .sha {
    color: var(--theme2);
  }

  .spacer {
    flex: 1;
  }

  h2 {
    margin: 0;
    font-size: var(--fs-xl);
    font-weight: 600;
  }

  .message {
    margin: 0;
    font-family: var(--mono);
    font-size: var(--fs-xs);
  }

  .empty {
    padding: 40px;
    text-align: center;
  }
</style>
