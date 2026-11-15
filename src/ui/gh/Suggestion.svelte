<script lang="ts">
  // A ```suggestion block: the lines it was made on as removed, the suggestion as added, a button
  // applying it to the working tree's file (only where those lines still read the same), and one
  // adding it to the batch committed together (see SuggestionBatch).
  import { Button } from 'purr';
  import { FileArrowDownRegular, ListPlusRegular } from 'purr/glyphs';
  import { reviews } from '../lib/gh-review.svelte.ts';
  import { commentedLines } from '../lib/gh-threads.ts';
  import { tip } from '../lib/tip.ts';
  import type { ReviewComment, ReviewThread } from '../../shared/gh-review.ts';

  interface Props {
    number: number;
    thread: ReviewThread;
    comment: ReviewComment;
    /** Which block of the comment it is. */
    index: number;
    lines: string[];
  }
  let { number, thread, comment, index, lines }: Props = $props();

  const before = $derived(commentedLines(thread));
  const startLine = $derived(
    (thread.line !== null ? (thread.startLine ?? thread.line) : (thread.originalStartLine ?? thread.originalLine)) ?? 1,
  );
  let applying = $state(false);
  const key = $derived(`${thread.id}:${comment.id}:${index}`);
  const batched = $derived(!!reviews.batch[key]);

  function batch() {
    if (!before) return;
    reviews.toggleBatch({ key, number, threadId: thread.id, author: comment.author, path: thread.path, startLine, lines: before, replacement: lines });
  }

  async function apply() {
    if (!before) return;
    applying = true;
    await reviews.apply(thread.path, startLine, before, lines);
    applying = false;
  }
</script>

<div class="suggestion">
  <div class="head">
    <span>Suggested change</span>
    <span class="spacer"></span>
    <Button
      size="sm"
      variant="ghost"
      onclick={apply}
      loading={applying}
      disabled={!before}
      {@attach tip(
        before
          ? `Replace ${before.length === 1 ? 'this line' : `these ${before.length} lines`} in your copy of ${thread.path}, if unchanged; it shows in your uncommitted changes`
          : "Only suggestions on the new side's lines can be applied",
      )}
    >
      <FileArrowDownRegular /> Apply
    </Button>
    <Button
      size="sm"
      variant="ghost"
      onclick={batch}
      pressed={batched}
      disabled={!before}
      {@attach tip(before ? (batched ? 'Take it out of the batch' : 'Commit it together with other suggestions, in one commit') : null)}
    >
      <ListPlusRegular /> {batched ? 'In batch' : 'Add to batch'}
    </Button>
  </div>
  <div class="lines mono">
    {#each before ?? [] as l, k (k)}
      <div class="line del"><span class="mark" aria-label="removed">-</span>{l}</div>
    {/each}
    {#each lines as l, k (k)}
      <div class="line add"><span class="mark" aria-label="added">+</span>{l}</div>
    {:else}
      <div class="line note muted">Removes {before?.length === 1 ? 'the line' : 'the lines'}</div>
    {/each}
  </div>
</div>

<style>
  .suggestion {
    margin: var(--gap-3) 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    padding: var(--gap-1) var(--gap-2) var(--gap-1) var(--gap-4);
    background: var(--bg3);
    font-size: var(--fs-xs);
    color: var(--muted);
  }

  .spacer {
    flex: 1;
  }

  .lines {
    background: var(--code-bg);
    font-size: var(--fs-sm);
    line-height: 19px;
  }

  .line {
    white-space: pre-wrap;
    word-break: break-all;
    tab-size: 4;
    padding: 0 var(--gap-4) 0 22px;
    text-indent: -22px;
  }

  .mark {
    display: inline-block;
    width: 22px;
    text-align: center;
    user-select: none;
  }

  .add {
    background: var(--add-bg);
  }

  .add .mark {
    color: var(--add);
  }

  .del {
    background: var(--del-bg);
  }

  .del .mark {
    color: var(--del);
  }

  .note {
    text-indent: 0;
    font-family: inherit;
  }
</style>
