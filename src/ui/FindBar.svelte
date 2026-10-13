<script lang="ts">
  // The find bar over the diff (⌘F): ↵ / ⇧↵ (or ⌘G / ⇧⌘G) for the next and previous match, esc closes.
  import { IconButton, registerOverlay } from 'purr';
  import { CaretDown, CaretUp, X } from 'purr/icons';
  import { finder } from './lib/finder.svelte.ts';

  let input: HTMLInputElement;
  const total = $derived(finder.total);

  $effect(() => registerOverlay(() => finder.close()));

  $effect(() => {
    void finder.focusTick;
    input.focus();
    input.select();
  });

  // Matches arrive as files load: the first one is shown once there is one.
  $effect(() => {
    void total;
    // Outside the effect: showing a match may expand a file and lay it out at once.
    queueMicrotask(() => finder.settle());
  });

  function key(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      finder.step(e.shiftKey ? -1 : 1);
    }
  }
</script>

<div class="find" role="search">
  <input
    bind:this={input}
    class="field-input"
    type="text"
    placeholder="Find in diff"
    aria-label="Find in diff"
    spellcheck="false"
    value={finder.query}
    oninput={(e) => finder.search(e.currentTarget.value)}
    onkeydown={key}
  />
  <span class="count muted" aria-live="polite">
    {#if finder.query}{total ? `${Math.min(finder.current, total - 1) + 1}/${total}` : 'No matches'}{/if}
  </span>
  <IconButton label="Previous match" shortcut="⇧⌘G" size="sm" disabled={!total} onclick={() => finder.step(-1)}>
    <CaretUp />
  </IconButton>
  <IconButton label="Next match" shortcut="⌘G" size="sm" disabled={!total} onclick={() => finder.step(1)}>
    <CaretDown />
  </IconButton>
  <IconButton label="Close" shortcut="Esc" size="sm" onclick={() => finder.close()}><X /></IconButton>
</div>

<style>
  .find {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    padding: var(--gap-2) var(--gap-3);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow-lg);
  }

  input {
    width: 220px;
  }

  .count {
    min-width: 72px;
    font-size: var(--fs-xs);
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
</style>
