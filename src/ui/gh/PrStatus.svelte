<script module lang="ts">
  import { GitMergeBold, GitMergeQueueBold, GitPullRequestBold, GitPullRequestClosedBold, GitPullRequestDraftBold, type GlyphComponent } from 'purr/glyphs';
  import type { PrState } from '../../shared/github.ts';

  /** Each state's icon and colour, as GitHub shows them: what everything showing a pull request's state draws. */
  export const PR_STATE: Record<PrState, { icon: GlyphComponent; color: string }> = {
    open: { icon: GitPullRequestBold, color: 'var(--success)' },
    draft: { icon: GitPullRequestDraftBold, color: 'var(--muted)' },
    queued: { icon: GitMergeQueueBold, color: 'var(--warn)' },
    merged: { icon: GitMergeBold, color: 'var(--theme2)' },
    closed: { icon: GitPullRequestClosedBold, color: 'var(--danger)' },
  };
</script>

<script lang="ts">
  // A pull request's state: its icon in its colour, and its number or the state's name; its label says it in words.
  import { tooltip } from 'purr';
  import { STATE_LABEL } from '../lib/gh-pr.ts';

  interface Props {
    state: PrState;
    /** Shown after the icon as `#123`. */
    number?: number;
    /** For the tooltip. */
    title?: string;
    /** `word`: the state's name after the number, unless it's open; `pill`: the icon and the name in a tinted pill. */
    look?: 'badge' | 'word' | 'pill';
    size?: number | string;
    /** Off where what it sits in has a tooltip of its own. */
    tip?: boolean;
  }
  let { state, number, title, look = 'badge', size = '1em', tip = true }: Props = $props();

  const s = $derived(PR_STATE[state]);
  const label = $derived(
    number === undefined
      ? `${STATE_LABEL[state]} pull request`
      : `Pull request #${number}, ${STATE_LABEL[state].toLowerCase()}${title ? `: ${title}` : ''}`,
  );
</script>

<span class="pr" class:pill={look === 'pill'} class:numbered={number !== undefined} style:--tone={s.color} use:tooltip={tip ? label : undefined} aria-label={label} role="img">
  <s.icon {size} />
  {#if look !== 'pill' && number !== undefined}<span class="n">#{number}</span>{/if}
  {#if look === 'pill' || (look === 'word' && state !== 'open')}<span class="name">{STATE_LABEL[state]}</span>{/if}
</span>

<style>
  .pr {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-1);
    flex-shrink: 0;
    color: var(--tone);
    white-space: nowrap;
  }

  .numbered {
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
  }

  .pill {
    gap: var(--gap-2);
    padding: var(--gap-1) var(--sp-4);
    border-radius: var(--radius-pill);
    background: color-mix(in oklab, var(--tone) 14%, transparent);
    font-size: var(--fs-sm);
  }

  .n {
    font-family: var(--mono);
  }

  .name {
    font-weight: 600;
  }
</style>
