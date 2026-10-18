<script lang="ts">
  // Review a pull request: a few words and a verdict (comment, approve, request changes). When the
  // viewer has diff comments waiting in a review of theirs, that review is the one submitted.
  import { Button, Kbd, Popover, TextArea, matches, tooltip } from 'purr';
  import { CaretDown, ChatCircle } from 'purr/icons';
  import type { PrOverview, ReviewEvent } from '../../shared/gh-prview.ts';
  import { reviewNeeds, reviewRefusal } from '../lib/gh-prview.ts';

  interface Props {
    pr: PrOverview;
    act: (name: string, body?: Record<string, unknown>, done?: string) => Promise<boolean>;
    working: boolean;
  }
  let { pr, act, working }: Props = $props();

  let open = $state(false);
  let button = $state<HTMLButtonElement | null>(null);
  let body = $state('');
  let event = $state<ReviewEvent>('COMMENT');

  const CHOICES: { id: ReviewEvent; label: string; note: string }[] = [
    { id: 'COMMENT', label: 'Comment', note: 'Without approving' },
    { id: 'APPROVE', label: 'Approve', note: 'Ready to merge' },
    { id: 'REQUEST_CHANGES', label: 'Request changes', note: 'Needs changes first' },
  ];
  const DONE: Record<ReviewEvent, string> = { COMMENT: 'Reviewed', APPROVE: 'Approved', REQUEST_CHANGES: 'Requested changes on' };

  const pending = $derived(pr.pending?.comments ?? 0);
  const refused = $derived(reviewRefusal(pr, event));
  const needs = $derived(reviewNeeds(pr, event, body));

  async function submit() {
    if (refused || needs || working) return;
    if (await act('prviewReview', { id: pr.id, event, body }, `${DONE[event]} #${pr.number}`)) {
      body = '';
      event = 'COMMENT';
      open = false;
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if (matches('⌘↩', e) && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  }
</script>

<button
  class="btn"
  class:btn--primary={pending > 0}
  bind:this={button}
  aria-expanded={open}
  use:tooltip={pending ? `${pending} pending comment${pending === 1 ? '' : 's'} to submit with a review` : 'Approve, request changes or comment'}
  onclick={() => (open = !open)}
>
  <ChatCircle /> Review{#if pending}&nbsp;<span class="count">{pending}</span>{/if}
  <CaretDown />
</button>
{#if open && button}
  <Popover
    anchor={button}
    placement="bottom-end"
    label="Review"
    onclose={() => (open = false)}
    width="min(420px, calc(100vw - 32px))"
    padding="var(--sp-4)"
    {onkeydown}
    autofocus
  >
    <div class="review">
      <b>Finish review</b>
      <TextArea bind:value={body} rows={5} placeholder="Comment…" aria-label="Review comment" data-autofocus />
      <fieldset>
        <legend class="sr-only">Verdict</legend>
        {#each CHOICES as c (c.id)}
          {@const no = reviewRefusal(pr, c.id)}
          <label class:disabled={!!no}>
            <input type="radio" name="verdict" value={c.id} bind:group={event} disabled={!!no} />
            <span>
              <span class="label">{c.label}</span>
              <span class="muted note">{no ?? c.note}</span>
            </span>
          </label>
        {/each}
      </fieldset>
      {#if pending}
        <p class="muted pending">Includes {pending} pending comment{pending === 1 ? '' : 's'} on the diff</p>
      {/if}
      <div class="actions">
        <span class="muted why">{refused ?? needs ?? ''}</span>
        <Button variant="primary" disabled={!!refused || !!needs || working} onclick={submit}>Submit review <Kbd hint="⌘↩" /></Button>
      </div>
    </div>
  </Popover>
{/if}

<style>
  .count {
    font-variant-numeric: tabular-nums;
  }

  .review {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }

  fieldset {
    display: flex;
    flex-direction: column;
    gap: var(--gap-4);
    margin: 0;
    padding: 0;
    border: none;
  }

  label {
    display: flex;
    align-items: flex-start;
    gap: var(--gap-4);
    cursor: pointer;
  }

  label.disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  input[type='radio'] {
    margin: var(--gap-1) 0 0;
    accent-color: var(--theme);
  }

  label > span {
    display: flex;
    flex-direction: column;
  }

  .label {
    font-weight: 500;
  }

  .note,
  .pending,
  .why {
    font-size: var(--fs-sm);
  }

  .pending {
    margin: 0;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--gap-4);
  }

  .why {
    flex: 1;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
