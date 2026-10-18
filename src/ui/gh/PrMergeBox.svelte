<script lang="ts">
  // The merge box: whether the pull request can be merged and why not, in words, then merging it
  // (a second step to confirm, with the squash commit's message), auto-merge, and draft or ready.
  // Once merged or closed, it offers (never does by itself) to switch to the base branch and to
  // delete the local branch.
  import { Button, ConfirmButton, Kbd, Segmented, TextArea, formatFull, formatRelative, matches, tooltip } from 'purr';
  import { CheckCircle, Circle, GitMerge, GitPullRequestClosed, Lightning, UserCircle, XCircle } from 'purr/icons';
  import { untrack } from 'svelte';
  import type { BranchInfo } from '../../shared/types.ts';
  import type { MergeMethod, PrOverview } from '../../shared/gh-prview.ts';
  import { app, request } from '../lib/app.svelte.ts';
  import { deleteBranch, switchOp } from '../lib/branches.svelte.ts';
  import { METHOD_LABEL, METHOD_NOTE, METHOD_SHORT, checksLabel, mergeStatus } from '../lib/gh-prview.ts';
  import { gh } from '../lib/github.svelte.ts';
  import { tip } from '../lib/tip.ts';

  interface Props {
    pr: PrOverview;
    act: (name: string, body?: Record<string, unknown>, done?: string) => Promise<boolean>;
    working: boolean;
  }
  let { pr, act, working }: Props = $props();

  const status = $derived(mergeStatus(pr));
  let method = $state<MergeMethod>(untrack(() => pr.defaultMethod));
  let title = $state(untrack(() => pr.squash.title));
  let message = $state(untrack(() => pr.squash.message));
  let confirming = $state(false);

  const TONE = { success: 'var(--success)', warn: 'var(--warn)', danger: 'var(--danger)', neutral: 'var(--muted)' };
  const CHECK = {
    success: { icon: CheckCircle, color: 'var(--success)' },
    failure: { icon: XCircle, color: 'var(--danger)' },
    error: { icon: XCircle, color: 'var(--danger)' },
    pending: { icon: Circle, color: 'var(--warn)' },
    expected: { icon: Circle, color: 'var(--warn)' },
  };
  const REVIEWS = {
    approved: { text: 'Approved', icon: CheckCircle, color: 'var(--success)' },
    changes: { text: 'Changes requested', icon: XCircle, color: 'var(--danger)' },
    required: { text: 'Review required', icon: UserCircle, color: 'var(--warn)' },
  };

  const commits = $derived(`${pr.commitCount} commit${pr.commitCount === 1 ? '' : 's'}`);
  const fields = $derived(method === 'squash');
  const AFTER = $derived({
    squash: `${commits} become one commit on ${pr.base}.`,
    rebase: `${commits} are replayed onto ${pr.base}.`,
    merge: `${commits} and a merge commit go onto ${pr.base}.`,
  });

  async function merge() {
    const body = { method, sha: pr.headSha, ...(fields ? { title, message } : {}) };
    if (!(await act('prviewMerge', body, `Merged #${pr.number} into ${pr.base}`))) return;
    confirming = false;
    gh.refresh({ fresh: true });
    app.fetchRemote(true).then(loadBranches);
  }

  async function autoMerge(enable: boolean) {
    const body = enable ? { id: pr.id, enable, method, sha: pr.headSha, ...(fields ? { title, message } : {}) } : { id: pr.id, enable };
    await act('prviewAutoMerge', body, enable ? `#${pr.number} merges by itself once it can` : `Auto-merge is off for #${pr.number}`);
  }

  async function setDraft(draft: boolean) {
    const done = draft ? `#${pr.number} is a draft again` : `#${pr.number} is ready for review`;
    if (await act('prviewDraft', { id: pr.id, draft }, done)) gh.refresh({ fresh: true });
  }

  function onConfirmKey(e: KeyboardEvent) {
    if (matches('⌘↩', e)) {
      e.preventDefault();
      merge();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      confirming = false;
    }
  }

  // Once it's merged or closed: the local branches, to offer switching to the base and deleting the head.
  let branches = $state.raw<BranchInfo[] | null>(null);
  async function loadBranches() {
    try {
      branches = await request<BranchInfo[]>('/api/branches');
    } catch {
      branches = null;
    }
  }
  $effect(() => {
    if (pr.state === 'merged' || pr.state === 'closed') untrack(loadBranches);
  });
  const local = $derived(branches?.find((b) => b.name === pr.head) ?? null);
  const baseLocal = $derived(branches?.some((b) => b.name === pr.base) ?? false);
  const onBase = $derived(app.repo?.branch === pr.base);

  async function switchToBase() {
    const remote = app.repo?.push?.remote ?? 'origin';
    const ok = baseLocal
      ? await switchOp('switch', { branch: pr.base }, pr.base)
      : await switchOp('checkoutRemote', { ref: `refs/remotes/${remote}/${pr.base}` }, pr.base);
    if (ok) loadBranches();
  }

  async function removeHead() {
    if (await deleteBranch(pr.head)) loadBranches();
  }
