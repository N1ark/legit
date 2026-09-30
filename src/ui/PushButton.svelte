<script lang="ts">
  // One push button that does the appropriate thing: publish a new branch, push when ahead,
  // or (after rewriting pushed commits, with a confirming second click) force push with a
  // lease, which git refuses if the remote has commits this repo hasn't seen.
  import CloudArrowUpIcon from 'phosphor-svelte/lib/CloudArrowUpIcon';
  import CloudCheckIcon from 'phosphor-svelte/lib/CloudCheckIcon';
  import WarningIcon from 'phosphor-svelte/lib/WarningIcon';
  import { app } from './lib/app.svelte.ts';

  const info = $derived(app.repo?.push ?? null);
  const mode = $derived(
    !info ? null
    : info.publish ? 'publish'
    : info.ahead && info.behind ? 'force'
    : info.ahead ? 'push'
    : info.behind ? 'behind'
    : 'done',
  );
  let confirm = $state(false);
  let timer: ReturnType<typeof setTimeout>;

  async function push() {
    if (!info) return;
    if (mode === 'force' && !confirm) {
      confirm = true;
      timer = setTimeout(() => (confirm = false), 4000);
      return;
    }
    clearTimeout(timer);
    confirm = false;
    const where = `${info.remote}/${info.branch}`;
    if (await app.op('push', { force: mode === 'force' })) {
      app.toast(mode === 'publish' ? `Published to ${where}` : mode === 'force' ? `Force pushed to ${where}` : `Pushed to ${where}`);
    }
  }

  const title = $derived(
    !info ? ''
    : mode === 'publish' ? `Push this branch to ${info.remote} as ${info.branch} and track it`
    : mode === 'push' ? `Push ${info.ahead} commit${info.ahead === 1 ? '' : 's'} to ${info.remote}/${info.branch}`
    : mode === 'force'
      ? `Commits already on ${info.remote}/${info.branch} were rewritten, so this replaces them. ` +
        "Uses --force-with-lease --force-if-includes: it refuses if the remote has commits you haven't seen."
    : mode === 'behind' ? `${info.remote}/${info.branch} has ${info.behind} commit${info.behind === 1 ? '' : 's'} you don't (as of the last fetch)`
    : `Up to date with ${info.remote}/${info.branch} (as of the last fetch)`,
  );
</script>

{#if info && mode}
  <button
    class="push {mode}"
    class:confirm
    onclick={push}
    disabled={mode === 'behind' || mode === 'done' || app.busy || !!app.repo?.blocked}
    {title}
  >
    {#if mode === 'force'}
      <WarningIcon size={14} weight="bold" />
      {confirm ? 'Click to force push' : 'Force push'}
    {:else if mode === 'done'}
      <CloudCheckIcon size={14} /> Pushed
    {:else}
      <CloudArrowUpIcon size={14} />
      {mode === 'publish' ? 'Publish' : mode === 'behind' ? 'Behind' : 'Push'}
    {/if}
    {#if info.ahead && mode !== 'publish'}<span class="count">↑{info.ahead}</span>{/if}
    {#if info.behind}<span class="count">↓{info.behind}</span>{/if}
  </button>
{/if}

<style>
  .push {
    font-size: 12px;
    padding: 4px 10px;
  }

  .push.done {
    background: none;
    color: var(--dim);
  }

  .push.push,
  .push.publish {
    background: var(--theme);
    color: #fff;
  }

  .push.push:hover:not(:disabled),
  .push.publish:hover:not(:disabled) {
    background: var(--theme-2);
  }

  .push.force {
    background: none;
    color: var(--warn);
    box-shadow: inset 0 0 0 1px var(--warn);
  }

  .push.force.confirm,
  .push.force:hover:not(:disabled) {
    background: var(--warn);
    color: var(--bg);
  }

  .count {
    font-family: var(--font-mono);
    font-size: 11px;
    opacity: 0.85;
  }
</style>
