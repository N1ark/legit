<script lang="ts">
  // The viewer's review in progress on pull request `number`: each of its comments (where, a line
  // of it; click to show it in the diff, edit, delete), and Discard review, which deletes them all.
  // Nothing while there's none.
  import { Button, ConfirmButton, IconButton, Kbd, TextArea, matches, tooltip } from 'purr';
  import { PencilSimpleRegular, TrashRegular } from 'purr/glyphs';
  import { gh } from '../lib/github.svelte.ts';
  import { reviews } from '../lib/gh-review.svelte.ts';
  import { linesLabel, pendingOf } from '../lib/gh-threads.ts';
  import type { ReviewComment, ReviewThread } from '../../shared/gh-review.ts';

  interface Props {
    number: number;
    /** After showing a comment in the diff, or "Finish review", for a popover holding it to close. */
    ondone?: () => void;
    /** Offer "Finish review" (the overview's Review). */
    finish?: boolean;
    /** Say what it holds, listing it only when asked. */
    collapsible?: boolean;
  }
  let { number, ondone, finish = false, collapsible = false }: Props = $props();
  let listed = $state(false);

  const data = $derived(reviews.byNumber[number] ?? null);
  const mine = $derived(pendingOf(data?.threads ?? []));
  const summary = $derived(mine.items.length ? mine.summary : `${data?.pending?.comments ?? 0} comments`);
  const excerpt = (c: ReviewComment) => c.body.replace(/```[\s\S]*?(```|$)/g, ' [code] ').replace(/\s+/g, ' ').trim();

  let editing = $state<{ id: string; body: string } | null>(null);
  let busy = $state<string | null>(null);

  function show(t: ReviewThread) {
    if (reviews.show(number, t)) ondone?.();
  }

  async function save(c: ReviewComment) {
    if (!editing?.body.trim() || busy) return;
    busy = c.id;
    if (await reviews.edit(number, c, editing.body)) editing = null;
    busy = null;
  }

  async function remove(c: ReviewComment) {
    busy = c.id;
    await reviews.remove(number, c);
    busy = null;
  }

  async function discard() {
    busy = 'discard';
    await reviews.discard(number);
    busy = null;
  }

  function editKey(e: KeyboardEvent, c: ReviewComment) {
    e.stopPropagation();
    if (e.isComposing) return;
    if (matches('⌘↩', e)) {
      e.preventDefault();
      save(c);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      editing = null;
    }
  }
</script>

{#if data?.pending}
  <section class="pending" aria-label="Your pending review">
    <div class="head">
      <span class="what">
        {#if collapsible}
          Your pending review: <b>{summary}</b>
          {#if mine.items.length}
            <button class="btn btn--link" aria-expanded={listed} onclick={() => (listed = !listed)}>{listed ? 'Hide' : 'Show'}</button>
          {/if}
        {:else}
          <b>Your pending review</b>
          <span class="muted">{summary}: only you see them until you submit.</span>
        {/if}
      </span>
      <ConfirmButton size="sm" variant="ghost" class="btn--danger" timeout={3000} confirmLabel="Click again to discard" onconfirm={discard} disabled={!!busy}>
        <TrashRegular /> Discard review
      </ConfirmButton>
      {#if finish}
        <Button size="sm" variant="primary" onclick={() => (gh.showPr(number), ondone?.())}>Finish review</Button>
      {/if}
    </div>
    {#if mine.items.length && (listed || !collapsible)}
      <ul>
        {#each mine.items as { thread, comment } (comment.id)}
          {@const where = reviews.where(number, thread)}
          <li>
            {#if editing?.id === comment.id}
              <span class="path mono">{thread.path}</span>
              <!-- svelte-ignore a11y_autofocus -->
              <TextArea bind:value={editing.body} rows={3} aria-label="Edit comment" onkeydown={(e) => editKey(e, comment)} autofocus />
              <div class="buttons">
                <Button size="sm" variant="primary" onclick={() => save(comment)} loading={busy === comment.id} disabled={!editing.body.trim()}>Save <Kbd hint="⌘↩" /></Button>
                <Button size="sm" onclick={() => (editing = null)}>Cancel <Kbd hint="Esc" /></Button>
              </div>
            {:else}
              <button
                class="row"
                disabled={typeof where === 'string'}
                use:tooltip={typeof where === 'string' ? where : 'Show it in the diff'}
                onclick={() => show(thread)}
              >
                <span class="path mono">{thread.path}</span>
                <span class="muted where">{linesLabel(thread)}</span>
                <span class="excerpt">{excerpt(comment)}</span>
              </button>
              {#if comment.canEdit}
                <IconButton label="Edit" size="sm" disabled={!!busy} onclick={() => (editing = { id: comment.id, body: comment.body })}><PencilSimpleRegular /></IconButton>
              {/if}
              {#if comment.canDelete}
                <ConfirmButton size="sm" variant="ghost" class="btn--icon btn--danger" confirmLabel="Delete?" onconfirm={() => remove(comment)} disabled={!!busy} aria-label="Delete">
                  <TrashRegular />
                </ConfirmButton>
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .pending {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
    padding: var(--gap-3) var(--gap-4);
    border-radius: var(--radius);
    background: var(--theme-soft);
    font-size: var(--fs-sm);
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--gap-4);
  }

  .what {
    flex: 1;
    min-width: 0;
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
    flex-wrap: wrap;
    gap: var(--gap-2);
    min-height: var(--btn-sm);
  }

  .row {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: var(--gap-3);
    padding: var(--gap-1) var(--gap-2);
    border-radius: var(--radius);
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }

  .row:disabled {
    cursor: default;
  }

  @media (hover: hover) {
    .row:not(:disabled):hover {
      background: var(--bg2);
    }
  }

  .path {
    color: var(--color2);
    flex-shrink: 1;
    min-width: 40px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .where {
    flex-shrink: 0;
    font-size: var(--fs-xs);
  }

  .excerpt {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  li :global(textarea) {
    flex-basis: 100%;
    field-sizing: content;
    min-height: 60px;
  }

  .buttons {
    display: flex;
    gap: var(--gap-3);
  }
</style>
