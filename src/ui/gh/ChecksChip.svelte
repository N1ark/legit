<script lang="ts">
  // CI in the header, for HEAD once it's pushed (else the branch's tip on the remote): how many
  // checks are done and how it's going; a click lists them. It also holds the checks popover that
  // commit rows open, and the log viewer, and keeps them fresh: every 15s while something runs and
  // the window has focus, and otherwise when GitHub refreshes (gh.tick), on focus and after a push.
  import { Popover, tooltip } from 'purr';
  import { onMount, untrack } from 'svelte';
  import CheckIcon from './CheckIcon.svelte';
  import ChecksPanel from './ChecksPanel.svelte';
  import JobLog from './JobLog.svelte';
  import { app, shortSha } from '../lib/app.svelte.ts';
  import { gh } from '../lib/github.svelte.ts';
  import { checks } from '../lib/gh-checks.svelte.ts';
  import { STATE_LABEL, describeCounts } from '../lib/gh-checks.ts';
  import { overall } from '../../shared/gh-checks.ts';

  const target = $derived.by(() => {
    const r = app.repo;
    if (!r || !gh.ready) return null;
    if (r.head && r.commits.find((c) => c.sha === r.head)?.pushed) return r.head;
    return r.push?.tip ?? null;
  });
  const pr = $derived(gh.pr && gh.pr.headSha === target ? gh.pr.number : null);
  const data = $derived(target ? checks.details[target] : undefined);
  const counts = $derived(data?.counts);
  const state = $derived(data ? overall(data.groups.map((g) => g.state)) : null);

  // A new target and the GitHub refresh that follows it come together: one request does for both.
  let last = '';
  $effect(() => {
    void gh.tick;
    const sha = target;
    if (!sha) return;
    const key = `${sha}:${pr}`;
    untrack(() => {
      if (key !== last || Date.now() - checks.loadedAt(sha) > 2000) checks.load(sha, { pr, quiet: true });
      last = key;
    });
  });

  $effect(() => {
    void gh.tick;
    untrack(() => checks.refreshRows());
  });

  onMount(() => {
    const poll = setInterval(() => {
      if (!document.hasFocus()) return;
      for (const sha of new Set([target, checks.open?.sha])) if (sha && checks.active(sha)) checks.load(sha, { quiet: true });
      if (checks.open) checks.refreshJobs();
    }, 15_000);
    const focus = () => {
      if (target && Date.now() - checks.loadedAt(target) > 10_000) checks.load(target, { pr, quiet: true });
    };
    window.addEventListener('focus', focus);
    return () => {
      clearInterval(poll);
      window.removeEventListener('focus', focus);
    };
  });

  const label = $derived(
    !target ? ''
    : !data ? `Checks on ${shortSha(target)}: loading`
    : !counts?.total ? `No checks on ${shortSha(target)}`
    : `Checks on ${shortSha(target)}${target === app.repo?.head ? '' : ` (${app.repo?.push?.remote ?? 'the remote'}'s tip)`}: ${describeCounts(counts)}`,
  );
  const text = $derived(
    !counts?.total || !state ? ''
    : counts.done < counts.total ? `${counts.done}/${counts.total}`
    : state === 'failure' ? `${counts.failure} failed`
    : STATE_LABEL[state],
  );
</script>

{#if target && data?.counts.total && state}
  <button
    class="btn btn--ghost btn--sm chip {state}"
    aria-label={label}
    use:tooltip={label}
    aria-expanded={checks.open?.sha === target}
    onclick={(e) => target && checks.show(target, e.currentTarget)}
  >
    <CheckIcon {state} />
    {#if state === 'failure' && counts && counts.done < counts.total}<CheckIcon state={counts.running ? 'running' : 'pending'} />{/if}
    <span class="text">{text}</span>
  </button>
{/if}

{#if checks.open}
  {@const sha = checks.open.sha}
  <Popover
    anchor={checks.open.anchor}
    placement="bottom-end"
    label="Checks of {shortSha(sha)}"
    onclose={() => (checks.open = null)}
    width="min(620px, calc(100vw - 32px))"
    maxHeight="70vh"
    padding="var(--sp-4)"
  >
    <ChecksPanel {sha} />
  </Popover>
{/if}

{#if checks.log}
  {#key checks.log}
    <JobLog target={checks.log} />
  {/key}
{/if}

<style>
  .chip {
    gap: var(--gap-3);
    font-variant-numeric: tabular-nums;
  }

  .chip :global(.icon) {
    font-size: var(--icon-lg);
  }

  .text {
    font-size: var(--fs-xs);
    color: var(--muted);
  }

  .failure .text {
    color: var(--danger);
  }
</style>
