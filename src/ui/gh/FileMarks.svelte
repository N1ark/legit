<script lang="ts">
  // In a file's header in a diff of the pull request: its code owners (the viewer's own marked),
  // CI's annotations on its lines (a click goes to the first), and the Viewed toggle.
  import { Tag, tooltip } from 'purr';
  import { CheckSquareFill, SquareRegular } from 'purr/glyphs';
  import NoteIcon from './NoteIcon.svelte';
  import { reviews } from '../lib/gh-review.svelte.ts';
  import type { DiffTrack } from '../lib/gh-files.svelte.ts';
  import { describeNotes } from '../lib/gh-files.ts';
  import type { RowsLike } from '../lib/gh-threads.ts';

  interface Props {
    track: DiffTrack;
    path: string;
    /** The file's rows, once in: annotations on lines they don't show are said so. */
    rows?: RowsLike;
    /** Mark it viewed (true) or not, from its toggle. */
    onviewed: (on: boolean) => void;
  }
  let { track, path, rows, onviewed }: Props = $props();

  const owners = $derived(track.owners(path));
  const mine = $derived(track.mine(path));
  const counts = $derived(track.counts(path));
  const viewed = $derived(track.viewed(path));

  const ownersTip = $derived.by(() => {
    if (!owners) return '';
    const from = `${track.codeowners}, line ${owners.rule.line}: ${owners.rule.pattern}`;
    return `Code owners: ${owners.owners.join(', ')}\n(${from})${mine ? '\nYou own this file' : ''}`;
  });

  function notesTip() {
    if (!counts) return '';
    const away = rows ? track.place(path, rows).elsewhere.length : 0;
    return `CI annotations on this file at the pull request's head: ${describeNotes(counts)}${away ? ` (${away} on lines the diff doesn't show)` : ''}\nClick to go to the first`;
  }

  function first() {
    const n = rows ? track.place(path, rows).placed[0] : null;
    reviews.focus = { id: n ? `note:${n.note.key}` : '', path };
  }
</script>

{#if owners}
  {@const n = owners.owners.length}
  <span class="marks" use:tooltip={ownersTip}>
    <Tag color={mine ? 'var(--theme2)' : undefined} label="{mine ? 'you' : owners.owners[0]}{n > 1 ? ` +${n - 1}` : ''}" />
  </span>
{/if}
{#if counts}
  <button
    class="btn btn--ghost btn--sm notes"
    aria-label="{describeNotes(counts)} from CI"
    use:tooltip={notesTip}
    onclick={first}><NoteIcon level={counts.level} />{counts.count}</button
  >
{/if}
{#if viewed}
  {#if viewed === 'DISMISSED'}
    <span class="marks" use:tooltip={'You marked it viewed, and it changed since'}><Tag color="var(--warn)" label="Changed since viewed" /></span>
  {/if}
  {@const on = viewed === 'VIEWED'}
  <button
    class="btn btn--sm viewed"
    class:is-on={on}
    aria-pressed={on}
    use:tooltip={on ? 'Viewed on GitHub: click to mark it not viewed, and unfold it (v)' : 'Mark viewed on GitHub, and fold it (v)'}
    onclick={() => onviewed(!on)}
    >{#if on}<CheckSquareFill />{:else}<SquareRegular />{/if}Viewed</button
  >
{/if}

<style>
  .marks {
    display: inline-flex;
    min-width: 0;
  }

  .notes {
    gap: var(--gap-2);
    font-size: var(--fs-xs);
    flex-shrink: 0;
  }

  .viewed {
    gap: var(--gap-2);
    flex-shrink: 0;
  }

  .viewed.is-on {
    background: var(--theme-soft);
    border-color: var(--theme-mid);
    color: var(--color2);
  }

  .viewed.is-on :global(svg) {
    color: var(--theme2);
  }
</style>
