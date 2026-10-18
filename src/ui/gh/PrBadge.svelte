<script lang="ts">
  // A pull request's state icon and number, coloured by its state, which its label also says.
  import { tooltip } from 'purr';
  import { GitMerge, GitPullRequest, GitPullRequestClosed } from 'purr/icons';
  import { STATE_LABEL } from '../lib/gh-pr.ts';
  import type { PullRequest } from '../../shared/github.ts';

  interface Props {
    pr: PullRequest;
    /** Say the state after the number, unless it's open. */
    word?: boolean;
  }
  let { pr, word = false }: Props = $props();

  const Icon = $derived(pr.state === 'merged' ? GitMerge : pr.state === 'closed' ? GitPullRequestClosed : GitPullRequest);
  const label = $derived(`Pull request #${pr.number}, ${STATE_LABEL[pr.state].toLowerCase()}: ${pr.title}`);
</script>

<span class="pr {pr.state}" use:tooltip={label} aria-label={label} role="img">
  <Icon weight={pr.state === 'draft' ? 'regular' : 'bold'} />
  <span class="n">#{pr.number}</span>
  {#if word && pr.state !== 'open'}<span class="word">{STATE_LABEL[pr.state]}</span>{/if}
</span>

<style>
  .pr {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-1);
    flex-shrink: 0;
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .open {
    color: var(--success);
  }

  .draft {
    color: var(--muted);
  }

  .merged {
    color: var(--theme2);
  }

  .closed {
    color: var(--danger);
  }

  .n {
    font-family: var(--mono);
  }

  .word {
    font-weight: 600;
  }
</style>
