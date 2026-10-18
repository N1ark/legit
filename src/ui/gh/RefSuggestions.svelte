<script lang="ts">
  // The issues and pull requests suggested while typing `#…` in a field with `refComplete`; the
  // field keeps the focus (so it's no Popover, which takes it back on close) and its keys walk the list;
  // leaving the field closes it.
  import { Spinner, place } from 'purr';
  import RefIcon from './RefIcon.svelte';
  import { LIST_ID, completion } from './ref-complete.svelte.ts';

  let card = $state<HTMLElement>();
  let pos = $state<{ x: number; y: number } | null>(null);

  // Under the `#` (above it without room), placed again as the list fills.
  $effect(() => {
    void [completion.items, completion.loading];
    const at = completion.at;
    if (!card || !at) {
      pos = null;
      return;
    }
    const size = { width: card.offsetWidth, height: card.offsetHeight };
    pos = place(at, size, { width: innerWidth, height: innerHeight }, { placement: 'bottom-start', offset: 4, margin: 8 });
  });

  // The view scrolling away from the field leaves the list behind: close it.
  $effect(() => {
    const field = completion.field;
    if (!field) return;
    const scrolled = (e: Event) => e.target !== field && !card?.contains(e.target as Node) && completion.close();
    document.addEventListener('scroll', scrolled, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', scrolled, { capture: true });
  });
</script>

{#if completion.field && completion.at && (completion.loading || completion.items.length || completion.query)}
  <!-- A press here mustn't take the focus from the field. -->
  <div
    id={LIST_ID}
    class="list surface"
    class:placed={!!pos}
    role="listbox"
    aria-label="Issues and pull requests"
    tabindex="-1"
    bind:this={card}
    style:left="{pos?.x ?? 0}px"
    style:top="{pos?.y ?? 0}px"
    onmousedown={(e) => e.preventDefault()}
  >
    {#each completion.items as r, i (r.number)}
      <!-- Keys are the field's (see ref-complete.svelte.ts). -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        id="{LIST_ID}-{i}"
        class="item"
        class:is-cursor={i === completion.cursor}
        role="option"
        aria-selected={i === completion.cursor}
        tabindex="-1"
        onclick={() => completion.insert(r)}
        onmousemove={() => (completion.cursor = i)}
      >
        <RefIcon ref={r} />
        <span class="number">#{r.number}</span>
        <span class="title">{r.title}</span>
      </div>
    {:else}
      <div class="empty muted">
        {#if completion.loading}<Spinner size={12} /> Looking…{:else}No match{/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .list {
    position: fixed;
    z-index: var(--z-menu);
    width: min(420px, calc(100vw - 32px));
    max-height: 280px;
    overflow: auto;
    padding: var(--gap-2);
    box-shadow: var(--shadow-lg);
    visibility: hidden;
  }

  .list.placed {
    visibility: visible;
  }

  .item {
    display: flex;
    align-items: center;
    gap: var(--gap-4);
    min-height: var(--row-h);
    padding: var(--gap-1) var(--gap-3);
    border-radius: var(--radius);
    cursor: pointer;
    font-size: var(--fs-sm);
  }

  .item.is-cursor {
    background: var(--theme-soft);
  }

  .number {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .title {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .empty {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    padding: var(--gap-2) var(--gap-3);
    font-size: var(--fs-sm);
  }
</style>
