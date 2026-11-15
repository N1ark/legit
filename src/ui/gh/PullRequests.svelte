<script lang="ts">
  // The header's pull requests button (⇧P), with how many ask for your review: opens the inbox.
  // Also hosts what checking one out asks. The lists load again with each GitHub refresh.
  import { Badge, IconButton } from 'purr';
  import { GitPullRequestRegular } from 'purr/glyphs';
  import { untrack } from 'svelte';
  import { inbox } from '../lib/gh-inbox.svelte.ts';
  import { gh } from '../lib/github.svelte.ts';
  import PrCheckoutDialog from './PrCheckoutDialog.svelte';
  import PrInbox from './PrInbox.svelte';

  $effect(() => {
    void gh.tick;
    if (gh.ready) untrack(() => inbox.load());
  });

  const label = $derived(inbox.reviews ? `Pull requests, ${inbox.reviews} waiting for your review` : 'Pull requests');
</script>

{#if gh.status?.repo && gh.status.login}
  <span class="prs">
    <IconButton {label} shortcut="⇧P" size="lg" aria-expanded={inbox.open} onclick={() => inbox.toggle()}>
      <GitPullRequestRegular />
    </IconButton>
    {#if inbox.reviews}
      <span class="count" aria-hidden="true"><Badge count={inbox.reviews} tone="accent" max={99} /></span>
    {/if}
  </span>
{/if}
{#if inbox.open}
  <PrInbox onclose={() => (inbox.open = false)} />
{/if}
<PrCheckoutDialog />

<style>
  .prs {
    position: relative;
    display: inline-flex;
  }

  /* As on the bell: on the icon's shoulder. */
  .count {
    position: absolute;
    left: calc(50% + 2px);
    bottom: calc(50% + 1px);
    display: flex;
    pointer-events: none;
  }

  .count :global(.badge) {
    display: flex;
    align-items: center;
    justify-content: center;
    text-box: trim-both cap alphabetic;
  }
</style>
