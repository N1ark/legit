<script lang="ts">
  // A commit's checks, in the checks popover: each workflow run with its jobs (expanding to their
  // steps, each step one click from its log), other apps' checks, and commit statuses. Runs can be
  // re-run or cancelled from here.
  import { Button, ConfirmButton, IconButton, Spinner, Tag, Twisty, formatFull, tooltip } from 'purr';
  import { ArrowClockwise, ArrowSquareOut, FileText } from 'purr/icons';
  import CheckIcon from './CheckIcon.svelte';
  import { shortSha } from '../lib/app.svelte.ts';
  import { checks } from '../lib/gh-checks.svelte.ts';
  import { STATE_LABEL, describeCounts, duration, formatDuration } from '../lib/gh-checks.ts';
  import { FINISHED, type CheckGroup, type CheckJob, type CheckState, type JobStep } from '../../shared/gh-checks.ts';
  import { tip } from '../lib/tip.ts';

  interface Props {
    sha: string;
  }
  let { sha }: Props = $props();

  const data = $derived(checks.details[sha]);

  // Running durations count up while the popover is open.
  let now = $state(Date.now());
  $effect(() => {
    if (!data || !checks.active(sha)) return;
    const tick = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(tick);
  });

  const took = (state: CheckState, from: string | null, to: string | null) => {
    const ms = duration(state, from, to, now);
    return ms === null ? '' : formatDuration(ms);
  };
  const runOver = (g: CheckGroup) => g.jobs.every((j) => FINISHED.has(j.state));
  const failed = (g: CheckGroup) => g.jobs.some((j) => j.state === 'failure' || j.state === 'cancelled');
  const stateText = (s: CheckState, name: string) => `${name}: ${STATE_LABEL[s].toLowerCase()}`;
  const hasLog = (j: CheckJob) => j.jobId !== null && FINISHED.has(j.state) && j.state !== 'skipped';

  function openLog(j: CheckJob, step: number | null = null) {
    if (j.jobId === null) return;
    checks.log = { jobId: j.jobId, name: j.name, url: j.url, step };
  }

  function openStep(j: CheckJob, s: JobStep) {
    if (hasLog(j) && s.state !== 'skipped') openLog(j, s.number);
  }
</script>

