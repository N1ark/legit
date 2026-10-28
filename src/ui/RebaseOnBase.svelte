<script lang="ts">
  // "Rebase on main": shown when the repo's default branch (or its remote-tracking branch, whichever
  // is fresher) has commits the current branch doesn't. It fetches first.
  import { Button } from 'purr';
  import { ArrowsClockwiseRegular, GitPullRequestRegular } from 'purr/glyphs';
  import { app } from './lib/app.svelte.ts';
  import { tip } from './lib/tip.ts';

  const base = $derived(app.repo?.branch ? app.repo.base : null);
  const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;
  const title = $derived(
    !base ? ''
    : app.repo?.blocked ? `${app.repo.blocked} Finish or abort it first.`
    : `${base.name} has ${commits(base.behind)} ${app.repo?.branch} doesn't. Fetches, then replays ${app.repo?.branch}'s own commits ` +
      `on top; uncommitted changes come along unless they'd be overwritten. Stops at a conflict for you to resolve (only with no ` +
      `uncommitted changes). ⌘Z undoes it.`,
  );
</script>

{#if base?.behind || app.fetchingBase}
  <Button variant="ghost" size="sm" onclick={() => app.rebaseOnBase()} disabled={app.busy || app.fetchingBase || !!app.repo?.blocked} {@attach tip(title)}>
    {#if app.fetchingBase}
      <span class="spin"><ArrowsClockwiseRegular /></span> Fetching…
    {:else if base}
      <GitPullRequestRegular /> Rebase on {base.name} <span class="count">↓{base.behind}</span>
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
