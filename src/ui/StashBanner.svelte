<script lang="ts">
  // Changes left on this branch (stashed when switching away), offered back on return.
  import { Banner, Button, formatRelative } from 'purr';
  import { ArchiveRegular } from 'purr/glyphs';
  import { app } from './lib/app.svelte.ts';

  let dismissed = $state<string | null>(null);
  const s = $derived(app.repo?.stashed);
  const n = $derived(s?.files.length ?? 0);

  function restore() {
    if (!s) return;
    const sha = s.sha;
    app.applyStash('stashPop', sha, 'Restored your stashed changes', () => {
      if (app.stash?.sha === sha) app.stash = null;
    });
  }
</script>

{#if s && dismissed !== s.sha}
  <div class="wrap">
    <Banner
      placement="inline"
      icon={ArchiveRegular}
      title="Stashed changes"
      lines={[`${n} file${n === 1 ? '' : 's'} left on ${s.branch} ${formatRelative(s.time)}`]}
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
