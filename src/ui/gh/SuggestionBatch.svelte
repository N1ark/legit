<script lang="ts">
  // Suggestions picked with "Add to batch" on pull request `number`: a button saying how many,
  // opening the list (take one out, or all), and Commit, which writes them all into your files and
  // commits them as one on the branch (their authors as co-authors), resolving their threads if asked.
  import { Button, Checkbox, IconButton, Kbd, Popover, matches } from 'purr';
  import { GitCommitRegular, XRegular } from 'purr/glyphs';
  import { app } from '../lib/app.svelte.ts';
  import { reviews } from '../lib/gh-review.svelte.ts';
  import { tip } from '../lib/tip.ts';

  interface Props {
    number: number;
  }
  let { number }: Props = $props();

  const items = $derived(reviews.batched(number));
  const why = $derived(app.busy ? 'Another operation is running.' : reviews.batchWhy(number));
  const n = $derived(items.length);
  const label = $derived(`${n} suggestion${n === 1 ? '' : 's'}`);

  let open = $state(false);
  let button = $state<HTMLElement | null>(null);
  let resolve = $state(true);
  let working = $state(false);

  async function commit() {
    if (why || working) return;
    working = true;
    if (await reviews.applyBatch(number, resolve)) open = !!reviews.batched(number).length;
    working = false;
  }

  function onkeydown(e: KeyboardEvent) {
    if (matches('⌘↩', e) && !e.isComposing) {
      e.preventDefault();
      commit();
    }
  }
</script>

{#if n}
  <span bind:this={button} class="holder">
    <Button variant="primary" aria-expanded={open} onclick={() => (open = !open)} {@attach tip('Suggestions to commit together')}>
      <GitCommitRegular /> Apply {label}
    </Button>
  </span>
  {#if open && button}
    <Popover anchor={button} placement="bottom-end" label="Suggestions to apply" onclose={() => (open = false)} width="min(480px, calc(100vw - 32px))" padding="var(--sp-4)" {onkeydown}>
      <div class="batch">
        <b>Apply {label}</b>
        <ul>
          {#each items as b (b.key)}
            <li>
              <span class="path mono">{b.path}</span>
              <span class="muted where">{b.lines.length > 1 ? `lines ${b.startLine}–${b.startLine + b.lines.length - 1}` : `line ${b.startLine}`}</span>
              <span class="muted who">{b.author?.login ?? 'ghost'}</span>
              <IconButton label="Take it out of the batch" size="sm" onclick={() => delete reviews.batch[b.key]}><XRegular /></IconButton>
            </li>
          {/each}
        </ul>
        <p class="muted">
          Writes them into your files where their lines still read the same, then commits those files as one commit on
          {app.repo?.branch ?? 'the branch'}, “Apply suggestions from code review”, with their authors as co-authors. <Kbd hint="⌘Z" /> undoes the commit.
        </p>
        <Checkbox bind:checked={resolve} label="Resolve their threads" />
        <div class="actions">
          <span class="muted why">{why ?? ''}</span>
          <Button onclick={() => (reviews.batch = Object.fromEntries(Object.entries(reviews.batch).filter(([, b]) => b.number !== number)))}>Clear</Button>
          <Button variant="primary" disabled={!!why} loading={working} onclick={commit}>Commit {label} <Kbd hint="⌘↩" /></Button>
        </div>
      </div>
    </Popover>
  {/if}
{/if}

<style>
  .holder {
    display: inline-flex;
  }

  .batch {
    display: flex;
    flex-direction: column;
    gap: var(--gap-4);
    font-size: var(--fs-sm);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  li {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    min-height: var(--btn-sm);
  }

  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color2);
  }

  .where,
  .who {
    flex-shrink: 0;
    font-size: var(--fs-xs);
  }

  p {
    margin: 0;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
  }

  .why {
    flex: 1;
  }
</style>
