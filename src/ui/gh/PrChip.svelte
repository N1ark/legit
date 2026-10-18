<script lang="ts">
  // The current branch's pull request, in the header: its state and number, opening a card with
  // its title, branches and author, the way to its overview (first; P from anywhere) and to
  // GitHub, and the stack it's in (pull requests based on one another's branches), trunk at the
  // bottom as `gt log` draws it. Choosing one switches to its branch; when the branch it's stacked
  // on has moved on or was merged, the card offers to restack it. The chip is lit while the
  // overview is shown. A branch without a pull request gets "Create pull request" instead.
  import { Avatar, Button, Callout, ConfirmButton, Kbd, Popover, tooltip } from 'purr';
  import { ArrowSquareOut, Article, GitBranch, GitPullRequest, Stack, Warning } from 'purr/icons';
  import { untrack } from 'svelte';
  import { app } from '../lib/app.svelte.ts';
  import { gh } from '../lib/github.svelte.ts';
  import { STATE_LABEL } from '../lib/gh-pr.ts';
  import { openCreatePr, prs, restack, retarget, switchToEntry } from '../lib/gh-prs.svelte.ts';
  import Markdown from '../Markdown.svelte';
  import { tip } from '../lib/tip.ts';
  import CreatePr from './CreatePr.svelte';
  import PrBadge from './PrBadge.svelte';
  import type { RestackPlan, StackEntry } from '../../shared/gh-stack.ts';

  let open = $state(false);
  let button = $state<HTMLButtonElement>();

  const pr = $derived(gh.pr);
  const stack = $derived(prs.stack);
  const plan = $derived(stack?.restack ?? null);
  const behind = $derived(stack?.entries.find((e) => e.current)?.behind ?? 0);
  const disabled = $derived(app.busy || !!app.repo?.blocked);
  /** Not on the default branch (nor detached), so a pull request could be opened from it. */
  const canCreate = $derived(gh.ready && pr === null && !!app.repo?.branch && !!app.repo.base);
  const chipLabel = $derived(
    pr ? `Pull request #${pr.number}, ${STATE_LABEL[pr.state].toLowerCase()}${plan ? ', needs restack' : ''}: ${pr.title}` : '',
  );
  /** Its overview is what the main area shows. */
  const shown = $derived(!!pr && gh.view?.kind === 'pr' && gh.view.number === pr.number);

  // The stack follows each refresh of the pull request (its branch, its tip, what was fetched).
  $effect(() => {
    void gh.tick;
    untrack(() => prs.refreshed());
  });
  $effect(() => {
    if (!pr) open = false;
  });

  function show() {
    open = !open;
    if (open) prs.loadStack();
  }

  async function choose(e: StackEntry) {
    if (e.current) return;
    if (await switchToEntry(e)) open = false;
  }

  function rebase(plan: RestackPlan) {
    open = false;
    restack(plan);
  }

  function overview() {
    if (!pr) return;
    open = false;
    gh.showPr(pr.number);
  }

  const count = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;
  const entryTitle = (e: StackEntry) =>
    e.current ? 'The branch you are on'
    : e.worktree ? `Checked out in ${e.worktree}; choosing it switches to that worktree`
    : e.branch ? `Switch to ${e.branch}`
    : e.remoteRef ? `Check out ${e.pr.head} from the remote`
    : `${e.pr.head} isn't here; fetch first`;
</script>

