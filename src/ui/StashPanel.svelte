<script lang="ts">
  // The stash list (apply, restore = pop, drop), plus dropped stashes, which legit keeps for two
  // weeks under refs/legit/stashes and which can still be applied.
  import { Button, ConfirmButton, IconButton, Popover, formatFull, formatRelative, toast, tooltip } from 'purr';
  import { ArchiveRegular } from 'purr/glyphs';
  import type { StashEntry, Stashes } from '../shared/types.ts';
  import { app, shortSha } from './lib/app.svelte.ts';
  import { tip } from './lib/tip.ts';

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

  /** Restore or apply, offering to go ahead with conflicts when it would conflict; the conflict view then takes over. */
  function restore(op: 'stashPop' | 'stashApply', sha: string, done: string) {
    app.applyStash(op, sha, done, () => (app.repo?.conflict ? (open = false) : open && load()));
  }

  /** What a stash is called in the list. */
  const title = (s: { message: string; branch?: string | null }) =>
    s.branch ? `Left on ${s.branch}` : s.message.replace(/^(WIP on|On) [^:]+: /, '') || s.message;
  const files = (s: StashEntry) => `${s.files.length} file${s.files.length === 1 ? '' : 's'}`;

  /** Show a stash's changes in place of the selected commit. */
  function view(s: { sha: string; message: string; time: number; branch?: string | null }, dropped: boolean) {
    app.stash = { sha: s.sha, title: title(s), message: s.message, time: s.time, dropped };
    open = false;
  }
</script>

<IconButton label="Stashes" tip="Stashed changes" size="lg" aria-expanded={open} onclick={toggle}>
  <ArchiveRegular />
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
      <b>Stashes</b>
      {#if app.hasWork}
        <Button size="sm" disabled={app.busy || !!app.repo?.blocked} onclick={() => run('stash', {}, 'Stashed your changes')}>
          Stash all
        </Button>
      {/if}
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
              <button class="subject" use:tooltip={'Show its changes'} onclick={() => view(s, false)}>{title(s)}</button>
              <span class="muted files" use:tooltip={s.files.join('\n')}>{files(s)}</span>
              <span class="muted when" use:tooltip={formatFull(s.time)}>{formatRelative(s.time)}</span>
              <Button
                size="sm"
                variant="primary"
                {@attach tip('Apply it, then remove it from the list; if it conflicts with your files, it asks first')}
                disabled={app.busy}
                onclick={() => restore('stashPop', s.sha, 'Restored the stashed changes')}>Restore</Button
              >
              <Button
                size="sm"
                {@attach tip('Apply it and keep it in the list; if it conflicts with your files, it asks first')}
                disabled={app.busy}
                onclick={() => restore('stashApply', s.sha, 'Applied the stash; it stays in the list')}>Apply</Button
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
        <div class="section muted"><span use:tooltip={'Kept for two weeks in refs/legit/stashes'}>Dropped or restored</span></div>
        <ol>
          {#each data.dropped as d (d.ref)}
            <li>
              <span class="mono sha">{shortSha(d.sha)}</span>
              <button class="subject" use:tooltip={'Show its changes'} onclick={() => view({ ...d, branch: /: legit: on ([^:]+)$/.exec(d.message)?.[1] }, true)}>
                {title({ message: d.message, branch: /: legit: on ([^:]+)$/.exec(d.message)?.[1] })}
              </button>
              <span class="muted when" use:tooltip={formatFull(d.time)}>{d.label === 'pop' ? 'restored' : 'dropped'} {formatRelative(d.time)}</span>
              <Button
                size="sm"
                {@attach tip('Apply these changes again')}
                disabled={app.busy}
                onclick={() => restore('stashApply', d.sha, 'Applied the dropped stash')}>Apply</Button
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
    align-items: center;
    justify-content: space-between;
    gap: var(--gap-4);
    padding: var(--gap-1) var(--gap-3) var(--gap-4);
    font-size: var(--fs-sm);
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

  /* A link-like button: the row's text, underlined on hover. */
  .subject {
    all: unset;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    cursor: pointer;
  }

  .subject:hover,
  .subject:focus-visible {
    text-decoration: underline;
    color: var(--theme2);
  }

  .files,
  .when {
    font-size: var(--fs-xs);
    flex-shrink: 0;
  }
</style>
