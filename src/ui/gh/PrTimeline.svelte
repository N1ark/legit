<script lang="ts">
  // A pull request's conversation, in the order things happened (oldest or newest first, as picked):
  // comments (the viewer's own editable), reviews with the threads started in them, threads started
  // alone, pushes (each commit with its checks, opening its diff), and everything else as one-line
  // events. `composer` (the merge box and comment box) goes at the newest end.
  import { Avatar, Button, ConfirmButton, IconButton, Kbd, Segmented, Tag, TextArea, formatFull, formatRelative, matches, tooltip } from 'purr';
  import { ArrowsClockwiseRegular, ChatCircleFill, ChatCircleRegular, ChatsCircleRegular, CheckCircleFill, CircleFill, CircleRegular, CrosshairRegular, EyeRegular, FlagRegular, GitBranchRegular, GitCommitRegular, GitMergeBold, GitPullRequestClosedBold, GitPullRequestDraftRegular, GitPullRequestRegular, HourglassRegular, PencilSimpleRegular, TagRegular, TextTRegular, TrashRegular, UserMinusRegular, UserPlusRegular, XCircleFill, type GlyphComponent } from 'purr/glyphs';
  import type { Snippet } from 'svelte';
  import type { CheckState, PrComment, PrEventType, PrOverview, ReviewState } from '../../shared/gh-prview.ts';
  import type { ReviewThread } from '../../shared/gh-review.ts';
  import Markdown from '../Markdown.svelte';
  import { app, conversationOrder } from '../lib/app.svelte.ts';
  import { checks } from '../lib/gh-checks.svelte.ts';
  import { conversation, unresolvedOf } from '../lib/gh-conversation.ts';
  import { prDiffs } from '../lib/gh-prdiff.svelte.ts';
  import { eventText, ghAvatar, pushedText } from '../lib/gh-prview.ts';
  import { reviews } from '../lib/gh-review.svelte.ts';
  import { linesLabel } from '../lib/gh-threads.ts';
  import { gh } from '../lib/github.svelte.ts';
  import { tip } from '../lib/tip.ts';
  import SuggestionBatch from './SuggestionBatch.svelte';
  import Thread from './Thread.svelte';

  interface Props {
    pr: PrOverview;
    act: (name: string, body?: Record<string, unknown>, done?: string) => Promise<boolean>;
    working: boolean;
    /** What follows the newest entry: the merge box and the comment box. */
    composer: Snippet;
  }
  let { pr, act, working, composer }: Props = $props();

  $effect(() => {
    void gh.tick;
    reviews.load(pr.number);
  });
  $effect(() => prDiffs.loadCommits(pr));

  const data = $derived(reviews.byNumber[pr.number] ?? null);
  const commits = $derived(prDiffs.allCommits(pr));
  const newest = $derived(conversationOrder.value === 'newest');
  const entries = $derived(conversation({ timeline: pr.timeline, threads: data?.threads ?? [], commits, pending: data?.pending?.id ?? null }, newest));
  const unresolved = $derived(unresolvedOf(entries));
  const resolved = $derived((data?.threads.length ?? 0) - unresolved.length);
  /** The branch's own pull request: its commits that are in the list open there, where they can be edited. */
  const ours = $derived(gh.pr?.number === pr.number);

  // Merged and closed in bold, as their badges are.
  const EVENT_ICON: Record<PrEventType, GlyphComponent> = {
    merged: GitMergeBold,
    closed: GitPullRequestClosedBold,
    reopened: GitPullRequestRegular,
    ready: EyeRegular,
    draft: GitPullRequestDraftRegular,
    'force-pushed': ArrowsClockwiseRegular,
    'review-requested': UserPlusRegular,
    'review-request-removed': UserPlusRegular,
    labeled: TagRegular,
    unlabeled: TagRegular,
    'base-changed': GitBranchRegular,
    renamed: TextTRegular,
    'head-deleted': GitBranchRegular,
    assigned: UserPlusRegular,
    unassigned: UserMinusRegular,
    milestoned: FlagRegular,
    demilestoned: FlagRegular,
  };

  const REVIEW: Record<ReviewState, { icon: GlyphComponent; color: string; text: string }> = {
    approved: { icon: CheckCircleFill, color: 'var(--success)', text: 'approved these changes' },
    changes: { icon: XCircleFill, color: 'var(--danger)', text: 'requested changes' },
    commented: { icon: ChatCircleFill, color: 'var(--muted)', text: 'reviewed' },
    dismissed: { icon: ChatCircleFill, color: 'var(--faint)', text: 'reviewed (dismissed)' },
    pending: { icon: ChatCircleFill, color: 'var(--faint)', text: 'started a review' },
  };

  const CHECK: Record<NonNullable<CheckState>, { icon: GlyphComponent; color: string; label: string }> = {
    success: { icon: CheckCircleFill, color: 'var(--success)', label: 'Checks passed' },
    failure: { icon: XCircleFill, color: 'var(--danger)', label: 'Checks failed' },
    error: { icon: XCircleFill, color: 'var(--danger)', label: 'Checks errored' },
    pending: { icon: CircleFill, color: 'var(--warn)', label: 'Checks running' },
    expected: { icon: CircleFill, color: 'var(--warn)', label: 'Checks expected' },
  };

  const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

  function open(sha: string) {
    if (ours && app.bySha.has(sha)) app.select(sha);
    else prDiffs.show(pr, { kind: 'commit', sha });
  }

  let editing = $state<string | null>(null);
  let draft = $state('');

  function edit(c: PrComment) {
    draft = c.body;
    editing = c.id;
  }

  async function save(c: PrComment) {
    if (draft === c.body) return void (editing = null);
    if (await act('prviewEditComment', { dbId: c.dbId, body: draft })) editing = null;
  }

  function onEditKey(e: KeyboardEvent, c: PrComment) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      editing = null;
    } else if (matches('⌘↩', e)) {
      e.preventDefault();
      save(c);
    }
  }

  // "N unresolved" goes to each in turn, in the order shown, opening it.
  let list = $state<HTMLElement | null>(null);
  let jumped = -1;
  let flash = $state<string | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  function goTo(t: ReviewThread) {
    const el = list?.querySelector<HTMLElement>(`[data-thread="${CSS.escape(t.id)}"]`);
    if (!el) return;
    if (!reviews.isOpen(t)) reviews.toggle(t);
    el.scrollIntoView({ block: 'center' });
    el.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    flash = t.id;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (flash = null), 1200);
  }

  function nextUnresolved() {
    if (!unresolved.length) return;
    jumped = (jumped + 1) % unresolved.length;
    goTo(unresolved[jumped]);
  }

  async function discard() {
    await reviews.discard(pr.number);
  }

  const when = (at: string) => formatRelative(at);
