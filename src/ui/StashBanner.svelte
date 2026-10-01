<script lang="ts">
  // Changes left on this branch (stashed when switching away), offered back on return.
  import { Banner, Button, formatRelative, toast } from 'purr';
  import { Archive } from 'purr/icons';
  import { app } from './lib/app.svelte.ts';

  let dismissed = $state<string | null>(null);
  const s = $derived(app.repo?.stashed);
  const n = $derived(s?.files.length ?? 0);

  async function restore() {
    if (!s || !(await app.op('stashPop', { sha: s.sha }))) return;
    if (app.stash?.sha === s.sha) app.stash = null;
    toast('Restored your stashed changes');
  }
</script>

{#if s && dismissed !== s.sha}
  <div class="wrap">
    <Banner
      placement="inline"
      icon={Archive}
      title="Stashed changes"
      lines={[`${n} file${n === 1 ? '' : 's'} you left on ${s.branch}, ${formatRelative(s.time)}.`]}
      ondismiss={() => (dismissed = s.sha)}
      dismissLabel="Not now"
    >
      {#snippet actions()}
        <Button
          size="sm"
          variant="ghost"
          onclick={() => s && (app.stash = { sha: s.sha, title: `Left on ${s.branch}`, message: s.message, time: s.time, dropped: false })}
          >View</Button
        >
        <Button size="sm" variant="primary" disabled={app.busy || !!app.repo?.blocked} onclick={restore}>Restore</Button>
      {/snippet}
    </Banner>
  </div>
{/if}

<style>
  .wrap {
    padding: var(--gap-3) var(--gap-3) 0;
  }
</style>
