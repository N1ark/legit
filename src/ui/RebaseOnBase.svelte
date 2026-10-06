<script lang="ts">
  // "Rebase on main": shown when the repo's default branch (or its remote-tracking branch, whichever
  // is fresher) has commits the current branch doesn't.
  import { Button } from 'purr';
  import { GitPullRequest } from 'purr/icons';
  import { app } from './lib/app.svelte.ts';
  import { rebaseOnBase } from './lib/integrate.ts';

  const base = $derived(app.repo?.branch ? app.repo.base : null);
  const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;
  const title = $derived(
    !base ? ''
    : app.repo?.blocked ? `${app.repo.blocked} Finish or abort it first.`
    : `${base.name} has ${commits(base.behind)} that ${app.repo?.branch} doesn't: replay the commits only on ${app.repo?.branch} on top of ` +
      `it, in memory. Refused, changing nothing, if anything conflicts. Uncommitted changes come along unless they'd be overwritten. ⌘Z undoes it.`,
  );
</script>

{#if base?.behind}
  <Button variant="ghost" size="sm" onclick={rebaseOnBase} disabled={app.busy || !!app.repo?.blocked} {title}>
    <GitPullRequest /> Rebase on {base.name} <span class="count">↓{base.behind}</span>
  </Button>
{/if}

<style>
  .count {
    font-family: var(--mono);
    font-size: var(--fs-xs);
    opacity: 0.85;
  }
</style>
