<script lang="ts">
  // A pushed commit's CI state in its commit list row; clicking it lists its checks. Nothing when
  // it has none, or GitHub isn't there to ask.
  import { tooltip } from 'purr';
  import CheckIcon from './CheckIcon.svelte';
  import { checks } from '../lib/gh-checks.svelte.ts';
  import { ROLLUP_LABEL } from '../lib/gh-checks.ts';

  interface Props {
    sha: string;
  }
  let { sha }: Props = $props();

  $effect(() => checks.want(sha));
  const state = $derived(checks.rollups[sha]);
</script>

{#if state}
  <button
    class="checks"
    aria-label={ROLLUP_LABEL[state]}
    aria-expanded={checks.open?.sha === sha}
    use:tooltip={`${ROLLUP_LABEL[state]}: show them`}
    onclick={(e) => {
      e.stopPropagation();
      checks.show(sha, e.currentTarget);
    }}
  >
    <CheckIcon {state} dot />
  </button>
{/if}

<style>
  .checks {
    display: flex;
    flex-shrink: 0;
    font-size: var(--icon-md);
    border-radius: var(--radius-pill);
    cursor: pointer;
  }
</style>
