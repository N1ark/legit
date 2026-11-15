<script lang="ts">
  // Asked before checking out a pull request whose branch here has diverged from it: reset the
  // branch to it (its own commits kept in Backups), or check it out on another branch.
  import { Button, Modal } from 'purr';
  import { checkouts } from '../lib/gh-checkout.svelte.ts';

  const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;
</script>

{#if checkouts.pending}
  {@const { plan, answer } = checkouts.pending}
  <Modal
    label="The branch has diverged"
    title={`${plan.branch} has diverged from #${plan.number}`}
    onclose={() => answer(null)}
    layer="dialog"
    width="min(460px, calc(100vw - 32px))"
    mobile="keep"
    padded
  >
    <p class="muted why">
      It has {commits(plan.ahead)} the pull request doesn't, and the pull request has {commits(plan.behind)} it doesn't.
    </p>
    <div class="choices">
      <Button onclick={() => answer('reset')}>
        <span class="choice">
          <b>Reset <span class="mono">{plan.branch}</span> to #{plan.number}</b>
          <span class="muted">{plan.ahead === 1 ? 'Its commit is' : `Its ${plan.ahead} commits are`} kept in Backups{plan.current ? '; ⌘Z undoes it' : ''}</span>
        </span>
      </Button>
      <Button variant="primary" onclick={() => answer('other')} data-autofocus>
        <span class="choice">
          <b>Check it out as <span class="mono">{plan.alternative}</span></b>
          <span><span class="mono">{plan.branch}</span> stays as it is</span>
        </span>
      </Button>
    </div>
  </Modal>
{/if}

<style>
  .why {
    margin: 0 0 var(--sp-4);
    font-size: var(--fs-sm);
  }

  .choices {
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
  }

  .choices :global(.btn) {
    height: auto;
    justify-content: flex-start;
    text-align: left;
    padding: var(--gap-3) var(--sp-4);
  }

  .choice {
    display: flex;
    flex-direction: column;
    gap: var(--gap-1);
    min-width: 0;
  }

  .choice > span {
    font-size: var(--fs-xs);
    font-weight: 400;
    white-space: normal;
  }
</style>
