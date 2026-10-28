<script lang="ts">
  // A review thread: a bar saying where it is and who said what (a click opens or closes it), its
  // comments, and a reply box with Resolve. Resolved threads start closed.
  import { Avatar, Button, Kbd, Tag, TextArea, Twisty, matches, tooltip } from 'purr';
  import { ArrowCounterClockwiseRegular, CheckCircleRegular } from 'purr/glyphs';
  import ReviewComment from './ReviewComment.svelte';
  import { reviews } from '../lib/gh-review.svelte.ts';
  import { hunkLines, linesLabel } from '../lib/gh-threads.ts';
  import type { ReviewThread } from '../../shared/gh-review.ts';

  interface Props {
    number: number;
    thread: ReviewThread;
    /** Say which file it's on (outside the file's diff). */
    path?: boolean;
    /** Found by its line's text: the commit it was made on has been rewritten since. */
    moved?: boolean;
    /** The viewer has a review in progress: replies can go into it. */
    pending?: boolean;
    /** Where it's listed, when not in a diff: it starts closed there, and opens on its own. */
    scope?: string;
    /** Show the lines it was made on (it's not under them). */
    hunk?: boolean;
  }
  let { number, thread, path = false, moved = false, pending = false, scope = '', hunk = false }: Props = $props();
  const context = $derived(hunk ? hunkLines(thread.comments[0]?.diffHunk ?? '').slice(-4) : []);

  const open = $derived(reviews.isOpen(thread, scope));
  const first = $derived(thread.comments[0]);
  const others = $derived(new Set(thread.comments.map((c) => c.author?.login ?? 'ghost')).size);
  const excerpt = $derived(first.body.replace(/```[\s\S]*?(```|$)/g, ' [code] ').replace(/\s+/g, ' ').trim());

  let replying = $state(false);
  let sending = $state(false);
  const draft = $derived(reviews.replies[thread.id] ?? '');

  async function send(inReview: boolean) {
    if (!draft.trim() || sending) return;
    sending = true;
    if (await reviews.reply(number, thread, draft, inReview)) {
      delete reviews.replies[thread.id];
      replying = false;
    }
    sending = false;
  }

  function replyKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.isComposing) return;
    if (matches('⌘↩', e)) {
      e.preventDefault();
      send(pending);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (!draft.trim()) replying = false;
      (e.currentTarget as HTMLElement).blur();
    }
  }

  let resolving = $state(false);
  async function resolve(on: boolean) {
    resolving = true;
    await reviews.resolve(number, thread, on);
    resolving = false;
  }

  const label = $derived(linesLabel(thread));
</script>

