<script lang="ts">
  // Syncing with the remote, as GitHub Desktop does it: Fetch (also every five minutes in the
  // background, and on focus after a minute), plus one button for the obvious next step:
  // Publish, Push ↑N or Pull ↓N. When the branch has diverged because the remote has new
  // commits, Pull asks whether to rebase or merge. When it diverged because pushed commits were
  // rewritten here, it's a force push instead (confirmed by a second click), with a lease that
  // git refuses if the remote has commits this branch never had. Whenever the remote has commits
  // the branch doesn't, Force push beside Pull overwrites them (as fetched) after a second click.
  import { Button, ConfirmButton, formatFull, formatRelative, menu, toast } from 'purr';
  import { ArrowsClockwise, CaretDown, CloudArrowDown, CloudArrowUp, GitMerge, GitPullRequest, Warning } from 'purr/icons';
  import { onMount } from 'svelte';
  import { app } from './lib/app.svelte.ts';
  import { progressSummary } from './lib/progress.ts';

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
  const progress = $derived(Object.values(app.progress));
  const fetchProgress = $derived(progress.filter((p) => p.op === 'fetch'));
  const pushProgress = $derived(progress.filter((p) => p.op === 'push'));
  const fetchLabel = $derived(
    fetchProgress.length ? progressSummary(fetchProgress)
    : app.fetching ? 'Fetching…'
    : fetched ? formatRelative(fetched, { now: Math.max(now, fetched) })
    : 'Fetch',
  );
  const fetchTitle = $derived(
    !info ? ''
    : fetchProgress.length ? `Fetching from ${fetchProgress.map((p) => p.remote).join(', ')}: ${progressSummary(fetchProgress)}`
    : app.fetchError ? `The last fetch failed:\n${app.fetchError}`
    : `Fetch from every remote${fetched ? ` (last fetched ${formatFull(fetched)})` : ''}` +
      (mode === 'done' ? `. Up to date with ${where} as of then.` : ''),
  );

  type Force = boolean | 'overwrite' | 'fetch';

  async function push(force: Force = mode === 'rewritten') {
    if (!info) return;
    const body = force === 'overwrite' ? { force, expect: info.tip } : { force };
    const forced = !!force && mode !== 'push' && mode !== 'publish';
    if (await app.op('push', body, undefined, undefined, refused)) {
      toast(mode === 'publish' ? `Published to ${where}` : forced ? `Force pushed to ${where}` : `Pushed to ${where}`);
    }
  }

  /** A force push git refused: say why in the toast, with the way past it. */
  function refused(e: Error & { code?: string }) {
    const anyway =
      e.code === 'not-integrated' ? { label: 'Force push anyway', run: () => push('overwrite') }
      : e.code === 'not-fetched' ? { label: 'Fetch and force push anyway', run: () => push('fetch') }
      : null;
    if (!anyway) return false;
    toast(e.message, { kind: 'error', timeout: 20_000, action: anyway });
    return true;
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
          note: `Replays your ${commits(info.ahead)} on top, stopping at each one that conflicts for you to resolve.`,
          run: () => app.sync('pull', { how: 'rebase' }),
        },
        {
          label: `Merge ${where}`,
          icon: GitMerge,
          note: 'Adds a merge commit. Conflicts can be resolved here.',
          run: () => app.sync('pull', { how: 'merge' }),
        },
      ],
      `Bring in ${where}'s ${commits(info.behind)}`,
    );
  }

  const pushTitle = $derived(
    !info ? ''
    : mode === 'publish' ? `Push this branch to ${info.remote} as ${info.branch} and track it`
    : mode === 'rewritten'
      ? `You changed commits that were already on ${where}, so it still has their old versions (${commits(info.behind)}). ` +
        `This replaces them with your ${commits(info.ahead)}. If ${where} has commits your branch never had, nothing is pushed, ` +
        'and you can choose to overwrite them.'
    : `Push ${commits(info.ahead)} to ${where}`,
  );
  const pullTitle = $derived(
    !info ? ''
    : mode === 'diverged'
      ? `${where} has ${commits(info.behind)} your branch doesn't, and your branch has ${commits(info.ahead)} it doesn't. ` +
        'Pull brings theirs in: your commits rebased on top, or a merge.'
    : `${where} has ${commits(info.behind)} your branch doesn't. Pull fetches, then moves your branch up to them; ` +
      "uncommitted changes come along, unless they'd be overwritten.",
  );
  const overwriteTitle = $derived(
    !info ? ''
    : `Replace ${where} with your branch, removing the ${commits(info.behind)} it has that your branch doesn't. ` +
      `Refused if ${where} changed since the last fetch. The removed commits stay in this repo (git reflog ${where}).`,
  );
</script>

{#if info && mode}
  <div class="sync">
    <Button variant="ghost" size="sm" onclick={() => app.fetchRemote()} disabled={app.fetching} title={fetchTitle}>
      <span class="icon" class:spin={app.fetching || fetchProgress.length}>
        {#if app.fetchError && !app.fetching}<Warning weight="bold" />{:else}<ArrowsClockwise />{/if}
      </span>
      <span class="when">{fetchLabel}</span>
    </Button>
    {#if pushProgress.length}
      <span class="when progress" role="status">Pushing: {progressSummary(pushProgress)}</span>
    {/if}

    {#if mode === 'pull' || mode === 'diverged'}
      <Button variant="primary" onclick={pull} {disabled} title={pullTitle}>
        <CloudArrowDown /> Pull <span class="count">↓{info.behind}</span>
        {#if mode === 'diverged'}<CaretDown />{/if}
      </Button>
      <ConfirmButton
        variant="ghost"
        confirmLabel={`Overwrite ${commits(info.behind)} on ${where}`}
        onconfirm={() => push('overwrite')}
        {disabled}
        title={overwriteTitle}
      >
        <Warning /> Force push
      </ConfirmButton>
    {/if}
    {#if mode === 'rewritten'}
      <ConfirmButton confirmLabel="Click to force push" onconfirm={() => push(true)} {disabled} title={pushTitle}>
        <Warning weight="bold" /> Force push <span class="count">↑{info.ahead}</span>
      </ConfirmButton>
    {:else if mode === 'push' || mode === 'publish'}
      <Button variant="primary" onclick={() => push(false)} {disabled} title={pushTitle}>
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
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 34em;
    font-variant-numeric: tabular-nums;
  }

  .count {
    font-family: var(--mono);
    font-size: var(--fs-xs);
    opacity: 0.85;
  }
</style>
