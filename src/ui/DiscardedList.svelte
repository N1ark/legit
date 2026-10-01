<script lang="ts">
  // The backups panel's "Discarded changes": what each discard threw away, ready to put back.
  import { Button, ConfirmButton, formatFull, formatRelative } from 'purr';
  import type { Discarded } from '../shared/types.ts';
  import { app } from './lib/app.svelte.ts';
  import { names, restoreDiscarded } from './lib/discard.ts';

  let list = $state<Discarded[] | null>(null);
  /** Files that changed since the discard, by ref: putting those back needs a confirmed overwrite. */
  let conflicts = $state<Record<string, string[]>>({});

  async function load() {
    list = await fetch('/api/discarded').then((r) => r.json());
  }
  load();

  async function restore(d: Discarded, overwrite = false) {
    const r = await restoreDiscarded(d.ref, overwrite, false);
    if (!r) return;
    const { [d.ref]: _, ...rest } = conflicts;
    conflicts = r.conflicts.length ? { ...rest, [d.ref]: r.conflicts } : rest;
    if (r.saved) load();
  }

  const files = (d: Discarded) =>
    d.files.slice(0, 3).join(', ') + (d.count > 3 ? ` and ${d.count - 3} more` : '');
</script>

<div class="head">
  <b>Discarded changes</b>
  <span class="muted">Saved before every discard and kept for two weeks, in <code>refs/legit/discarded</code>.</span>
</div>
{#if list === null}
  <p class="muted">Loading…</p>
{:else if !list.length}
  <p class="muted">Nothing discarded lately.</p>
{:else}
  <ol>
    {#each list as d (d.ref)}
      {@const changed = conflicts[d.ref]}
      <li>
        <span class="label" title={d.label}>{d.label.startsWith('replaced') ? 'replaced' : 'discarded'}</span>
        <span class="files mono" title={d.files.join('\n')}>{files(d)}</span>
        <span class="muted when" title={formatFull(d.time)}>{formatRelative(d.time)}</span>
        {#if changed}
          <ConfirmButton size="sm" confirmLabel="Click to overwrite" onconfirm={() => restore(d, true)} disabled={app.busy}>
            Overwrite
          </ConfirmButton>
        {:else}
          <Button size="sm" onclick={() => restore(d)} disabled={app.busy} title="Put these files back as they were">Restore</Button>
        {/if}
      </li>
      {#if changed}
        <li class="warn">
          {names(changed)} changed since. Overwriting saves {changed.length === 1 ? 'it' : 'them'} first.
        </li>
      {/if}
    {/each}
  </ol>
{/if}

<style>
  .head {
    display: flex;
    flex-direction: column;
    gap: var(--gap-1);
    margin-top: var(--gap-4);
    padding: var(--gap-4) var(--gap-3);
    border-top: 1px solid var(--border);
    font-size: var(--fs-sm);
  }

  code {
    font-family: var(--mono);
    font-size: var(--fs-xs);
  }

  p {
    margin: var(--gap-3);
  }

  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    display: flex;
    align-items: center;
    gap: var(--gap-4);
    padding: var(--gap-2) var(--gap-3);
    border-radius: var(--radius);
    min-height: 32px;
  }

  @media (hover: hover) {
    li:hover {
      background: var(--bg3);
    }
  }

  .label {
    font-size: var(--fs-xs);
    color: var(--theme2);
    width: 92px;
    flex-shrink: 0;
  }

  .files {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: var(--fs-sm);
  }

  .when {
    font-size: var(--fs-xs);
    flex-shrink: 0;
  }

  li.warn {
    min-height: 0;
    padding-left: calc(92px + var(--gap-4) + var(--gap-3));
    color: var(--warn);
    font-size: var(--fs-xs);
  }
</style>