</script>

{#snippet time(at: string)}
  <time class="muted" datetime={at} use:tooltip={formatFull(at)}>{when(at)}</time>
{/snippet}

{#snippet who(u: { login: string; avatar: string | null } | null, size: number)}
  <Avatar name={u?.login ?? 'ghost'} src={ghAvatar(u?.avatar)} {size} round />
  <b>{u?.login ?? 'ghost'}</b>
{/snippet}

{#snippet compare(from: string, to: string, label: string, note: string)}
  <button class="btn btn--link compare" use:tooltip={note} onclick={() => prDiffs.show(pr, { kind: 'compare', from, to, label })}>Compare</button>
{/snippet}

{#snippet thread(t: ReviewThread)}
  {@const w = reviews.where(pr.number, t)}
  <div class="row" class:flash={flash === t.id} data-thread={t.id}>
    <div class="thread">
      <Thread number={pr.number} thread={t} pending={!!data?.pending} path hunk={!!t.comments[0]?.diffHunk}>
        {#snippet actions()}
          <IconButton
            label="Show in diff"
            tip={typeof w === 'string' ? w : w.length > 1 ? "Show it in the pull request's changes" : 'Show it in the commit it was made on'}
            size="sm"
            disabled={typeof w === 'string'}
            onclick={() => reviews.show(pr.number, t)}><CrosshairRegular /></IconButton
          >
        {/snippet}
      </Thread>
    </div>
  </div>
{/snippet}

<section class="conversation" aria-label="Conversation">
  <div class="head">
    <h3>Conversation</h3>
    <span class="muted count">
      {plural(pr.commitCount, 'commit')}
      {#if pr.commitCount > commits.length}({commits.length === pr.commits.length ? `the last ${commits.length}; loading the rest…` : `GitHub lists ${commits.length}`}){/if}
    </span>
    {#if unresolved.length}
      <Button size="sm" variant="ghost" onclick={nextUnresolved} {@attach tip('Go to the next unresolved thread')}>
        <ChatsCircleRegular /> {plural(unresolved.length, 'unresolved thread')}
      </Button>
    {:else if resolved}
      <span class="muted count">{resolved === 1 ? 'Its thread is resolved' : `All ${resolved} threads resolved`}</span>
    {/if}
    <SuggestionBatch number={pr.number} />
    <span class="spacer"></span>
    <Segmented
      size="sm"
      label="Order"
      options={[
        { id: 'oldest', label: 'Oldest first' },
        { id: 'newest', label: 'Newest first' },
      ]}
      bind:value={conversationOrder.value}
    />
  </div>

  {#if newest}{@render composer()}{/if}

  <ol class="timeline" bind:this={list}>
    {#each entries as e (e.key)}
      {#if e.kind === 'item' && e.item.kind === 'comment'}
        {@const item = e.item}
        <li class="card">
          <header class="card-head">
            {@render who(item.actor, 18)}
            <span class="muted">commented</span>
            {@render time(item.at)}
            {#if item.edited}<span class="muted">· edited</span>{/if}
            <span class="spacer"></span>
            {#if item.canEdit && editing !== item.id}
              <IconButton label="Edit comment" size="sm" disabled={working} onclick={() => edit(item)}><PencilSimpleRegular /></IconButton>
            {/if}
            {#if item.canDelete}
              <ConfirmButton
                variant="ghost"
                size="sm"
                confirmLabel="Delete?"
                disabled={working}
                aria-label="Delete comment"
                {@attach tip('Delete comment')}
                onconfirm={() => act('prviewDeleteComment', { dbId: item.dbId }, 'Deleted the comment')}><TrashRegular /></ConfirmButton
              >
            {/if}
          </header>
          {#if editing === item.id}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="card-body edit" onkeydown={(ev) => onEditKey(ev, item)}>
              <TextArea bind:value={draft} rows={4} aria-label="Comment" {@attach (el: HTMLElement) => el.focus()} />
              <div class="actions">
                <Button variant="primary" onclick={() => save(item)} disabled={!draft.trim() || working}>Save <Kbd hint="⌘↩" /></Button>
                <Button onclick={() => (editing = null)}>Cancel <Kbd hint="Esc" /></Button>
              </div>
            </div>
          {:else}
            <div class="card-body"><Markdown text={item.body} /></div>
          {/if}
        </li>
      {:else if e.kind === 'item' && e.item.kind === 'event'}
        {@const item = e.item}
        {@const Icon = EVENT_ICON[item.type]}
        <li class="event" class:merged={item.type === 'merged'} class:closed={item.type === 'closed'}>
          <span class="glyph" aria-hidden="true"><Icon /></span>
          <div class="what line">
            {#if item.actor}{@render who(item.actor, 16)}{:else}<b>someone</b>{/if}
            <span class="muted">{eventText(item)}</span>
            {#if item.label}<Tag label={item.label.name} color="#{item.label.color}" />{/if}
            {@render time(item.at)}
            {#if item.pushed}
              {@render compare(item.pushed.from, item.pushed.to, `Force-push ${item.before} → ${item.subject}`, 'What the force-push changed')}
            {/if}
          </div>
        </li>
      {:else if e.kind === 'review'}
        {@const r = e.review ? REVIEW[e.review.state] : { icon: HourglassRegular, color: 'var(--warn)', text: '' }}
        {@const rest = e.review && !e.threads.length && !e.replies.length ? e.review.comments : 0}
        <li class="card review" class:pending={!e.review} style:--tone={r.color}>
          <header class="card-head">
            <span class="glyph" style:color={r.color} aria-hidden="true"><r.icon /></span>
            {#if e.review}
              {@render who(e.review.actor, 18)}
              <span class="muted">{r.text}</span>
              {@render time(e.at)}
              {#if rest}
                <span class="spacer"></span>
                <span class="muted">{plural(rest, 'comment')} on the diff</span>
              {/if}
            {:else}
              <b>Your pending review</b>
              <span class="muted">{plural(data?.pending?.comments ?? e.threads.length, 'comment')}: only you see them until you submit.</span>
              <span class="spacer"></span>
              <ConfirmButton variant="ghost" size="sm" confirmLabel="Discard all?" onconfirm={discard}>Discard review</ConfirmButton>
            {/if}
          </header>
          {#if e.review?.body.trim()}
            <div class="card-body"><Markdown text={e.review.body} /></div>
          {/if}
          {#if e.threads.length || e.replies.length}
            <div class="threads" aria-label="Its comments on the diff">
              {#each e.threads as t (t.id)}{@render thread(t)}{/each}
              {#if e.replies.length}
                <p class="replies muted">
                  Replied in
                  {#each e.replies as t, k (t.id)}
                    <button class="btn btn--link" onclick={() => goTo(t)} use:tooltip={'Go to the thread'}>
                      <span><span class="mono">{t.path}</span>{t.subject === 'FILE' ? '' : ` ${linesLabel(t)}`}</span></button
                    >{k < e.replies.length - 1 ? ', ' : ''}
                  {/each}
                </p>
              {/if}
            </div>
          {/if}
        </li>
      {:else if e.kind === 'thread'}
        {@const first = e.thread.comments[0]}
        <li class="event">
          <span class="glyph" aria-hidden="true"><ChatCircleRegular /></span>
          <div class="what">
            <div class="line">
              {@render who(first.author, 16)}
              <span class="muted">commented on <span class="mono">{e.thread.path}</span></span>
              {@render time(e.at)}
            </div>
            <div class="alone">{@render thread(e.thread)}</div>
          </div>
        </li>
      {:else if e.kind === 'commits'}
        <li class="event">
          <span class="glyph" aria-hidden="true"><GitCommitRegular /></span>
          <div class="what">
            <div class="line">
              {#if e.actor}{@render who(e.actor, 16)}{:else}<b>someone</b>{/if}
              <span class="muted">{pushedText(e.commits.length)}</span>
              {#if e.at}{@render time(e.at)}{:else}<span class="muted" use:tooltip={'Before the conversation GitHub lists here'}>earlier</span>{/if}
              {@render compare(`${e.commits[0].sha}^`, e.commits[e.commits.length - 1].sha, `${e.actor?.login ?? 'Someone'} ${pushedText(e.commits.length)}`, "These commits' changes together")}
            </div>
            <ol class="pushed">
              {#each e.commits as c (c.sha)}
                {@const k = c.checks ? CHECK[c.checks] : null}
                {@const here = app.bySha.has(c.sha)}
                <li>
                  {#if k}
                    <button
                      class="check"
                      style:color={k.color}
                      use:tooltip={`${k.label}: show them`}
                      aria-label={k.label}
                      aria-expanded={checks.open?.sha === c.sha}
                      onclick={(ev) => checks.show(c.sha, ev.currentTarget, c.sha === pr.headSha ? pr.number : undefined)}
                    >
                      <k.icon />
                    </button>
                  {:else}
                    <span class="check" style:color="var(--faint)" use:tooltip={'No checks'} role="img" aria-label="No checks"><CircleRegular /></span>
                  {/if}
                  <button class="headline" use:tooltip={ours && here ? 'Show this commit' : "Show this commit's changes"} onclick={() => open(c.sha)}>{c.headline}</button>
                  <span class="mono sha" class:here>{c.short}</span>
                </li>
              {/each}
            </ol>
          </div>
        </li>
      {/if}
    {/each}
  </ol>

  {#if !newest}{@render composer()}{/if}
</section>

<style>
  .conversation {
    display: flex;
    flex-direction: column;
    gap: var(--sp-5);
  }

  .head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--gap-3) var(--gap-4);
    padding-bottom: var(--sp-2);
    border-bottom: 1px solid var(--border);
  }

  h3 {
    margin: 0;
    font-size: var(--fs-base);
    font-weight: 600;
  }

  .count {
    font-size: var(--fs-sm);
  }

  .timeline {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }

  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    overflow: hidden;
  }

  .card-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--gap-3);
    padding: var(--sp-2) var(--sp-4);
    background: var(--bg2);
    border-bottom: 1px solid var(--border);
    font-size: var(--fs-sm);
    min-height: calc(var(--btn) + var(--sp-2));
  }

  .card-head:last-child {
    border-bottom: none;
  }

  .review .card-head {
    background: color-mix(in oklab, var(--tone) 8%, var(--bg2));
  }

  b {
    font-weight: 600;
    color: var(--color2);
  }

  .spacer {
    flex: 1;
  }

  .card-body {
    padding: var(--sp-4);
    overflow-wrap: anywhere;
  }

  .card-body :global(.md > :first-child) {
    margin-top: 0;
  }

  .card-body :global(.md > :last-child) {
    margin-bottom: 0;
  }

  .card-body + .threads {
    border-top: 1px solid var(--border);
  }

  .threads {
    display: flex;
    flex-direction: column;
    gap: var(--gap-4);
    padding: var(--sp-3) var(--sp-4) var(--sp-4);
    background: var(--bg);
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: var(--gap-2);
    border-radius: var(--radius);
  }

  .row.flash .thread {
    outline: 2px solid var(--theme2);
    outline-offset: 1px;
    border-radius: var(--radius);
  }

  .thread {
    flex: 1;
    min-width: 0;
  }

  .alone {
    margin-top: var(--gap-3);
  }

  .replies {
    margin: 0;
    font-size: var(--fs-sm);
  }

  .replies .btn--link {
    font-size: var(--fs-sm);
  }

  .edit {
    display: flex;
    flex-direction: column;
    gap: var(--gap-4);
  }

  .actions {
    display: flex;
    gap: var(--gap-3);
  }

  .event {
    display: flex;
    align-items: flex-start;
    gap: var(--gap-4);
    padding: 0 var(--sp-4);
    font-size: var(--fs-sm);
  }

  .glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: var(--btn);
    height: var(--btn);
    border-radius: var(--radius-pill);
    background: var(--bg3);
    color: var(--muted);
    font-size: var(--icon-md);
  }

  .card-head .glyph {
    width: auto;
    height: auto;
    background: none;
    font-size: var(--icon-lg);
  }

  .merged .glyph {
    background: var(--theme);
    color: var(--on-accent);
  }

  .closed .glyph {
    background: var(--danger);
    color: var(--on-danger);
  }

  .what {
    min-width: 0;
    flex: 1;
  }

  .line {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--gap-3);
    min-height: var(--btn);
  }

  .pushed {
    list-style: none;
    margin: var(--gap-2) 0 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    overflow: hidden;
  }

  .pushed li {
    display: flex;
    align-items: center;
    gap: var(--gap-4);
    min-width: 0;
    padding: var(--gap-2) var(--sp-4);
    min-height: var(--row-h);
  }

  .pushed li + li {
    border-top: 1px solid var(--border);
  }

  .check {
    display: inline-flex;
    font-size: var(--icon-md);
  }

  button.check {
    border-radius: var(--radius-pill);
    cursor: pointer;
  }

  .headline {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
    color: var(--color2);
    cursor: pointer;
  }

  .sha {
    color: var(--faint);
    font-size: var(--fs-xs);
    flex: none;
  }

  .sha.here {
    color: var(--theme2);
  }

  .compare {
    font-size: var(--fs-sm);
  }

  @media (hover: hover) {
    .headline:hover {
      color: var(--theme2);
      text-decoration: underline;
    }
  }
</style>