</script>

{#snippet line(Icon: typeof Circle, color: string, text: string, weight: 'fill' | 'regular' = 'fill')}
  <div class="line">
    <span class="mark" style:color aria-hidden="true"><Icon {weight} /></span>
    <span>{text}</span>
  </div>
{/snippet}

{#snippet afterwards()}
  {#if branches && (local || !onBase)}
    <div class="offers">
      {#if !onBase}
        <Button onclick={switchToBase} disabled={app.busy} {@attach tip(`Switch to ${pr.base}, asking about uncommitted changes first`)}>Switch to {pr.base}</Button>
      {/if}
      {#if local}
        <ConfirmButton
          variant="default"
          confirmLabel="Delete {pr.head}?"
          disabled={app.busy || local.current || !!local.worktree}
          {@attach tip(
            local.current ? `You're on ${pr.head}: switch to another branch first`
            : local.worktree ? `It's checked out in ${local.worktree}`
            : `Kept under Recently deleted for two weeks`,
          )}
          onconfirm={removeHead}>Delete local {pr.head}</ConfirmButton
        >
      {/if}
    </div>
  {/if}
{/snippet}

{#if pr.state === 'merged'}
  <section class="box" style:--tone="var(--theme)" aria-label="Merged">
    <div class="status">
      <span class="badge" aria-hidden="true"><GitMerge weight="bold" /></span>
      <div>
        <b>Merged into {pr.base}</b>
        {#if pr.mergedAt}
          <p class="muted">By {pr.mergedBy?.login ?? 'someone'}, <span use:tooltip={formatFull(pr.mergedAt)}>{formatRelative(pr.mergedAt)}</span>.</p>
        {/if}
      </div>
    </div>
    {@render afterwards()}
  </section>
{:else if pr.state === 'closed'}
  <section class="box" style:--tone="var(--danger)" aria-label="Closed">
    <div class="status">
      <span class="badge" aria-hidden="true"><GitPullRequestClosed weight="bold" /></span>
      <div>
        <b>Closed with unmerged commits</b>
      </div>
    </div>
    {@render afterwards()}
  </section>
{:else}
  <section class="box" style:--tone={TONE[status.tone]} aria-label="Merge">
    <div class="status">
      <span class="badge" aria-hidden="true">
        {#if status.canMerge}<GitMerge weight="bold" />{:else}<GitMerge />{/if}
      </span>
      <div>
        <b>{status.title}</b>
        <p class="muted">{status.detail}</p>
      </div>
    </div>

    <div class="lines">
      {#if pr.checks}
        {@render line(CHECK[pr.checks].icon, CHECK[pr.checks].color, checksLabel(pr.checks))}
      {:else}
        {@render line(Circle, 'var(--faint)', checksLabel(null), 'regular')}
      {/if}
      {#if pr.reviewDecision}
        {@const r = REVIEWS[pr.reviewDecision]}
        {@render line(r.icon, r.color, r.text)}
      {/if}
      {#if pr.autoMerge}
        <div class="line">
          <span class="mark" style:color="var(--success)" aria-hidden="true"><Lightning weight="fill" /></span>
          <span use:tooltip={`It will ${METHOD_LABEL[pr.autoMerge.method].toLowerCase()} once everything required passes`}>
            Auto-merge is on{pr.autoMerge.by ? ` (${pr.autoMerge.by})` : ''}
          </span>
          <span class="spacer"></span>
          <Button size="sm" disabled={working || !pr.canAutoMerge} onclick={() => autoMerge(false)}>Disable</Button>
        </div>
      {/if}
    </div>

    {#if pr.state === 'draft'}
      <div class="actions">
        {#if pr.canUpdate}
          <Button variant="primary" disabled={working} onclick={() => setDraft(false)} {@attach tip("Let reviewers know it's ready, and allow merging")}>
            Ready for review
          </Button>
        {/if}
      </div>
    {:else if confirming}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="confirm" onkeydown={onConfirmKey}>
        {#if fields}
          <input class="field-input" bind:value={title} aria-label="Commit title" spellcheck="true" />
          <TextArea bind:value={message} rows={4} aria-label="Commit message" mono />
        {/if}
        <div class="actions">
          <Button variant="primary" disabled={working || !status.canMerge || (fields && !title.trim())} onclick={merge}>
            Confirm {METHOD_LABEL[method].toLowerCase()} <Kbd hint="⌘↩" />
          </Button>
          <Button onclick={() => (confirming = false)}>Cancel <Kbd hint="Esc" /></Button>
          <span class="muted note">
            {AFTER[method]} GitHub refuses it if someone pushes to {pr.head} meanwhile.
          </span>
        </div>
      </div>
    {:else}
      <div class="actions">
        {#if pr.methods.length > 1}
          <Segmented label="How to merge" size="sm" options={pr.methods.map((m) => ({ id: m, label: METHOD_SHORT[m] }))} bind:value={method} />
        {/if}
        <Button
          variant="primary"
          disabled={working || !status.canMerge}
          {@attach tip(status.canMerge ? METHOD_NOTE[method] : status.title)}
          onclick={() => (confirming = true)}
        >
          <GitMerge /> {METHOD_LABEL[method]}
        </Button>
        {#if !status.canMerge && status.waits && pr.canAutoMerge && !pr.autoMerge}
          <Button
            disabled={working}
            onclick={() => autoMerge(true)}
            {@attach tip(`GitHub merges it (${METHOD_LABEL[method].toLowerCase()}) as soon as what it waits for is done`)}
          >
            <Lightning /> Enable auto-merge
          </Button>
        {/if}
        <span class="spacer"></span>
        {#if pr.canUpdate}
          <button class="btn btn--link" disabled={working} onclick={() => setDraft(true)} use:tooltip={"Mark it in progress; drafts can't be merged"}>
            Convert to draft
          </button>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  .box {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    padding: var(--sp-4);
    border: 1px solid color-mix(in oklab, var(--tone) 40%, var(--border));
    border-radius: var(--radius-lg);
    background: color-mix(in oklab, var(--tone) 5%, var(--surface));
  }

  .status {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-4);
  }

  .status b {
    color: var(--color2);
  }

  .status p {
    margin: var(--gap-1) 0 0;
    font-size: var(--fs-sm);
  }

  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: calc(var(--btn) + var(--sp-2));
    height: calc(var(--btn) + var(--sp-2));
    border-radius: var(--radius-pill);
    background: var(--tone);
    color: var(--on-accent);
    font-size: var(--icon-lg);
  }

  .lines {
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
    padding-top: var(--sp-3);
    border-top: 1px solid var(--border);
    font-size: var(--fs-sm);
  }

  .line {
    display: flex;
    align-items: center;
    gap: var(--gap-4);
  }

  .mark {
    display: inline-flex;
    font-size: var(--icon-lg);
  }

  .actions,
  .offers {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--gap-4);
  }

  .confirm {
    display: flex;
    flex-direction: column;
    gap: var(--gap-4);
  }

  .note {
    font-size: var(--fs-sm);
  }

  .spacer {
    flex: 1;
  }
</style>
