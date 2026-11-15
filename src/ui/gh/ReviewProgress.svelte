<script lang="ts">
  // Above a diff's file tree, in a diff of the pull request: how many of its files are viewed. It
  // keeps the files' marks loaded.
  import { tooltip } from 'purr';
  import type { DiffTrack } from '../lib/gh-files.svelte.ts';
  import { viewedCount } from '../lib/gh-files.ts';

  let { track, paths }: { track: DiffTrack; paths: string[] } = $props();

  $effect(() => track.load());

  const count = $derived(track.viewable && track.data ? viewedCount(paths, track.data.viewed) : null);
</script>

{#if count?.total}
  <div class="line">
    <span class:done={count.viewed === count.total} use:tooltip={`Files marked viewed on #${track.pr?.number}, as on GitHub`}>
      {count.viewed} of {count.total} files viewed
    </span>
  </div>
{/if}

<style>
  .line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2) var(--sp-4);
    align-items: center;
    white-space: nowrap;
  }

  .done {
    color: var(--success);
  }
</style>
