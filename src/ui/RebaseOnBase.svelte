<script lang="ts">
  // "Rebase on main": shown when the repo's default branch (or its remote-tracking branch, whichever
  // is fresher) has commits the current branch doesn't. It fetches first.
  import { Button } from 'purr';
  import { ArrowsClockwise, GitPullRequest } from 'purr/icons';
  import { app } from './lib/app.svelte.ts';

  const base = $derived(app.repo?.branch ? app.repo.base : null);
  const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;
  const title = $derived(
    !base ? ''
    : app.repo?.blocked ? `${app.repo.blocked} Finish or abort it first.`
    : `${base.name} has ${commits(base.behind)} that ${app.repo?.branch} doesn't: fetch, then replay the commits only on ${app.repo?.branch} ` +
      `on top of it, in memory. Refused, changing nothing, if anything conflicts. Uncommitted changes come along unless they'd be ` +
      `overwritten. ⌘Z undoes it.`,
  );
</script>

{#if base?.behind || app.fetchingBase}
  <Button variant="ghost" size="sm" onclick={() => app.rebaseOnBase()} disabled={app.busy || app.fetchingBase || !!app.repo?.blocked} {title}>
    {#if app.fetchingBase}
      <span class="spin"><ArrowsClockwise /></span> Fetching…
    {:else if base}
      <GitPullRequest /> Rebase on {base.name} <span class="count">↓{base.behind}</span>
    {/if}
  </Button>
{/if}

<style>
  .spin {
    display: inline-flex;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .count {
    font-family: var(--mono);
    font-size: var(--fs-xs);
    opacity: 0.85;
  }
</style>