<section class="thread" class:open class:resolved={thread.resolved} aria-label="Review thread on {thread.path}, {label}">
  <button class="bar" aria-expanded={open} onclick={() => reviews.toggle(thread, scope)}>
    <Twisty {open} size={10} />
    <Avatar name={first.author?.login ?? 'ghost'} src={first.author?.avatar} size={18} round />
    {#if path}<span class="path mono">{thread.path}</span>{/if}
    <span class="muted where">{path ? label : label[0].toUpperCase() + label.slice(1)}</span>
    {#if !open}
      <span class="excerpt"><b>{first.author?.login ?? 'ghost'}</b> {excerpt}</span>
    {:else}
      <span class="excerpt"></span>
    {/if}
    {#if thread.comments.length > 1}
      <span class="muted count">{thread.comments.length - 1} {thread.comments.length === 2 ? 'reply' : 'replies'}{others > 1 ? ` · ${others} people` : ''}</span>
    {/if}
    {#if thread.comments.some((c) => c.pending)}<Tag color="var(--warn)" label="Pending" />{/if}
    {#if thread.outdated}<span use:tooltip={'The lines it was on have changed since'}><Tag label="Outdated" /></span>{/if}
    {#if moved && !thread.outdated}
      <span use:tooltip={"Made on an earlier version of this commit; found here by the line's text"}><Tag label="Earlier version" /></span>
    {/if}
    {#if thread.resolved}
      <span use:tooltip={thread.resolvedBy ? `Resolved by ${thread.resolvedBy}` : null}
        ><Tag color="var(--success)"><span class="tag-icon"><CheckCircleRegular /> Resolved</span></Tag></span
      >
    {/if}
  </button>
  {#if open}
    {#if context.length}
      <div class="hunk mono" aria-label="The lines it was made on">
        {#each context as l, k (k)}
          <div class={l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : ''}><span class="mark">{l.kind}</span>{l.text}</div>
        {/each}
      </div>
    {/if}
    <div class="comments">
      {#each thread.comments as c (c.id)}
        <ReviewComment {number} {thread} comment={c} />
      {/each}
    </div>
    <div class="foot">
      {#if thread.canReply}
        {#if replying || draft}
          <!-- svelte-ignore a11y_autofocus -->
          <TextArea
            value={draft}
            oninput={(e) => (reviews.replies[thread.id] = e.currentTarget.value)}
            rows={3}
            placeholder="Reply…"
            aria-label="Reply"
            onkeydown={replyKey}
            autofocus={replying}
          />
          <div class="buttons">
            {#if pending}
              <Button size="sm" variant="primary" onclick={() => send(true)} loading={sending} disabled={!draft.trim()}>
                Add to review <Kbd hint="⌘↩" />
              </Button>
              <Button size="sm" onclick={() => send(false)} disabled={!draft.trim() || sending}>Reply now</Button>
            {:else}
              <Button size="sm" variant="primary" onclick={() => send(false)} loading={sending} disabled={!draft.trim()}>
                Reply <Kbd hint="⌘↩" />
              </Button>
            {/if}
            <Button size="sm" variant="ghost" onclick={() => (delete reviews.replies[thread.id], (replying = false))}>Cancel</Button>
            <span class="spacer"></span>
            {@render resolveButton()}
          </div>
        {:else}
          <div class="buttons">
            <button class="field-input reply" onclick={() => (replying = true)}>Reply…</button>
            {@render resolveButton()}
          </div>
        {/if}
      {:else}
        <div class="buttons"><span class="spacer"></span>{@render resolveButton()}</div>
      {/if}
    </div>
  {/if}
</section>

{#snippet resolveButton()}
  {#if thread.resolved && thread.canUnresolve}
    <Button size="sm" variant="ghost" onclick={() => resolve(false)} loading={resolving}><ArrowCounterClockwiseRegular /> Unresolve</Button>
  {:else if !thread.resolved && thread.canResolve}
    <Button size="sm" onclick={() => resolve(true)} loading={resolving}><CheckCircleRegular /> Resolve</Button>
  {/if}
{/snippet}

<style>
  .thread {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--box-shadow);
    font-family: var(--font);
    font-size: var(--fs-sm);
    line-height: var(--line-height);
    white-space: normal;
    color: var(--color);
    overflow: hidden;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    width: 100%;
    height: 30px;
    padding: 0 var(--gap-4);
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
  }

  .bar:hover {
    background: var(--bg2);
  }

  .bar:focus-visible {
    outline: 2px solid var(--theme2);
    outline-offset: -2px;
  }

  .open .bar {
    border-bottom: 1px solid var(--border);
  }

  .path {
    color: var(--color2);
    overflow: hidden;
    text-overflow: ellipsis;
    flex-shrink: 1;
    min-width: 40px;
  }

  .where,
  .count {
    font-size: var(--fs-xs);
    flex-shrink: 0;
  }

  .excerpt {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .resolved .excerpt {
    color: var(--muted);
  }

  .tag-icon {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-1);
    vertical-align: top;
  }

  .hunk {
    padding: var(--gap-2) 0;
    background: var(--code-bg);
    border-bottom: 1px solid var(--border);
    font-size: var(--fs-xs);
    line-height: 18px;
    white-space: pre-wrap;
    word-break: break-all;
    tab-size: 4;
  }

  .hunk .mark {
    display: inline-block;
    width: 22px;
    text-align: center;
    color: var(--muted);
  }

  .hunk .add {
    background: var(--add-bg);
  }

  .hunk .del {
    background: var(--del-bg);
  }

  .comments {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    padding: var(--gap-4) var(--sp-4);
  }

  .foot {
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
    padding: var(--gap-4) var(--sp-4);
    border-top: 1px solid var(--border);
    background: var(--bg2);
  }

  .buttons {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
  }

  .reply {
    flex: 1;
    text-align: left;
    color: var(--muted);
    cursor: text;
  }

  .spacer {
    flex: 1;
  }

  .foot :global(textarea) {
    field-sizing: content;
    min-height: 60px;
    max-height: 320px;
  }
</style>