{#if pr}
  <button bind:this={button} class="btn btn--ghost chip" class:shown onclick={show} aria-expanded={open} aria-label={chipLabel} use:tooltip={chipLabel}>
    <PrBadge {pr} word />
    {#if plan}<span class="needs" aria-hidden="true"><Warning weight="bold" /></span>{/if}
  </button>
{:else if canCreate}
  <Button variant="ghost" size="sm" onclick={openCreatePr} {@attach tip(`Open a pull request for ${app.repo?.branch} on GitHub`)}>
    <GitPullRequest /> Create PR
  </Button>
{/if}

{#if open && button && pr}
  <Popover anchor={button} label="Pull request #{pr.number}" onclose={() => (open = false)} width="min(520px, calc(100vw - 32px))" padding="var(--sp-4)">
    <div class="card">
      <button class="head" use:tooltip={'Show its overview'} onclick={overview}>
        <PrBadge {pr} word />
        <span class="title"><Markdown text={pr.title} inline links="off" /></span>
      </button>
      <div class="meta muted">
        <span class="mono refs" use:tooltip={`${pr.head} merges into ${pr.base}`}>{pr.base} ← {pr.head}</span>
        {#if pr.author}
          <span class="by"><Avatar name={pr.author.login} src={pr.author.avatar} size={16} round title="" /> {pr.author.login}</span>
        {/if}
      </div>
      <div class="actions">
        <Button size="sm" variant="primary" onclick={overview}><Article /> Overview <Kbd hint="p" /></Button>
        <Button size="sm" onclick={() => app.openUrl(pr.url)}><ArrowSquareOut /> GitHub</Button>
      </div>

      {#if plan}
        <Callout tone="warn" title={plan.why === 'merged' ? `#${plan.parent.number} was merged` : `${plan.parent.head} has moved on`}>
          <p>
            {#if plan.why === 'merged'}
              {#if plan.onto}Rebasing replays this branch's {count(plan.shas.length)}, without {plan.parent.head}'s; ⌘Z undoes it.{/if}
              {#if plan.retarget}#{pr.number} still merges into <span class="mono">{plan.parent.head}</span>.{/if}
            {:else}
              <span use:tooltip={`${plan.parent.head} (#${plan.parent.number}) has ${behind ? count(behind) : 'commits'} this branch doesn't`}
                >Restacking replays this branch's {count(plan.shas.length)} on top; ⌘Z undoes it.</span
              >
            {/if}
          </p>
          <div class="actions">
            {#if plan.onto}
              <Button size="sm" variant="primary" {disabled} onclick={() => rebase(plan)}>
                <Stack /> {plan.why === 'merged' ? `Rebase onto ${plan.onto}` : `Restack on ${plan.onto}`}
              </Button>
            {/if}
            {#if plan.retarget}
              <ConfirmButton size="sm" confirmLabel="Change #{pr.number}'s base on GitHub" onconfirm={() => retarget(plan)}>
                <GitPullRequest /> Retarget #{pr.number} to {plan.retarget}
              </ConfirmButton>
            {/if}
          </div>
        </Callout>
      {/if}

      {#if stack && stack.entries.length > 1}
        <h3 class="muted">Stack</h3>
        <ol class="stack" aria-label="Pull requests stacked with #{pr.number}, top first">
          {#each stack.entries as e (e.pr.number)}
            <li style:--indent={e.indent}>
              <button
                class="row-item entry"
                class:is-current={e.current}
                aria-current={e.current ? 'true' : undefined}
                disabled={!e.current && (disabled || (!e.branch && !e.remoteRef && !e.worktree))}
                use:tooltip={entryTitle(e)}
                onclick={() => choose(e)}
              >
                <span class="rail" aria-hidden="true"><span class="dot"></span></span>
                <span class="body">
                  <span class="line">
                    <PrBadge pr={e.pr} />
                    <span class="title"><Markdown text={e.pr.title} inline links="off" /></span>
                  </span>
                  <span class="line muted">
                    <span class="mono branch">{e.pr.head}</span>
                    {#if e.restack}
                      <span class="restack" use:tooltip={`${e.pr.base} has ${count(e.behind ?? 0)} this branch doesn't`}>needs restack</span>
                    {:else if e.ahead !== null}
                      <span class="counts" use:tooltip={`${count(e.ahead)} on top of ${e.pr.base}${e.behind ? `, which has ${count(e.behind)} it doesn't` : ''}`}>
                        ↑{e.ahead}{#if e.behind}&nbsp;↓{e.behind}{/if}
                      </span>
                    {:else if !e.branch && !e.remoteRef}
                      <span>not fetched</span>
                    {/if}
                    {#if e.worktree}<span>in another worktree</span>{/if}
                  </span>
                </span>
              </button>
            </li>
          {/each}
          <li class="trunk">
            <span class="rail" aria-hidden="true"><span class="dot"></span></span>
            <GitBranch />
            <span class="mono">{stack.trunk}</span>
          </li>
        </ol>
      {/if}
    </div>
  </Popover>
{/if}

{#if prs.creating}
  <CreatePr onclose={() => (prs.creating = false)} />
{/if}

<style>
  .chip {
    gap: var(--gap-2);
  }

  .chip.shown {
    background: var(--theme-soft);
  }

  .needs {
    display: inline-flex;
    color: var(--warn);
    font-size: var(--icon-sm);
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: var(--gap-3);
    font-size: var(--fs-lg);
    font-weight: 600;
    color: var(--color2);
    text-align: left;
    min-width: 0;
  }

  @media (hover: hover) {
    .head:hover .title {
      color: var(--theme2);
      text-decoration: underline;
    }
  }

  .head :global(.pr) {
    font-size: var(--fs-sm);
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--gap-2) var(--sp-4);
    font-size: var(--fs-sm);
  }

  .refs {
    overflow-wrap: anywhere;
  }

  .by {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-2);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-2);
  }

  .card :global(.callout) {
    margin: 0;
  }

  p {
    margin: 0 0 var(--gap-3);
    font-size: var(--fs-sm);
  }

  h3 {
    margin: var(--gap-3) 0 0;
    font-size: var(--fs-xs);
    font-weight: 600;
  }

  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 50vh;
    overflow: auto;
  }

  li {
    padding-left: calc(var(--indent, 0) * var(--sp-5));
  }

  .entry {
    width: 100%;
    align-items: stretch;
    text-align: left;
    height: auto;
  }

  /* The stack's line, through every entry down to the trunk, with a dot per entry. */
  .rail {
    position: relative;
    width: 12px;
    flex-shrink: 0;
  }

  .rail::before {
    content: '';
    position: absolute;
    left: 5px;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--border-strong);
  }

  li:first-child .rail::before {
    top: 50%;
  }

  .trunk .rail::before {
    bottom: 50%;
  }

  .dot {
    position: absolute;
    left: 1px;
    top: calc(50% - 5px);
    width: 10px;
    height: 10px;
    border-radius: var(--radius-pill);
    background: var(--bg);
    border: 2px solid var(--border-strong);
  }

  .is-current .dot {
    background: var(--theme2);
    border-color: var(--theme2);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--gap-1);
    min-width: 0;
    flex: 1;
    padding: var(--gap-3) 0;
  }

  .line {
    display: flex;
    align-items: baseline;
    gap: var(--gap-3);
    min-width: 0;
    font-size: var(--fs-xs);
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .line .title {
    font-size: var(--fs-base);
    color: var(--color2);
  }

  .is-current .title {
    font-weight: 600;
  }

  .branch {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .counts {
    font-family: var(--mono);
    flex-shrink: 0;
  }

  .restack {
    color: var(--warn);
    font-weight: 600;
    flex-shrink: 0;
  }

  .trunk {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    min-height: var(--row-h);
    padding-left: var(--sp-3);
    font-size: var(--fs-sm);
    color: var(--muted);
  }
</style>
