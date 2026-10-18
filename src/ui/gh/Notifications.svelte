<script lang="ts">
  // The bell in the header: GitHub notifications, this repo's or everyone's. A pull request of this
  // repo opens in legit's own view; anything else opens on GitHub. Opening one marks it read.
  import { Badge, Button, EmptyState, IconButton, Popover, Segmented, formatFull, formatRelative, persisted } from 'purr';
  import {
    ArrowSquareOut, Bell, BellSlash, ChatsCircle, Check, CheckCircle, EnvelopeOpen, GitCommit, GitPullRequest, IssueOpened as IssueIcon, PlayCircle, Tag,
  } from 'purr/icons';
  import { onMount, untrack } from 'svelte';
  import type { Component } from 'svelte';
  import type { GhNotification, GhNotificationType } from '../../shared/gh-notifications.ts';
  import { app } from '../lib/app.svelte.ts';
  import { gh } from '../lib/github.svelte.ts';
  import { notifications } from '../lib/gh-notifications.svelte.ts';

  let open = $state(false);
  let button = $state<HTMLButtonElement | null>(null);
  const scope = persisted<'repo' | 'all'>('legit:notifications', 'repo', (v): v is 'repo' | 'all' => v === 'repo' || v === 'all');

  onMount(() => notifications.start());
  // First load once signed in (and again on another repo's page).
  $effect(() => {
    if (gh.ready) untrack(() => notifications.load());
  });

  const repo = $derived(gh.status?.repo ?? null);
  const inRepo = (n: GhNotification) => !!repo && n.repo.toLowerCase() === repo.toLowerCase();
  const items = $derived((notifications.items ?? []).filter((n) => scope.value === 'all' || inRepo(n)));
  const repoUnread = $derived((notifications.items ?? []).filter((n) => n.unread && inRepo(n)).length);
  const shownUnread = $derived(items.filter((n) => n.unread).length);
  const label = $derived(
    notifications.unread ? `Notifications, ${notifications.unread} unread${repoUnread ? ` (${repoUnread} in this repo)` : ''}` : 'Notifications',
  );

  const ICONS: Record<GhNotificationType, Component> = {
    PullRequest: GitPullRequest,
    Issue: IssueIcon,
    CheckSuite: PlayCircle,
    Release: Tag,
    Discussion: ChatsCircle,
    Commit: GitCommit,
    Other: Bell,
  };
  const kind: Record<GhNotificationType, string> = {
    PullRequest: 'Pull request',
    Issue: 'Issue',
    CheckSuite: 'CI',
    Release: 'Release',
    Discussion: 'Discussion',
    Commit: 'Commit',
    Other: 'Notification',
  };

  function toggle(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    button = e.currentTarget;
    open = !open;
    if (open) notifications.load();
  }

  function show(n: GhNotification) {
    notifications.open(n);
    if (notifications.here(n)) open = false;
  }
</script>

