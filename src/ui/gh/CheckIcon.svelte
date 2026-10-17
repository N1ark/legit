<script lang="ts">
  // A check's state as GitHub draws it: a filled tick or cross, a spinner while running, a clock while queued.
  // Decorative: whoever shows it also says the state in words.
  import { CheckCircle, CircleNotch, Clock, DotOutline, MinusCircle, Prohibit, WarningCircle, XCircle } from 'purr/icons';
  import type { CheckState, RollupState } from '../../shared/gh-checks.ts';

  interface Props {
    state: CheckState | RollupState;
    /** A rollup's "pending" (queued or running, it doesn't say) as a dot rather than a clock. */
    dot?: boolean;
  }
  let { state, dot = false }: Props = $props();
</script>

<span class="icon {state}" class:spin={state === 'running'} aria-hidden="true">
  {#if state === 'success'}<CheckCircle weight="fill" />
  {:else if state === 'failure'}<XCircle weight="fill" />
  {:else if state === 'action_required'}<WarningCircle weight="fill" />
  {:else if state === 'running'}<CircleNotch weight="bold" />
  {:else if state === 'pending' && dot}<DotOutline weight="fill" />
  {:else if state === 'pending'}<Clock weight="bold" />
  {:else if state === 'cancelled'}<Prohibit weight="bold" />
  {:else}<MinusCircle />
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
