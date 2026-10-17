<script lang="ts">
  // One comment of a review thread: who and when, its markdown (suggestions as small diffs), its
  // reactions, and for the viewer's own, editing and deleting.
  import { Avatar, Button, IconButton, Kbd, Tag, TextArea, formatFull, formatRelative, matches, menu } from 'purr';
  import { ArrowSquareOut, Copy, DotsThree, PencilSimple, Smiley, Trash } from 'purr/icons';
  import Markdown from '../Markdown.svelte';
  import Suggestion from './Suggestion.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { reviews } from '../lib/gh-review.svelte.ts';
  import { splitSuggestions } from '../lib/gh-threads.ts';
  import type { Reaction, ReviewComment, ReviewThread } from '../../shared/gh-review.ts';

  interface Props {
    number: number;
    thread: ReviewThread;
    comment: ReviewComment;
  }
  let { number, thread, comment }: Props = $props();

  const EMOJI: Record<Reaction, string> = {
    THUMBS_UP: '👍', THUMBS_DOWN: '👎', LAUGH: '😄', HOORAY: '🎉', CONFUSED: '😕', HEART: '❤️', ROCKET: '🚀', EYES: '👀',
  };
  const NAMES: Record<Reaction, string> = {
    THUMBS_UP: 'Thumbs up', THUMBS_DOWN: 'Thumbs down', LAUGH: 'Laugh', HOORAY: 'Hooray', CONFUSED: 'Confused', HEART: 'Heart', ROCKET: 'Rocket', EYES: 'Eyes',
  };

  const parts = $derived(splitSuggestions(comment.body));
  let editing = $state<string | null>(null);
  let saving = $state(false);

  async function save() {
    if (editing === null || !editing.trim() || saving) return;
    saving = true;
    if (await reviews.edit(number, comment, editing)) editing = null;
    saving = false;
  }

  function editKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.isComposing) return;
    if (matches('⌘↩', e)) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      editing = null;
    }
  }

  function actions(e: MouseEvent) {
    menu.showFor(e.currentTarget as HTMLElement, [
      comment.canEdit && { label: 'Edit', icon: PencilSimple, run: () => (editing = comment.body) },
      { label: 'Copy link', icon: Copy, run: () => app.copy(comment.url, 'link') },
      { label: 'Open on GitHub', icon: ArrowSquareOut, run: () => app.openUrl(comment.url) },
      comment.canDelete && 'separator',
      comment.canDelete && { label: 'Delete', icon: Trash, danger: true, confirm: 'Click again to delete', run: () => reviews.remove(number, comment) },
    ]);
  }

  function react(e: MouseEvent) {
    menu.showFor(
      e.currentTarget as HTMLElement,
      (Object.keys(EMOJI) as Reaction[]).map((r) => ({
        label: `${EMOJI[r]}  ${NAMES[r]}`,
        checked: comment.reactions.some((x) => x.content === r && x.mine),
        run: () => reviews.react(number, comment, r),
      })),
    );
  }

  const who = $derived(comment.author?.login ?? 'ghost');
</script>

<div class="comment">
  <div class="head">
    <Avatar name={who} src={comment.author?.avatar} size={20} round />
    <b class="who">{who}</b>
    <span class="muted when" title={formatFull(comment.createdAt)}>{formatRelative(comment.createdAt)}</span>
    {#if comment.lastEditedAt}<span class="muted" title="Edited {formatFull(comment.lastEditedAt)}">· edited</span>{/if}
    {#if comment.pending}<Tag color="var(--warn)" label="Pending" title="Part of your review, which isn't submitted yet: only you see it" />{/if}
    <span class="spacer"></span>
    <IconButton label="React" size="sm" onclick={react}><Smiley /></IconButton>
    <IconButton label="More" size="sm" onclick={actions}><DotsThree weight="bold" /></IconButton>
  </div>
  {#if editing !== null}
    <!-- svelte-ignore a11y_autofocus -->
    <TextArea bind:value={editing} rows={4} aria-label="Edit comment" onkeydown={editKey} autofocus />
    <div class="buttons">
      <Button size="sm" variant="primary" onclick={save} loading={saving} disabled={!editing.trim()}>Save <Kbd hint="⌘↩" /></Button>
      <Button size="sm" onclick={() => (editing = null)}>Cancel <Kbd hint="Esc" /></Button>
    </div>
  {:else}
    <div class="body">
      {#each parts as p, k (k)}
        {#if 'md' in p}
          <Markdown text={p.md} images />
        {:else}
          <Suggestion {thread} lines={p.suggestion} />
        {/if}
      {/each}
    </div>
  {/if}
  {#if comment.reactions.length}
    <div class="reactions">
      {#each comment.reactions as r (r.content)}
        <button
          class="reaction"
          class:mine={r.mine}
          aria-pressed={r.mine}
          title="{NAMES[r.content]}: {r.count}{r.mine ? ', you included' : ''}"
          onclick={() => reviews.react(number, comment, r.content)}>{EMOJI[r.content]} {r.count}</button
        >
      {/each}
    </div>
  {/if}
</div>

<style>
  .comment {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    font-size: var(--fs-sm);
  }

  .who {
    color: var(--color2);
  }

  .when {
    font-size: var(--fs-xs);
  }

  .spacer {
    flex: 1;
  }

  .body {
    padding-left: calc(20px + var(--gap-3));
    font-size: var(--fs-sm);
    overflow-wrap: anywhere;
  }

  .buttons {
    display: flex;
    gap: var(--gap-3);
  }

  .reactions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-2);
    padding-left: calc(20px + var(--gap-3));
  }

  .reaction {
    padding: 0 var(--gap-3);
    border-radius: var(--radius-pill);
    border: 1px solid var(--border);
    font-size: var(--fs-xs);
    line-height: 20px;
    cursor: pointer;
  }

  .reaction:hover {
    border-color: var(--theme-mid);
  }

  .reaction.mine {
    background: var(--theme-soft);
    border-color: var(--theme-mid);
    color: var(--theme2);
  }
</style>
