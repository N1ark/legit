<script lang="ts">
  import ClockCounterClockwiseIcon from 'phosphor-svelte/lib/ClockCounterClockwiseIcon';
  import type { Backup } from '../shared/types.ts';
  import { ago, app, shortSha } from './lib/app.svelte.ts';

  let open = $state(false);
  let list = $state<Backup[] | null>(null);
  let confirm = $state<string | null>(null);

  async function toggle() {
    open = !open;
    confirm = null;
    if (open) list = await fetch('/api/backups').then((r) => r.json());
  }

  async function restore(b: Backup) {
    if (confirm !== b.ref) {
      confirm = b.ref;
      return;
    }
    if (await app.op('restore', { ref: b.ref })) {
      open = false;
      app.toast(`Restored the branch to ${shortSha(b.sha)} (${b.label}). The previous state was backed up too.`);
    }
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && open && (open = false)} />

<div class="wrap">
  <button class="ghost" class:active={open} onclick={toggle} title="Backups: every operation saves the previous state">
    <ClockCounterClockwiseIcon size={16} />
  </button>
  {#if open}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="backdrop" onclick={() => (open = false)}></div>
    <div class="panel">
      <div class="head">
        <b>Backups</b>
        <span class="dim">Taken before every operation, kept in <code>refs/legit/backups</code>.</span>
      </div>
      {#if list === null}
        <p class="dim">Loading…</p>
      {:else if !list.length}
        <p class="dim">No backups for this branch yet.</p>
      {:else}
        <ol>
          {#each list as b (b.ref)}
            <li class:current={b.sha === app.repo?.head}>
              <span class="label">before {b.label}</span>
              <span class="mono sha">{shortSha(b.sha)}</span>
              <span class="subject" title={b.subject}>{b.subject}</span>
              <span class="dim when" title={new Date(b.time).toLocaleString()}>{ago(b.time / 1000)}</span>
              {#if b.sha === app.repo?.head}
                <span class="dim now">current</span>
              {:else}
                <button class:confirm={confirm === b.ref} onclick={() => restore(b)} disabled={app.busy}>
                  {confirm === b.ref ? 'Click to confirm' : 'Restore'}
                </button>
              {/if}
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
  }

  .active {
    background: var(--bg3);
  }

  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 19;
  }

  .panel {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    z-index: 20;
    width: min(560px, calc(100vw - 32px));
    max-height: 60vh;
    overflow: auto;
    background: var(--bg2);
    border-radius: 6px;
    box-shadow: var(--box-shadow), 0 12px 40px #0004;
    padding: 10px;
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 2px 6px 8px;
    font-size: 12px;
  }

  code {
    font-family: var(--font-mono);
    font-size: 11px;
  }

  p {
    margin: 6px;
  }

  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-radius: 4px;
    min-height: 32px;
  }

  li:hover {
    background: var(--bg3);
  }

  .label {
    font-size: 11px;
    color: var(--theme);
    width: 92px;
    flex-shrink: 0;
  }

  .sha {
    color: var(--dim);
  }

  .subject {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .when,
  .now {
    font-size: 11px;
    flex-shrink: 0;
  }

  li button {
    font-size: 12px;
    padding: 3px 8px;
  }

  .confirm {
    background: var(--theme);
    color: #fff;
  }
</style>