{#if repo && gh.status?.login}
  <span class="bell">
    <IconButton label={label} tip={label} size="lg" aria-expanded={open} onclick={toggle}>
      <Bell weight={notifications.unread ? 'fill' : 'regular'} />
    </IconButton>
    {#if notifications.unread}
      <span class="count" aria-hidden="true"><Badge count={notifications.unread} tone={repoUnread ? 'accent' : 'soft'} max={99} /></span>
    {/if}
  </span>
{/if}
{#if open && button}
  <Popover
    anchor={button}
    placement="bottom-end"
    label="Notifications"
    onclose={() => (open = false)}
    width="min(520px, calc(100vw - 32px))"
    maxHeight="70vh"
    padding="var(--sp-4)"
  >
    <div class="head">
      <b>Notifications</b>
      <Segmented
        size="sm"
        label="Which notifications"
        options={[
          { id: 'repo', label: repoUnread ? `This repo (${repoUnread})` : 'This repo' },
          { id: 'all', label: notifications.unread ? `All (${notifications.unread})` : 'All' },
        ]}
        bind:value={scope.value}
      />
      <span class="spacer"></span>
      <Button size="sm" disabled={!shownUnread} onclick={() => notifications.readAll(scope.value === 'repo' ? repo : null)}>Mark all read</Button>
      <IconButton label="Open your inbox on GitHub" size="sm" onclick={() => app.openUrl('https://github.com/notifications')}>
        <ArrowSquareOut />
      </IconButton>
    </div>
    {#if notifications.error}
      <p class="error">
        {notifications.error}
        <button class="btn btn--link" onclick={() => notifications.load(true)}>Try again</button>
      </p>
    {:else if notifications.items === null}
      <p class="muted">Loading…</p>
    {:else if !items.length}
      <EmptyState icon={CheckCircle} text="All caught up" hint={scope.value === 'repo' ? `Nothing from ${repo}.` : 'No notifications.'} />
    {:else}
      <ol>
        {#each items as n (n.id)}
          {@const Icon = ICONS[n.type]}
          <li class:unread={n.unread}>
            <span class="icon" title={kind[n.type]}><Icon /></span>
            <button
              class="main"
              title={notifications.here(n) ? 'Open in legit' : 'Open on GitHub'}
              onclick={() => show(n)}
            >
              <span class="title">{n.title}</span>
              <span class="meta muted">
                {#if n.unread}<span class="dot" aria-hidden="true"></span><span class="sr-only">Unread.</span>{/if}
                {#if scope.value === 'all' || !inRepo(n)}<span class="repo">{n.repo}</span>{/if}
                {#if n.number}<span>#{n.number}</span>{/if}
                <span>{n.reason}</span>
                <span title={formatFull(n.updatedAt)}>{formatRelative(n.updatedAt)}</span>
              </span>
            </button>
            <span class="actions">
              {#if notifications.here(n)}
                <IconButton label="Open on GitHub" size="sm" onclick={() => app.openUrl(n.url)}><ArrowSquareOut /></IconButton>
              {/if}
              {#if n.unread}
                <IconButton label="Mark as read" size="sm" onclick={() => notifications.markRead(n)}><EnvelopeOpen /></IconButton>
              {/if}
              <IconButton label="Done" size="sm" onclick={() => notifications.done(n)}><Check /></IconButton>
              <IconButton label="Unsubscribe" size="sm" onclick={() => notifications.unsubscribe(n)}><BellSlash /></IconButton>
            </span>
          </li>
        {/each}
      </ol>
    {/if}
  </Popover>
{/if}

<style>
  .bell {
    position: relative;
    display: inline-flex;
  }

  /* On the bell's shoulder, measured from the button's middle (where the bell is) rather than its
     edge, and growing rightwards with more digits. Flex, so the header's line height doesn't push
     the circle off its spot, and the digits centred on their cap height rather than the line's. */
  .count {
    position: absolute;
    left: calc(50% + 2px);
    bottom: calc(50% + 1px);
    display: flex;
    pointer-events: none;
  }

  .count :global(.badge) {
    display: flex;
    align-items: center;
    justify-content: center;
    text-box: trim-both cap alphabetic;
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    padding: var(--gap-1) var(--gap-3) var(--gap-4);
  }

  .spacer {
    flex: 1;
  }

  p {
    margin: var(--gap-3);
  }

  .error {
    color: var(--danger);
  }

  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: var(--gap-3);
    padding: var(--gap-3);
    border-radius: var(--radius);
    color: var(--muted);
  }

  li.unread {
    color: var(--color);
  }

  @media (hover: hover) {
    li:hover {
      background: var(--bg3);
    }
  }

  .icon {
    display: inline-flex;
    padding-top: 2px;
    color: var(--muted);
  }

  .unread .icon {
    color: var(--theme2);
  }

  .main {
    all: unset;
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--gap-1);
    cursor: pointer;
  }

  .main:focus-visible .title,
  .main:hover .title {
    text-decoration: underline;
  }

  .title {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .unread .title {
    font-weight: 600;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0 var(--gap-3);
    font-size: var(--fs-xs);
  }

  .repo {
    font-family: var(--mono);
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: var(--radius-pill);
    background: var(--theme);
  }

  /* Revealed by hover or focus, so the row's text has the room otherwise. */
  .actions {
    display: flex;
    gap: var(--gap-1);
    opacity: 0;
  }

  li:hover .actions,
  li:focus-within .actions {
    opacity: 1;
  }

  @media (hover: none) {
    .actions {
      opacity: 1;
    }
  }
</style>
