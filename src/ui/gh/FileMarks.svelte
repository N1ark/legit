<script lang="ts">
  // In a file's header in a diff of the pull request: its code owners (the viewer's own marked), and
  // the Viewed box.
  import { Tag, tooltip } from 'purr';
  import type { DiffTrack } from '../lib/gh-files.svelte.ts';

  interface Props {
    track: DiffTrack;
    path: string;
    /** Mark it viewed (true) or not, from its box. */
    onviewed: (on: boolean) => void;
  }
  let { track, path, onviewed }: Props = $props();

  const owners = $derived(track.owners(path));
  const mine = $derived(track.mine(path));
  const viewed = $derived(track.viewed(path));

  const ownersTip = $derived.by(() => {
    if (!owners) return '';
    const from = `${track.codeowners}, line ${owners.rule.line}: ${owners.rule.pattern}`;
    return `Code owners: ${owners.owners.join(', ')}\n(${from})${mine ? '\nYou own this file' : ''}`;
  });
</script>

{#if owners}
  {@const n = owners.owners.length}
  <span class="marks" use:tooltip={ownersTip}>
    <Tag color={mine ? 'var(--theme2)' : undefined} label="{mine ? 'you' : owners.owners[0]}{n > 1 ? ` +${n - 1}` : ''}" />
  </span>
{/if}
{#if viewed}
  {#if viewed === 'DISMISSED'}
    <span class="marks" use:tooltip={'You marked it viewed, and it changed since'}><Tag color="var(--warn)" label="Changed since viewed" /></span>
  {/if}
  <label class="viewed" class:is-on={viewed === 'VIEWED'} use:tooltip={viewed === 'VIEWED' ? 'Marked viewed on GitHub (v)' : 'Mark viewed on GitHub, and fold it (v)'}>
    <input type="checkbox" class="checkbox" checked={viewed === 'VIEWED'} onchange={(e) => onviewed(e.currentTarget.checked)} />
    Viewed
  </label>
{/if}

<style>
  .marks {
    display: inline-flex;
    min-width: 0;
  }

  .viewed {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-2);
    padding: 0 var(--gap-3);
    height: var(--btn-md);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: var(--fs-xs);
    color: var(--muted);
    cursor: pointer;
    flex-shrink: 0;
    user-select: none;
  }

  .viewed.is-on {
    background: var(--theme-soft);
    border-color: var(--theme-mid);
    color: var(--color2);
  }
</style>
