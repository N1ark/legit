<script lang="ts">
  // A right-click menu at (x, y), kept on screen. Items are plain <button>s (and <hr>s).
  import type { Snippet } from 'svelte';

  let { x, y, onclose, children }: { x: number; y: number; onclose: () => void; children: Snippet } = $props();

  let el = $state<HTMLElement>();
  let pos = $state({ left: 0, top: 0 });
  $effect(() => {
    const w = el?.offsetWidth ?? 0;
    const h = el?.offsetHeight ?? 0;
    pos = { left: Math.max(4, Math.min(x, innerWidth - w - 4)), top: Math.max(4, Math.min(y, innerHeight - h - 4)) };
  });
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} onblur={onclose} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onclose} oncontextmenu={(e) => (e.preventDefault(), onclose())}></div>
<div class="menu" role="menu" bind:this={el} style:left="{pos.left}px" style:top="{pos.top}px">
  {@render children()}
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 49;
  }

  .menu {
    position: fixed;
    z-index: 50;
    min-width: 200px;
    padding: 4px;
    border-radius: 6px;
    background: var(--bg2);
    box-shadow: var(--box-shadow), 0 10px 30px #0005;
    display: flex;
    flex-direction: column;
    animation: menu-in 0.08s ease-out;
  }

  @keyframes menu-in {
    from {
      opacity: 0;
      transform: scale(0.97);
    }
  }

  .menu :global(button) {
    background: none;
    justify-content: flex-start;
    padding: 5px 8px;
    font-size: 12.5px;
  }

  .menu :global(button:hover:not(:disabled)) {
    background: var(--theme);
    color: #fff;
  }

  .menu :global(button:hover:not(:disabled) .dim) {
    color: #fffc;
  }

  .menu :global(hr) {
    border: none;
    border-top: 1px solid var(--border);
    margin: 4px 2px;
  }

  .menu :global(.note) {
    font-size: 11px;
    color: var(--dim);
    padding: 3px 8px 4px;
    max-width: 260px;
  }
</style>
