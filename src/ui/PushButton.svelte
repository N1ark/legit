<script lang="ts">
  // One push button that does the appropriate thing: publish a new branch, push when ahead,
  // or (after rewriting pushed commits, with a confirming second click) force push with a
  // lease, which git refuses if the remote has commits this repo hasn't seen.
  import { Button, ConfirmButton, toast } from 'purr';
  import { CloudArrowUp, CloudCheck, Warning } from 'purr/icons';
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

  async function push() {
    if (!info) return;
    const where = `${info.remote}/${info.branch}`;
    if (await app.op('push', { force: mode === 'force' })) {
      toast(mode === 'publish' ? `Published to ${where}` : mode === 'force' ? `Force pushed to ${where}` : `Pushed to ${where}`);
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
  const disabled = $derived(app.busy || !!app.repo?.blocked);
</script>

{#snippet counts()}
  {#if info?.ahead && mode !== 'publish'}<span class="count">↑{info.ahead}</span>{/if}
  {#if info?.behind}<span class="count">↓{info.behind}</span>{/if}
{/snippet}

{#if info && mode === 'force'}
  <ConfirmButton confirmLabel="Click to force push" onconfirm={push} {disabled} {title}>
    <Warning weight="bold" /> Force push {@render counts()}
  </ConfirmButton>
{:else if info && mode}
  <Button
    variant={mode === 'push' || mode === 'publish' ? 'primary' : 'ghost'}
    onclick={push}
    disabled={mode === 'behind' || mode === 'done' || disabled}
    {title}
  >
    {#if mode === 'done'}
      <CloudCheck /> Pushed
    {:else}
      <CloudArrowUp />
      {mode === 'publish' ? 'Publish' : mode === 'behind' ? 'Behind' : 'Push'}
    {/if}
    {@render counts()}
  </Button>
{/if}

<style>
  .count {
    font-family: var(--mono);
    font-size: var(--fs-xs);
    opacity: 0.85;
  }
</style>
