<script lang="ts">
  // Above a diff's file tree, in a diff of the pull request: how many of its files are viewed, and
  // showing only the files the viewer owns. It keeps the files' marks loaded.
  import { Switch, tooltip } from 'purr';
  import { tracking, type DiffTrack } from '../lib/gh-files.svelte.ts';
  import { viewedCount } from '../lib/gh-files.ts';

  let { track, paths }: { track: DiffTrack; paths: string[] } = $props();

  $effect(() => track.load());

  const count = $derived(track.viewable && track.data ? viewedCount(paths, track.data.viewed) : null);
  const owned = $derived(track.ownsAny(paths));
</script>

{#if count?.total || owned}
  <div class="line">
    {#if count?.total}
      <span class:done={count.viewed === count.total} use:tooltip={`Files marked viewed on #${track.pr?.number}, as on GitHub`}>
        {count.viewed} of {count.total} files viewed
      </span>
    {/if}
    {#if owned}
      <label class="own" use:tooltip={`Show only the files ${track.codeowners} says you own (by name: teams aren't looked at)`}>
        <Switch label="Files you own" bind:checked={tracking.ownedOnly} />
        Files you own ({owned})
      </label>
    {/if}
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

  .own {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    cursor: pointer;
  }
</style>
