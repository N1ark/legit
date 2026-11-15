<script lang="ts">
  // Beside a reviewer in the overview: ask them for another review (once they've given one), and
  // dismiss their approval or request for changes, with the message GitHub requires.
  import { Button, IconButton, Kbd, Popover, TextArea, matches } from 'purr';
  import { ArrowsClockwiseRegular, ProhibitRegular } from 'purr/glyphs';
  import type { PrOverview, PrReviewer } from '../../shared/gh-prview.ts';
  import { REVIEW_LABEL } from '../lib/gh-prview.ts';

  interface Props {
    pr: PrOverview;
    reviewer: PrReviewer;
    act: (name: string, body?: Record<string, unknown>, done?: string) => Promise<boolean>;
    working: boolean;
  }
  let { pr, reviewer: r, act, working }: Props = $props();

  const again = $derived(pr.canUpdate && !r.team && r.login !== pr.viewer && r.state !== 'requested' && r.state !== 'pending');
  const dismissable = $derived(pr.canDismiss && r.reviewId !== undefined);

  let anchor = $state<HTMLElement | null>(null);
  let message = $state('');

  async function dismiss() {
    if (!message.trim() || working) return;
    if (await act('prviewDismiss', { reviewId: r.reviewId, message }, `Dismissed ${r.login}'s review`)) {
      message = '';
      anchor = null;
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if (matches('⌘↩', e) && !e.isComposing) {
      e.preventDefault();
      dismiss();
    }
  }
</script>

{#if again}
  <IconButton
    label="Re-request review"
    tip={`Ask ${r.login} to review again`}
    size="sm"
    class="reviewer-action"
    disabled={working}
    onclick={() => act('prviewReviewers', { add: [r.login] }, `Asked ${r.login} for another review`)}><ArrowsClockwiseRegular /></IconButton
  >
{/if}
{#if dismissable}
  <IconButton
    label="Dismiss review"
    tip={`Dismiss ${r.login}'s review (${REVIEW_LABEL[r.state].toLowerCase()})`}
    size="sm"
    class="reviewer-action"
    disabled={working}
    aria-expanded={!!anchor}
    onclick={(e) => (anchor = anchor ? null : e.currentTarget)}><ProhibitRegular /></IconButton
  >
{/if}
{#if anchor}
  <Popover {anchor} placement="bottom-end" label="Dismiss review" onclose={() => (anchor = null)} width="min(360px, calc(100vw - 32px))" padding="var(--sp-4)" {onkeydown} autofocus>
    <div class="dismiss">
      <b>Dismiss {r.login}'s review</b>
      <p class="muted">It no longer counts towards merging. Say why: GitHub shows it in the conversation.</p>
      <TextArea bind:value={message} rows={3} placeholder="Why it's dismissed…" aria-label="Why it's dismissed" data-autofocus />
      <div class="actions">
        <Button variant="danger" disabled={!message.trim() || working} onclick={dismiss}><ProhibitRegular /> Dismiss review <Kbd hint="⌘↩" /></Button>
        <Button onclick={() => (anchor = null)}>Cancel</Button>
      </div>
    </div>
  </Popover>
{/if}

<style>
  .dismiss {
    display: flex;
    flex-direction: column;
    gap: var(--gap-4);
  }

  p {
    margin: 0;
    font-size: var(--fs-sm);
  }

  .actions {
    display: flex;
    gap: var(--gap-3);
  }
</style>
