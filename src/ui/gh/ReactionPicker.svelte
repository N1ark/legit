<script lang="ts">
  // GitHub's eight reactions as a 4×2 grid of emoji, hung off `anchor`: the arrows move in both
  // directions, Enter or Space toggles one (and closes it); the viewer's own show pressed.
  import { Popover, tooltip } from 'purr';
  import type { Reaction } from '../../shared/gh-review.ts';
  import { EMOJI, REACTIONS, REACTION_NAMES, gridStep } from '../lib/gh-reactions.ts';

  interface Props {
    anchor: HTMLElement;
    /** The viewer's reactions. */
    mine: Reaction[];
    onpick: (r: Reaction) => void;
    onclose: () => void;
  }
  let { anchor, mine, onpick, onclose }: Props = $props();

  const COLS = 4;
  let focused = $state(Math.max(0, REACTIONS.findIndex((r) => mine.includes(r))));
  let cells: HTMLButtonElement[] = [];

  function onkeydown(e: KeyboardEvent) {
    const next = gridStep(focused, e.key, COLS, REACTIONS.length);
    if (next === null) return;
    e.preventDefault();
    focused = next;
    cells[next]?.focus();
  }

  function pick(r: Reaction) {
    onpick(r);
    onclose();
  }
</script>

<Popover {anchor} label="React" {onclose} layer="menu" placement="bottom-end" padding="var(--gap-3)" walk={false} autofocus>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="grid" role="group" aria-label="Reactions" {onkeydown}>
    {#each REACTIONS as r, i (r)}
      <button
        bind:this={cells[i]}
        class="cell"
        class:is-on={mine.includes(r)}
        aria-label={REACTION_NAMES[r]}
        aria-pressed={mine.includes(r)}
        tabindex={i === focused ? 0 : -1}
        data-autofocus={i === focused ? '' : undefined}
        use:tooltip={REACTION_NAMES[r]}
        onfocus={() => (focused = i)}
        onclick={() => pick(r)}>{EMOJI[r]}</button
      >
    {/each}
  </div>
</Popover>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(4, auto);
    gap: var(--gap-2);
  }

  .cell {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: calc(var(--btn) + var(--gap-3));
    height: calc(var(--btn) + var(--gap-3));
    border: 1px solid transparent;
    border-radius: var(--radius);
    font-size: var(--fs-lg);
    line-height: 1;
    cursor: pointer;
  }

  @media (hover: hover) {
    .cell:hover {
      background: var(--control-hover);
    }
  }

  .cell:focus-visible {
    outline: 2px solid var(--theme2);
    outline-offset: -2px;
  }

  .cell.is-on {
    background: var(--theme-soft);
    border-color: var(--theme-mid);
  }
</style>
