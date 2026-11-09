<script lang="ts">
  // "Rebase on main": shown when the repo's default branch (or its remote-tracking branch, whichever
  // is fresher) has commits the current branch doesn't. On a fork, "Rebase on upstream/main" beside it
  // when the original repository's has commits that one lacks too. Both fetch first.
  import { Button } from 'purr';
  import { ArrowsClockwiseRegular, GitPullRequestRegular } from 'purr/glyphs';
  import { app } from './lib/app.svelte.ts';
  import { tip } from './lib/tip.ts';

  const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;
  const targets = $derived(
    !app.repo?.branch ? []
    : (['base', 'upstreamBase'] as const).flatMap((which) => {
        const base = app.repo![which];
        return base?.behind || app.fetchingBase === which ? [{ which, base }] : [];
      }),
  );
  function title(name: string, behind: number, upstream: boolean) {
    if (app.repo?.blocked) return `${app.repo.blocked} Finish or abort it first.`;
    const also = upstream && app.repo?.base ? ` (${app.repo.base.name} doesn't have them yet)` : '';
    return (
      `${name} has ${commits(behind)} ${app.repo?.branch} doesn't${also}. Fetches, then replays ${app.repo?.branch}'s own commits ` +
      `on top; uncommitted changes come along. Stops at a conflict for you to resolve. ⌘Z undoes it.`
    );
  }
</script>

{#each targets as { which, base } (which)}
  <Button
    variant="ghost"
    size="sm"
    onclick={() => app.rebaseOnBase(which)}
    disabled={app.busy || !!app.fetchingBase || !!app.repo?.blocked}
    {@attach tip(base ? title(base.name, base.behind, which === 'upstreamBase') : '')}
  >
    {#if app.fetchingBase === which}
      <span class="spin"><ArrowsClockwiseRegular /></span> Fetching…
    {:else if base}
      <GitPullRequestRegular /> Rebase on {base.name} <span class="count">↓{base.behind}</span>
    {/if}
  </Button>
{/each}

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
