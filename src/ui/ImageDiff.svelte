<script module lang="ts">
  import { persisted } from 'purr';

  type Mode = 'side' | 'slider' | 'onion';
  // One choice for every image, kept across diffs.
  const mode = persisted<Mode>('legit:image-mode', 'side');
</script>

<script lang="ts">
  // An image file before and after: side by side, or one over the other with a slider or an onion skin.
  import { Segmented } from 'purr';

  let {
    before,
    after,
    note,
    height,
    last,
  }: {
    /** URLs of the two versions; null for a side without the file. */
    before: string | null;
    after: string | null;
    /** Sizes and such, shown above. */
    note: string;
    /** Fixed, so the diff's layout is known before anything loads. */
    height: number;
    /** Nothing below it in the file: round its bottom corners. */
    last: boolean;
  } = $props();

  let at = $state(50);
  const both = $derived(!!before && !!after);
  const shown = $derived(both ? mode.value : 'side');
</script>

<div class="images" class:last style:height="{height}px">
  <div class="bar">
    <span class="muted">{note}</span>
    <span class="spacer"></span>
    {#if both}
      {#if shown !== 'side'}
        <input
          class="range"
          type="range"
          min="0"
          max="100"
          bind:value={at}
          aria-label={shown === 'slider' ? 'Where the new version starts' : 'Opacity of the new version'}
        />
      {/if}
      <Segmented
        label="Compare images"
        size="sm"
        options={[
          { id: 'side', label: 'Side by side' },
          { id: 'slider', label: 'Slider' },
          { id: 'onion', label: 'Onion skin' },
        ]}
        bind:value={mode.value}
      />
    {/if}
  </div>
  {#if shown === 'side'}
    <div class="sides">
      {#each [['Before', before], ['After', after]] as [label, src] (label)}
        {#if src}
          <figure>
            <div class="stage"><img {src} alt="{label}" draggable="false" decoding="async" /></div>
            {#if both}<figcaption class="muted">{label}</figcaption>{/if}
          </figure>
        {/if}
      {/each}
    </div>
  {:else}
    <div class="stage over">
      <img src={before} alt="Before" draggable="false" decoding="async" />
      <div
        class="layer"
        style:clip-path={shown === 'slider' ? `inset(0 0 0 ${at}%)` : undefined}
        style:opacity={shown === 'onion' ? at / 100 : undefined}
      >
        <img src={after} alt="After" draggable="false" decoding="async" />
      </div>
      {#if shown === 'slider'}<span class="handle" style:left="{at}%"></span>{/if}
    </div>
  {/if}
</div>

<style>
  .images {
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
    padding: var(--gap-3) var(--sp-4) var(--sp-4);
    box-sizing: border-box;
    background: var(--code-bg);
  }

  .images.last {
    border-radius: 0 0 var(--radius) var(--radius);
  }

  .bar {
    display: flex;
    align-items: center;
    gap: var(--gap-4);
    font-size: var(--fs-sm);
  }

  .spacer {
    flex: 1;
  }

  .range {
    width: 160px;
    accent-color: var(--theme2);
  }

  .sides {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: var(--sp-4);
  }

  figure {
    flex: 1;
    min-width: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
  }

  figcaption {
    font-size: var(--fs-xs);
    text-align: center;
  }

  /* A checkerboard, so transparency shows. */
  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
    border-radius: var(--radius);
    box-shadow: inset 0 0 0 1px var(--border);
    background: repeating-conic-gradient(var(--bg3) 0 25%, var(--bg2) 0 50%) 0 0 / 16px 16px;
    overflow: hidden;
  }

  .layer {
    position: absolute;
    inset: 0;
  }

  /* At its own size, centred, shrunk only to fit: the two sides line up when their sizes match. */
  .stage img {
    position: absolute;
    inset: 0;
    margin: auto;
    max-width: calc(100% - 2 * var(--gap-3));
    max-height: calc(100% - 2 * var(--gap-3));
    object-fit: contain;
    user-select: none;
  }

  .handle {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    margin-left: -1px;
    background: var(--theme2);
    pointer-events: none;
  }
</style>
