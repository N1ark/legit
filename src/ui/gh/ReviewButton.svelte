<script lang="ts">
  // Above a diff of the current branch's pull request: its review threads (unresolved count, and
  // the viewer's pending comments), opening the threads panel. It keeps the threads loaded.
  import { Button, Popover } from 'purr';
  import { ChatsCircleRegular } from 'purr/glyphs';
  import ReviewThreads from './ReviewThreads.svelte';
  import { gh } from '../lib/github.svelte.ts';
  import { reviews } from '../lib/gh-review.svelte.ts';
  import { tip } from '../lib/tip.ts';

  const pr = $derived(reviews.pr);
  const data = $derived(pr ? (reviews.byNumber[pr.number] ?? null) : null);
  const unresolved = $derived(data?.threads.filter((t) => !t.resolved).length ?? 0);

  $effect(() => {
    void gh.tick;
    if (pr) reviews.load(pr.number);
  });

  let open = $state(false);
  let button = $state<HTMLElement | null>(null);
</script>

{#if pr && data && (data.threads.length || data.pending)}
  <span bind:this={button} class="holder">
    <Button
      variant="ghost"
      aria-expanded={open}
      onclick={() => (open = !open)}
      {@attach tip(`Review threads of #${pr.number}${data.pending ? `; ${data.pending.comments} of your comments are pending` : ''}`)}
    >
      <ChatsCircleRegular />
      {unresolved ? `${unresolved} unresolved` : `${data.threads.length} resolved`}
      {#if data.pending}<span class="pending">· {data.pending.comments} pending</span>{/if}
    </Button>
  </span>
  {#if open && button}
    <Popover
      anchor={button}
      placement="bottom-end"
      label="Review threads"
      onclose={() => (open = false)}
      width="min(640px, calc(100vw - 32px))"
      maxHeight="75vh"
      padding="var(--sp-4)"
    >
      <ReviewThreads number={pr.number} ondone={() => (open = false)} />
    </Popover>
  {/if}
{/if}

<style>
  .holder {
    display: inline-flex;
  }

  .pending {
    color: var(--warn);
  }
</style>
