<script lang="ts">
  // A pull request's timeline: comments (the viewer's own editable), reviews with their state
  // and words, pushes, and everything else as one-line events.
  import { Avatar, Button, ConfirmButton, IconButton, Kbd, Tag, TextArea, formatFull, formatRelative, matches, tooltip } from 'purr';
  import {
    ArrowsClockwise, ChatCircle, CheckCircle, Eye, GitBranch, GitCommit, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, PencilSimple,
    Tag as TagIcon, TextT, Trash, UserPlus, XCircle,
  } from 'purr/icons';
  import type { PrComment, PrEventType, PrOverview, ReviewState } from '../../shared/gh-prview.ts';
  import Markdown from '../Markdown.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { eventText, ghAvatar, pushedText } from '../lib/gh-prview.ts';
  import { tip } from '../lib/tip.ts';

  interface Props {
    pr: PrOverview;
    act: (name: string, body?: Record<string, unknown>, done?: string) => Promise<boolean>;
    working: boolean;
  }
  let { pr, act, working }: Props = $props();

  const EVENT_ICON: Record<PrEventType, typeof GitCommit> = {
    merged: GitMerge,
    closed: GitPullRequestClosed,
    reopened: GitPullRequest,
    ready: Eye,
    draft: GitPullRequestDraft,
    'force-pushed': ArrowsClockwise,
    'review-requested': UserPlus,
    'review-request-removed': UserPlus,
    labeled: TagIcon,
    unlabeled: TagIcon,
    'base-changed': GitBranch,
    renamed: TextT,
    'head-deleted': GitBranch,
  };

  const REVIEW: Record<ReviewState, { icon: typeof GitCommit; color: string; text: string }> = {
    approved: { icon: CheckCircle, color: 'var(--success)', text: 'approved these changes' },
    changes: { icon: XCircle, color: 'var(--danger)', text: 'requested changes' },
    commented: { icon: ChatCircle, color: 'var(--muted)', text: 'reviewed' },
    dismissed: { icon: ChatCircle, color: 'var(--faint)', text: 'reviewed (dismissed)' },
    pending: { icon: ChatCircle, color: 'var(--faint)', text: 'started a review' },
  };

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

  const when = (at: string) => formatRelative(at);
</script>

{#snippet time(at: string)}
  <time class="muted" datetime={at} use:tooltip={formatFull(at)}>{when(at)}</time>
{/snippet}

{#snippet sha(s: string, short: string)}
  {#if app.bySha.has(s)}
    <button class="mono sha here" use:tooltip={'Show this commit'} onclick={() => app.select(s)}>{short}</button>
  {:else}
    <span class="mono sha">{short}</span>
  {/if}
{/snippet}

<ol class="timeline" aria-label="Conversation">
  {#each pr.timeline as item (item.id)}
    {#if item.kind === 'comment'}
      <li class="card">
        <header class="card-head">
          <Avatar name={item.actor?.login ?? 'ghost'} src={ghAvatar(item.actor?.avatar)} size={18} round />
          <b>{item.actor?.login ?? 'ghost'}</b>
          <span class="muted">commented</span>
          {@render time(item.at)}
          {#if item.edited}<span class="muted">· edited</span>{/if}
          <span class="spacer"></span>
          {#if item.canEdit && editing !== item.id}
            <IconButton label="Edit comment" size="sm" disabled={working} onclick={() => edit(item)}><PencilSimple /></IconButton>
          {/if}
          {#if item.canDelete}
            <ConfirmButton
              variant="ghost"
              size="sm"
              confirmLabel="Delete?"
              disabled={working}
              aria-label="Delete comment"
              {@attach tip('Delete comment')}
              onconfirm={() => act('prviewDeleteComment', { dbId: item.dbId }, 'Deleted the comment')}><Trash /></ConfirmButton
            >
          {/if}
        </header>
        {#if editing === item.id}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="card-body edit" onkeydown={(e) => onEditKey(e, item)}>
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
    {:else if item.kind === 'review'}
      {@const r = REVIEW[item.state]}
      <li class="card review" style:--tone={r.color}>
        <header class="card-head">
          <span class="glyph" style:color={r.color} aria-hidden="true"><r.icon weight="fill" /></span>
          <Avatar name={item.actor?.login ?? 'ghost'} src={ghAvatar(item.actor?.avatar)} size={18} round />
          <b>{item.actor?.login ?? 'ghost'}</b>
          <span class="muted">{r.text}</span>
          {@render time(item.at)}
          {#if item.comments}
            <span class="spacer"></span>
            <span class="muted">{item.comments} comment{item.comments === 1 ? '' : 's'} on the diff</span>
          {/if}
        </header>
        {#if item.body.trim()}
          <div class="card-body"><Markdown text={item.body} /></div>
        {/if}
      </li>
    {:else if item.kind === 'commits'}
      <li class="event">
        <span class="glyph" aria-hidden="true"><GitCommit /></span>
        <div class="what">
          <div class="line">
            {#if item.actor}<Avatar name={item.actor.login} src={ghAvatar(item.actor.avatar)} size={16} round />{/if}
            <b>{item.actor?.login ?? 'someone'}</b>
            <span class="muted">{pushedText(item.commits.length)}</span>
            {@render time(item.at)}
          </div>
          <ul class="pushed">
            {#each item.commits as c (c.sha)}
              <li>{@render sha(c.sha, c.short)} <span class="headline">{c.headline}</span></li>
            {/each}
          </ul>
        </div>
      </li>
    {:else}
      {@const Icon = EVENT_ICON[item.type]}
      <li class="event" class:merged={item.type === 'merged'} class:closed={item.type === 'closed'}>
        <span class="glyph" aria-hidden="true"><Icon weight={item.type === 'merged' || item.type === 'closed' ? 'bold' : 'regular'} /></span>
        <div class="what line">
          {#if item.actor}<Avatar name={item.actor.login} src={ghAvatar(item.actor.avatar)} size={16} round />{/if}
          <b>{item.actor?.login ?? 'someone'}</b>
          <span class="muted">{eventText(item)}</span>
          {#if item.label}<Tag label={item.label.name} color="#{item.label.color}" />{/if}
          {@render time(item.at)}
        </div>
      </li>
    {/if}
  {/each}
</ol>

<style>
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
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
  }

  .pushed li {
    display: flex;
    gap: var(--gap-4);
    min-width: 0;
  }

  .headline {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sha {
    color: var(--faint);
    font-size: var(--fs-xs);
    flex: none;
  }

  .sha.here {
    color: var(--theme2);
  }

  @media (hover: hover) {
    button.sha:hover {
      text-decoration: underline;
    }
  }
</style>
