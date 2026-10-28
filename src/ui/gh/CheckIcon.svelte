<script lang="ts">
  // A check's state as GitHub draws it: a filled tick or cross, a spinner while running, a clock while queued.
  // Decorative: whoever shows it also says the state in words.
  import { CheckCircleFill, CircleNotchBold, ClockBold, DotOutlineFill, MinusCircleRegular, ProhibitBold, WarningCircleFill, XCircleFill } from 'purr/glyphs';
  import type { CheckState, RollupState } from '../../shared/gh-checks.ts';

  interface Props {
    state: CheckState | RollupState;
    /** A rollup's "pending" (queued or running, it doesn't say) as a dot rather than a clock. */
    dot?: boolean;
  }
  let { state, dot = false }: Props = $props();
</script>

<span class="icon {state}" class:spin={state === 'running'} aria-hidden="true">
  {#if state === 'success'}<CheckCircleFill />
  {:else if state === 'failure'}<XCircleFill />
  {:else if state === 'action_required'}<WarningCircleFill />
  {:else if state === 'running'}<CircleNotchBold />
  {:else if state === 'pending' && dot}<DotOutlineFill />
  {:else if state === 'pending'}<ClockBold />
  {:else if state === 'cancelled'}<ProhibitBold />
  {:else}<MinusCircleRegular />
  {/if}
</span>

<style>
  .icon {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--muted);
  }

  .success {
    color: var(--success);
  }

  .failure {
    color: var(--danger);
  }

  .action_required,
  .running,
  .pending {
    color: var(--warn);
  }

  .spin {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
