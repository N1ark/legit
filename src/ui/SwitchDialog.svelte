<script lang="ts">
  // "Leave my changes on <branch>" or "Bring my changes to <branch>", asked before switching.
  import { Button, Modal } from 'purr';
  import { app } from './lib/app.svelte.ts';
  import { question } from './lib/branches.svelte.ts';

  const w = $derived(app.repo?.work);
  const files = $derived(w ? w.staged + w.unstaged + w.untracked : 0);
</script>

{#if question.pending}
  {@const q = question.pending}
  <Modal
    label="Uncommitted changes"
    title={files ? `${files} uncommitted file${files === 1 ? '' : 's'}` : 'Uncommitted changes'}
    onclose={() => q.answer(null)}
    layer="dialog"
    width="min(440px, calc(100vw - 32px))"
    mobile="keep"
    padded
  >
    <div class="choices">
      <Button onclick={() => q.answer('leave')} disabled={!q.from}>
        <span class="choice">
          <b>Leave my changes on <span class="mono">{q.from ?? 'this commit'}</span></b>
          <span class="muted">
            {q.from ? 'Stashed, and offered back when you return' : 'Only on a branch'}
          </span>
        </span>
      </Button>
      <Button variant="primary" onclick={() => q.answer('bring')} data-autofocus>
        <span class="choice">
          <b>Bring my changes to <span class="mono">{q.to}</span></b>
          <span>Refused if they'd be overwritten</span>
        </span>
      </Button>
    </div>
  </Modal>
{/if}

<style>
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

  .choice span {
    font-size: var(--fs-xs);
    font-weight: 400;
    white-space: normal;
  }
</style>
