<script lang="ts">
  // The stash list (apply, restore = pop, drop), plus dropped stashes, which legit keeps for two
  // weeks under refs/legit/stashes and which can still be applied.
  import { Button, ConfirmButton, IconButton, Popover, formatFull, formatRelative, toast } from 'purr';
  import { Archive } from 'purr/icons';
  import type { StashEntry, Stashes } from '../shared/types.ts';
  import { app, shortSha } from './lib/app.svelte.ts';

  let open = $state(false);
  let data = $state<Stashes | null>(null);
  let button = $state<HTMLButtonElement | null>(null);

  async function load() {
    data = await fetch('/api/stashes').then((r) => r.json());
  }

  async function toggle(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    button = e.currentTarget;
    open = !open;
    if (open) await load();
  }

  async function run(op: string, body: unknown, done: string) {
    if (await app.op(op, body)) toast(done);
    if (open) await load();
  }

  /** What a stash is called in the list. */
  const title = (s: { message: string; branch?: string | null }) =>
    s.branch ? `Left on ${s.branch}` : s.message.replace(/^(WIP on|On) [^:]+: /, '') || s.message;
  const files = (s: StashEntry) => `${s.files.length} file${s.files.length === 1 ? '' : 's'}`;
</script>

<IconButton label="Stashes" tip="Stashed changes" size="lg" aria-expanded={open} onclick={toggle}>
  <Archive />
</IconButton>
{#if open && button}
  <Popover
    anchor={button}
    placement="bottom-end"
    label="Stashes"
    onclose={() => (open = false)}
    width="min(560px, calc(100vw - 32px))"
    maxHeight="60vh"
    padding="var(--sp-4)"
  >
    <div class="head">
      <div class="title">
        <b>Stashes</b>
        {#if app.hasWork}
          <Button size="sm" disabled={app.busy || !!app.repo?.blocked} onclick={() => run('stash', {}, 'Stashed your changes')}>
            Stash all changes
          </Button>
        {/if}
      </div>
      <span class="muted">
        A stash is only applied when it can't conflict with your files. Dropped ones are kept for two weeks in
        <code>refs/legit/stashes</code>.
      </span>
    </div>
    {#if data === null}
      <p class="muted">Loading…</p>
    {:else}
      {#if !data.entries.length}
        <p class="muted">No stashes.</p>
      {:else}
        <ol>
          {#each data.entries as s (s.sha)}
            <li>
              <span class="mono sha">{shortSha(s.sha)}</span>
              <span class="subject" title={s.message}>{title(s)}</span>
              <span class="muted files" title={s.files.join('\n')}>{files(s)}</span>
              <span class="muted when" title={formatFull(s.time)}>{formatRelative(s.time)}</span>
              <Button
                size="sm"
                variant="primary"
                title="Apply it, then remove it from the stash list"
                disabled={app.busy}
                onclick={() => run('stashPop', { sha: s.sha }, 'Restored the stashed changes')}>Restore</Button
              >
              <Button
                size="sm"
                title="Apply it and keep it in the stash list"
                disabled={app.busy}
                onclick={() => run('stashApply', { sha: s.sha }, 'Applied the stash; it stays in the list')}>Apply</Button
              >
              <ConfirmButton
                size="sm"
                confirmLabel="Drop?"
                disabled={app.busy}
                onconfirm={() => run('stashDrop', { sha: s.sha }, 'Dropped the stash; it stays recoverable for two weeks')}
                >Drop</ConfirmButton
              >
            </li>
          {/each}
        </ol>
      {/if}
      {#if data.dropped.length}
        <div class="section muted">Dropped or restored, kept for two weeks</div>
        <ol>
          {#each data.dropped as d (d.ref)}
            <li>
              <span class="mono sha">{shortSha(d.sha)}</span>
              <span class="subject" title={d.message}>{title({ message: d.message, branch: /: legit: on ([^:]+)$/.exec(d.message)?.[1] })}</span>
              <span class="muted when" title={formatFull(d.time)}>{d.label === 'pop' ? 'restored' : 'dropped'} {formatRelative(d.time)}</span>
              <Button
                size="sm"
                title="Apply these changes again"
                disabled={app.busy}
                onclick={() => run('stashApply', { sha: d.sha }, 'Applied the dropped stash')}>Apply</Button
              >
            </li>
          {/each}
        </ol>
      {/if}
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

  .title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap-4);
  }

  code {
    font-family: var(--mono);
    font-size: var(--fs-xs);
  }

  p {
    margin: var(--gap-3);
  }

  .section {
    font-size: var(--fs-xs);
    padding: var(--sp-4) var(--gap-3) var(--gap-2);
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

  .sha {
    color: var(--muted);
  }

  .subject {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .files,
  .when {
    font-size: var(--fs-xs);
    flex-shrink: 0;
  }
</style>
