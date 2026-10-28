<script lang="ts">
  // A new comment on lines of a diff: markdown, "Suggest" for the new side's lines, then
  // posted alone or into the viewer's review (starting one). ⌘↵ does the first, Esc cancels.
  import { Button, Kbd, TextArea, matches } from 'purr';
  import { ChatCircleTextRegular, NotePencilRegular, XRegular } from 'purr/glyphs';
  import { type DiffReview, type Draft, reviews } from '../lib/gh-review.svelte.ts';
  import { suggestionBlock } from '../lib/gh-threads.ts';
  import { tip } from '../lib/tip.ts';

  interface Props {
    review: DiffReview;
    draft: Draft;
  }
  let { review, draft }: Props = $props();

  let sending = $state<'now' | 'review' | null>(null);
  let textarea = $state<HTMLTextAreaElement | null>(null);
  const pending = $derived(review.data?.pending ?? null);
  const lines = $derived(draft.startLine !== undefined && draft.startLine !== draft.line ? `lines ${draft.startLine}–${draft.line}` : `line ${draft.line}`);
  const why = $derived('why' in review.target ? review.target.why : null);

  async function send(inReview: boolean) {
    if (!draft.body.trim() || sending || why) return;
    sending = inReview ? 'review' : 'now';
    await review.submit(draft, inReview);
    sending = null;
  }

  function cancel() {
    delete reviews.drafts[draft.id];
  }

  function key(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.isComposing) return;
    if (matches('⌘↩', e)) {
      e.preventDefault();
      send(!!pending);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  }

  /** Put a suggestion block with the lines' text where the caret is. */
  function suggest() {
    if (!draft.suggest || !textarea) return;
    const block = suggestionBlock(draft.suggest);
    const { selectionStart: a, selectionEnd: b, value } = textarea;
    const before = value.slice(0, a);
    const pad = before && !before.endsWith('\n') ? '\n' : '';
    draft.body = `${before}${pad}${block}\n${value.slice(b)}`;
    const caret = before.length + pad.length + block.indexOf('\n') + 1;
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(caret, caret + (draft.suggest?.join('\n').length ?? 0));
    });
  }

  function focusFirst(el: HTMLElement) {
    requestAnimationFrame(() => el.querySelector('textarea')?.focus({ preventScroll: true }));
  }
</script>

<section class="composer" aria-label="New comment on {draft.path}, {lines}" {@attach focusFirst}>
  <div class="head">
    <ChatCircleTextRegular />
    <span>Comment on {lines}</span>
    {#if draft.suggest}
      <span class="spacer"></span>
      <Button size="sm" variant="ghost" onclick={suggest} {@attach tip("Insert a suggestion block with these lines' text, to edit into what they should be")}>
        <NotePencilRegular /> Suggest
      </Button>
    {/if}
  </div>
  <TextArea bind:value={draft.body} bind:textarea rows={4} placeholder="Comment…" aria-label="Comment" onkeydown={key} mono={false} />
  <div class="buttons">
    {#if pending}
      <Button size="sm" variant="primary" onclick={() => send(true)} loading={sending === 'review'} disabled={!draft.body.trim() || !!why} {@attach tip(why)}>
        Add to review <Kbd hint="⌘↩" />
      </Button>
      <Button size="sm" onclick={() => send(false)} loading={sending === 'now'} disabled={!draft.body.trim() || !!why} {@attach tip(why ?? 'Post it now, on its own')}>
        Comment now
      </Button>
    {:else}
      <Button size="sm" variant="primary" onclick={() => send(false)} loading={sending === 'now'} disabled={!draft.body.trim() || !!why} {@attach tip(why)}>
        Comment <Kbd hint="⌘↩" />
      </Button>
      <Button
        size="sm"
        onclick={() => send(true)}
        loading={sending === 'review'}
        disabled={!draft.body.trim() || !!why}
        {@attach tip(why ?? 'Keep it in a review only you see, to submit with your other comments')}
      >
        Start a review
      </Button>
    {/if}
    <span class="spacer"></span>
    <Button size="sm" variant="ghost" onclick={cancel}><XRegular /> Cancel <Kbd hint="Esc" /></Button>
  </div>
  {#if why}<p class="muted why">{why}</p>{/if}
</section>

<style>
  .composer {
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
    padding: var(--gap-4) var(--sp-4);
    border: 1px solid var(--theme-mid);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--box-shadow);
    font-family: var(--font);
    font-size: var(--fs-sm);
    line-height: var(--line-height);
    white-space: normal;
    color: var(--color);
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    color: var(--theme2);
    min-height: 26px;
  }

  .buttons {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
  }

  .spacer {
    flex: 1;
  }

  .composer :global(textarea) {
    field-sizing: content;
    min-height: 80px;
    max-height: 320px;
  }

  .why {
    margin: 0;
    font-size: var(--fs-xs);
  }
</style>
