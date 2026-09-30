<script lang="ts">
  import { ConfirmButton, IconButton, Popover, formatFull, formatRelative, toast } from 'purr';
  import { ClockCounterClockwise } from 'purr/icons';
  import type { Backup } from '../shared/types.ts';
  import { app, shortSha } from './lib/app.svelte.ts';

  let open = $state(false);
  let list = $state<Backup[] | null>(null);
  let button = $state<HTMLButtonElement | null>(null);

  async function toggle(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    button = e.currentTarget;
    open = !open;
    if (open) list = await fetch('/api/backups').then((r) => r.json());
  }

  async function restore(b: Backup) {
    if (await app.op('restore', { ref: b.ref })) {
      open = false;
      toast(`Restored the branch to ${shortSha(b.sha)} (${b.label}). The previous state was backed up too.`);
    }
  }
</script>

<IconButton
  label="Backups"
  tip="Backups: every operation saves the previous state"
  size="lg"
  aria-expanded={open}
  onclick={toggle}
>
  <ClockCounterClockwise />
</IconButton>
{#if open && button}
  <Popover
    anchor={button}
    placement="bottom-end"
    label="Backups"
    onclose={() => (open = false)}
    width="min(560px, calc(100vw - 32px))"
    maxHeight="60vh"
    padding="var(--sp-4)"
  >
    <div class="head">
      <b>Backups</b>
      <span class="muted">Taken before every operation, kept in <code>refs/legit/backups</code>.</span>
    </div>
    {#if list === null}
      <p class="muted">Loading…</p>
    {:else if !list.length}
      <p class="muted">No backups for this branch yet.</p>
    {:else}
      <ol>
        {#each list as b (b.ref)}
          <li>
            <span class="label">before {b.label}</span>
            <span class="mono sha">{shortSha(b.sha)}</span>
            <span class="subject" title={b.subject}>{b.subject}</span>
            <span class="muted when" title={formatFull(b.time)}>{formatRelative(b.time)}</span>
            {#if b.sha === app.repo?.head}
              <span class="muted now">current</span>
            {:else}
              <ConfirmButton
                variant="default"
                size="sm"
                confirmLabel="Click to confirm"
                onconfirm={() => restore(b)}
                disabled={app.busy}>Restore</ConfirmButton
              >
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  </Popover>
{/if}

<style>
  .head {
    display: flex;
    flex-direction: column;
    gap: var(--gap-1);
    padding: var(--gap-1) var(--gap-3) var(--gap-4);
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

  .sha {
    color: var(--muted);
  }

  .subject {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .when,
  .now {
    font-size: var(--fs-xs);
    flex-shrink: 0;
  }
</style>
