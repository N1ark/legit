<script lang="ts">
  // Syncing with the remote, as GitHub Desktop does it: Fetch (also every five minutes in the
  // background, and on focus after a minute), plus one button for the obvious next step:
  // Publish, Push ↑N or Pull ↓N. When the branch has diverged because the remote has new
  // commits, Pull asks whether to rebase or merge. When it diverged because pushed commits were
  // rewritten here, it's a force push instead (confirmed by a second click), with a lease that
  // git refuses if the remote has commits this repo hasn't seen.
  import { Button, ConfirmButton, formatFull, formatRelative, menu, toast } from 'purr';
  import { ArrowsClockwise, CaretDown, CloudArrowDown, CloudArrowUp, GitMerge, GitPullRequest, Warning } from 'purr/icons';
  import { onMount } from 'svelte';
  import { app } from './lib/app.svelte.ts';

  const info = $derived(app.repo?.push ?? null);
  const mode = $derived(
    !info ? null
    : info.publish ? 'publish'
    : info.ahead && info.behind ? (info.rewritten ? 'rewritten' : 'diverged')
    : info.ahead ? 'push'
    : info.behind ? 'pull'
    : 'done',
  );
  const where = $derived(info ? `${info.remote}/${info.branch}` : '');
  const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;
  const disabled = $derived(app.busy || !!app.repo?.blocked);

  let now = $state(Date.now());
  let started = false;
  onMount(() => {
    const tick = setInterval(() => {
      now = Date.now();
      app.fetchIfOlder(5 * 60_000);
    }, 30_000);
    const focus = () => app.fetchIfOlder(60_000);
    window.addEventListener('focus', focus);
    return () => {
      clearInterval(tick);
      window.removeEventListener('focus', focus);
    };
  });
  // Once the repo has loaded, fetch unless that happened a minute ago.
  $effect(() => {
    if (!app.repo || started) return;
    started = true;
    app.fetchIfOlder(60_000);
  });

  const fetched = $derived(app.repo?.fetchedAt ?? null);
  const fetchLabel = $derived(
    app.fetching ? 'Fetching…' : fetched ? `Fetched ${formatRelative(fetched, { now: Math.max(now, fetched) })}` : 'Fetch',
  );
  const fetchTitle = $derived(
    !info ? ''
    : app.fetchError ? `The last fetch failed:\n${app.fetchError}`
    : `Fetch from every remote${fetched ? ` (last fetched ${formatFull(fetched)})` : ''}` +
      (mode === 'done' ? `. Up to date with ${where} as of then.` : ''),
  );

  async function push() {
    if (!info) return;
    if (await app.op('push', { force: mode === 'rewritten' })) {
      toast(mode === 'publish' ? `Published to ${where}` : mode === 'rewritten' ? `Force pushed to ${where}` : `Pushed to ${where}`);
    }
  }

  function pull(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    if (!info) return;
    if (mode !== 'diverged') {
      app.sync('pull');
      return;
    }
    menu.showFor(
      e.currentTarget,
      [
        {
          label: `Rebase onto ${where}`,
          icon: GitPullRequest,
          note: `Replays your ${commits(info.ahead)} on top. Refused if anything conflicts.`,
          run: () => app.sync('pull', { how: 'rebase' }),
        },
        {
          label: `Merge ${where}`,
          icon: GitMerge,
          note: 'Adds a merge commit. Conflicts can be resolved here.',
          run: () => app.sync('pull', { how: 'merge' }),
        },
      ],
      `${where} and this branch have diverged`,
    );
  }

  const pushTitle = $derived(
    !info ? ''
    : mode === 'publish' ? `Push this branch to ${info.remote} as ${info.branch} and track it`
    : mode === 'rewritten'
      ? `You rewrote commits that were already on ${where}: this replaces its ${commits(info.behind)} with your ${commits(info.ahead)}. ` +
        "Uses --force-with-lease --force-if-includes: it refuses if the remote has commits you haven't seen."
    : `Push ${commits(info.ahead)} to ${where}`,
  );
  const pullTitle = $derived(
    !info ? ''
    : mode === 'diverged'
      ? `${where} has ${commits(info.behind)} you don't, and you have ${commits(info.ahead)} it doesn't: rebase or merge`
    : `Fetch, then fast-forward to ${where} (${commits(info.behind)}). Uncommitted changes come along, unless they'd be overwritten.`,
  );
</script>

{#if info && mode}
  <div class="sync">
    <Button variant="ghost" size="sm" onclick={() => app.fetchRemote()} disabled={app.fetching} title={fetchTitle}>
      <span class="icon" class:spin={app.fetching}>
        {#if app.fetchError && !app.fetching}<Warning weight="bold" />{:else}<ArrowsClockwise />{/if}
      </span>
      <span class="when">{fetchLabel}</span>
    </Button>

    {#if mode === 'pull' || mode === 'diverged'}
      <Button variant="primary" onclick={pull} {disabled} title={pullTitle}>
        <CloudArrowDown /> Pull <span class="count">↓{info.behind}</span>
        {#if mode === 'diverged'}<CaretDown />{/if}
      </Button>
    {/if}
    {#if mode === 'rewritten'}
      <ConfirmButton confirmLabel="Click to force push" onconfirm={push} {disabled} title={pushTitle}>
        <Warning weight="bold" /> Force push <span class="count">↑{info.ahead}</span>
      </ConfirmButton>
    {:else if mode === 'push' || mode === 'publish'}
      <Button variant="primary" onclick={push} {disabled} title={pushTitle}>
        <CloudArrowUp />
        {mode === 'publish' ? 'Publish' : 'Push'}
        {#if mode === 'push'}<span class="count">↑{info.ahead}</span>{/if}
      </Button>
    {/if}
  </div>
{/if}

<style>
  .sync {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
  }

  .icon {
    display: inline-flex;
  }

  .spin {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .when {
    font-size: var(--fs-xs);
    color: var(--muted);
    white-space: nowrap;
  }

  .count {
    font-family: var(--mono);
    font-size: var(--fs-xs);
    opacity: 0.85;
  }
</style>
