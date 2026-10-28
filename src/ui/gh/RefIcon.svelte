<script lang="ts">
  // An issue's or pull request's state as GitHub draws it: its icon, in its colour, named in words.
  import { CheckCircleBold, IssueOpenedBold, ProhibitBold } from 'purr/glyphs';
  import { refStateWords } from '../lib/gh-links.ts';
  import PrStatus from './PrStatus.svelte';
  import type { IssueRef } from '../../shared/gh-issues.ts';

  interface Props {
    ref: Pick<IssueRef, 'state' | 'isPullRequest' | 'notPlanned'>;
    size?: number | string;
  }
  let { ref, size = '1em' }: Props = $props();

  const Icon = $derived(ref.state === 'open' ? IssueOpenedBold : ref.notPlanned ? ProhibitBold : CheckCircleBold);
  // A completed issue is purple like a merged pull request; one not planned is grey like a draft.
  const tone = $derived(ref.state === 'open' ? 'open' : ref.notPlanned ? 'draft' : 'merged');
</script>

{#if ref.isPullRequest}
  <span class="ref-icon"><PrStatus state={ref.state} {size} tip={false} /></span>
{:else}
  <span class="ref-icon {tone}" role="img" aria-label={refStateWords(ref)}><Icon {size} /></span>
{/if}

<style>
  .ref-icon {
    display: inline-flex;
    flex-shrink: 0;
  }

  .open {
    color: var(--success);
  }

  .merged {
    color: var(--theme2);
  }

  .draft {
    color: var(--muted);
  }
</style>