<div class="head">
  <b>Checks</b>
  <span class="mono sha">{shortSha(sha)}</span>
  {#if data}<span class="muted summary">{describeCounts(data.counts)}</span>{/if}
</div>

{#if !data}
  <p class="muted note"><Spinner size={12} /> Loading…</p>
{:else if !data.groups.length}
  <p class="muted note">No checks</p>
{:else}
  {#each data.groups as g (g.key)}
    <section aria-label={stateText(g.state, g.name)}>
      <div class="group">
        <span class="st" use:tooltip={STATE_LABEL[g.state]}><CheckIcon state={g.state} /></span>
        <span class="group-name">{g.name}</span>
        {#if g.runNumber}<span class="muted meta">#{g.runNumber}{g.event ? ` · ${g.event.replaceAll('_', ' ')}` : ''}</span>{/if}
        <span class="spacer"></span>
        {#if g.runId}
          {@const runId = g.runId}
          {#if !runOver(g)}
            <ConfirmButton
              size="sm"
              variant="ghost"
              confirmLabel="Cancel the run?"
              onconfirm={() => checks.act(sha, 'checksCancel', { run: runId }, `Cancelling ${g.name}`)}>Cancel</ConfirmButton
            >
          {:else}
            {#if failed(g)}
              <Button
                size="sm"
                onclick={() => checks.act(sha, 'checksRerunFailed', { run: runId }, `Re-running the failed jobs of ${g.name}`)}
              >
                <ArrowClockwise /> Re-run failed
              </Button>
            {/if}
            <Button size="sm" variant="ghost" onclick={() => checks.act(sha, 'checksRerun', { run: runId }, `Re-running every job of ${g.name}`)}>
              Re-run all
            </Button>
          {/if}
        {/if}
        {#if g.url}
          <a class="btn btn--icon btn--ghost btn--sm" href={g.url} target="_blank" rel="noreferrer" aria-label="Open the run on GitHub" use:tooltip={'Open the run on GitHub'}
            ><ArrowSquareOut /></a
          >
        {/if}
      </div>
      <ul>
        {#each g.jobs as j (j.key)}
          {@const open = j.jobId !== null && checks.expanded.has(j.jobId)}
          {@const steps = j.jobId !== null ? checks.jobs[j.jobId] : undefined}
          <li class="job" class:failed={j.state === 'failure'}>
            {#if j.jobId !== null}
              {@const jobId = j.jobId}
              <button
                class="twisty"
                aria-expanded={open}
                aria-label={open ? `Hide the steps of ${j.name}` : `Show the steps of ${j.name}`}
                onclick={() => checks.toggleJob(jobId)}><Twisty {open} size={10} /></button
              >
            {:else}
              <span class="twisty"></span>
            {/if}
            <span class="st" use:tooltip={STATE_LABEL[j.state]} aria-label={STATE_LABEL[j.state]} role="img"><CheckIcon state={j.state} /></span>
            <span class="name" use:tooltip={j.description ?? j.name}>
              {j.name}
              {#if j.description}<span class="muted desc">{j.description}</span>{/if}
            </span>
            {#if j.required}<span use:tooltip={"Required by the base branch's protection rules"}><Tag label="Required" /></span>{/if}
            <span class="muted time" use:tooltip={j.startedAt ? `Started ${formatFull(Date.parse(j.startedAt))}` : null}
              >{j.state === 'pending' ? 'queued' : took(j.state, j.startedAt, j.completedAt)}</span
            >
            {#if j.jobId !== null}
              {@const jobId = j.jobId}
              {#if FINISHED.has(j.state) && j.state !== 'success' && j.state !== 'skipped' && runOver(g)}
                <IconButton
                  size="sm"
                  label="Re-run this job"
                  onclick={() => checks.act(sha, 'checksRerunJob', { job: jobId }, `Re-running ${j.name}`)}><ArrowClockwise /></IconButton
                >
              {/if}
              {#if j.state === 'failure'}
                <Button size="sm" variant="danger" onclick={() => openLog(j)} {@attach tip('Show the log of the step that failed')}>
                  <FileText /> Log
                </Button>
              {:else}
                <IconButton
                  size="sm"
                  label="Show the log"
                  tip={hasLog(j) ? 'Show the log' : 'GitHub has the log once the job finishes'}
                  disabled={!hasLog(j)}
                  onclick={() => openLog(j)}><FileText /></IconButton
                >
              {/if}
            {/if}
            {#if j.url}
              <a class="btn btn--icon btn--ghost btn--sm" href={j.url} target="_blank" rel="noreferrer" aria-label="Open on GitHub" use:tooltip={'Open on GitHub'}
                ><ArrowSquareOut /></a
              >
            {/if}
          </li>
          {#if open}
            {#if !steps}
              <li class="steps muted"><Spinner size={12} /> Loading…</li>
            {:else if !steps.steps.length}
              <li class="steps muted">Queued</li>
            {:else}
              {#each steps.steps as s (s.number)}
                {@const clickable = hasLog(j) && s.state !== 'skipped'}
                <li class="step" class:failed={s.state === 'failure'}>
                  <button
                    class="step-button"
                    disabled={!clickable}
                    aria-label="{s.name}: {STATE_LABEL[s.state].toLowerCase()}{clickable ? '. Show its log' : ''}"
                    use:tooltip={clickable ? 'Show its log' : null}
                    onclick={() => openStep(j, s)}
                  >
                    <CheckIcon state={s.state} />
                    <span class="name">{s.name}</span>
                    <span class="muted time">{took(s.state, s.startedAt, s.completedAt)}</span>
                  </button>
                </li>
              {/each}
            {/if}
          {/if}
        {/each}
      </ul>
    </section>
  {/each}
{/if}

<style>
  .head {
    display: flex;
    align-items: baseline;
    gap: var(--gap-4);
    padding: var(--gap-1) var(--gap-3) var(--gap-4);
  }

  .sha {
    color: var(--theme2);
    font-size: var(--fs-sm);
  }

  .summary {
    font-size: var(--fs-sm);
  }

  .note {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    margin: var(--gap-3);
  }

  section + section {
    border-top: 1px solid var(--border);
    margin-top: var(--gap-3);
    padding-top: var(--gap-3);
  }

  .group,
  .job,
  .step-button,
  .steps {
    display: flex;
    align-items: center;
    gap: var(--gap-4);
    min-height: 28px;
    padding: 0 var(--gap-3);
  }

  .group {
    font-weight: 600;
    color: var(--color2);
  }

  .group :global(.icon),
  .job :global(.icon),
  .step-button :global(.icon) {
    font-size: var(--icon-lg);
  }

  .st {
    display: inline-flex;
  }

  .group-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    font-weight: normal;
    font-size: var(--fs-xs);
  }

  .spacer {
    flex: 1;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .job {
    border-radius: var(--radius);
  }

  @media (hover: hover) {
    .job:hover {
      background: var(--bg3);
    }
  }

  .job.failed {
    background: var(--del-bg);
  }

  .twisty {
    all: unset;
    width: 14px;
    display: flex;
    justify-content: center;
    flex-shrink: 0;
    cursor: pointer;
  }

  .twisty:focus-visible {
    outline: 2px solid var(--theme);
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .desc {
    margin-left: var(--gap-3);
    font-size: var(--fs-xs);
  }

  .time {
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .step {
    padding-left: 36px;
  }

  .step-button {
    width: 100%;
    border-radius: var(--radius);
    font-size: var(--fs-sm);
    text-align: left;
    cursor: pointer;
  }

  .step-button:disabled {
    cursor: default;
  }

  @media (hover: hover) {
    .step-button:not(:disabled):hover {
      background: var(--bg3);
    }
  }

  .step.failed .step-button {
    color: var(--danger);
    font-weight: 600;
  }

  .steps {
    padding-left: 44px;
    font-size: var(--fs-xs);
  }
</style>
