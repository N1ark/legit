<script lang="ts">
  // The repository's pull requests (⇧P), in GitHub's lists: review requested, yours, assigned to
  // you, all open. Type to filter; ↩ opens one's overview, ⌘↩ checks it out, ⌥↩ reviews it in a
  // worktree. `#123`, `123` or its URL opens any one, closed or merged too.
  import { Avatar, CommandPalette, Highlight, IconButton, Kbd, Segmented, formatFull, formatRelative, matches, rank, tooltip, type PaletteItem, type RowState } from 'purr';
  import { ArrowSquareOutRegular, ChatCircleRegular, FolderSimplePlusRegular, GitBranchRegular, MagnifyingGlassRegular } from 'purr/glyphs';
  import { untrack } from 'svelte';
  import type { InboxPr } from '../../shared/gh-inbox.ts';
  import { app } from '../lib/app.svelte.ts';
  import { checkoutPr, checkouts } from '../lib/gh-checkout.svelte.ts';
  import { LISTS, inboxList, parsePrRef } from '../lib/gh-inbox.ts';
  import { inbox } from '../lib/gh-inbox.svelte.ts';
  import { checksLabel } from '../lib/gh-prview.ts';
  import { ghAvatar } from '../lib/gh-prview.ts';
  import { gh } from '../lib/github.svelte.ts';
  import CheckIcon from './CheckIcon.svelte';
  import PrStatus from './PrStatus.svelte';

  interface Props {
    onclose: () => void;
  }
  let { onclose }: Props = $props();

  interface Row extends PaletteItem {
    pr: InboxPr | null;
    /** A pull request asked for by number: looking it up (undefined), or none (null). */
    asked?: number;
  }

  let query = $state('');
  const repo = $derived(gh.status?.repo ?? '');
  const items = $derived(inbox.data?.items ?? []);

  const row = (pr: InboxPr): Row => ({
    id: `pr:${pr.number}`,
    label: pr.title,
    detail: `#${pr.number} ${pr.author?.login ?? ''}`,
    keywords: [pr.head, pr.base, pr.fork ?? ''],
    pr,
    run: () => gh.showPr(pr.number),
  });

  const rows = $derived(inboxList(items, inbox.list.value).map(row));
  const ref = $derived(parsePrRef(query, repo));

  // One asked for by number that isn't listed is looked up.
  $effect(() => {
    const r = ref;
    if (r && r.repo === repo) untrack(() => inbox.lookup(r.number));
  });

  function search(q: string) {
    const hit = (item: Row) => ({ item, score: 0, field: 0, indices: [] });
    if (ref && ref.repo !== repo) {
      const url = `https://github.com/${ref.repo}/pull/${ref.number}`;
      return [hit({ id: 'other', label: `${ref.repo}#${ref.number}`, detail: 'On GitHub', icon: ArrowSquareOutRegular, pr: null, run: () => app.openUrl(url) })];
    }
    if (ref) {
      const known = items.find((p) => p.number === ref.number) ?? inbox.found[ref.number];
      return [hit(known ? row(known) : { id: `ask:${ref.number}`, label: `#${ref.number}`, pr: null, asked: ref.number, run: () => gh.showPr(ref.number) })];
    }
    return rank(rows, q, { keys: [(i) => i.label, (i) => i.detail ?? '', (i) => i.keywords?.join(' ') ?? ''], limit: 200 });
  }

  function choose(item: Row, e: KeyboardEvent | MouseEvent) {
    const n = item.pr?.number;
    const key = 'key' in e ? e : null;
    if (n && key && matches('⌘↩', key)) checkoutPr(n);
    else if (n && key && matches('⌥↩', key)) checkoutPr(n, true);
    else item.run?.(e);
  }

  /** A row's button: the palette closes first, as choosing a row does. */
  function action(e: MouseEvent, run: () => unknown) {
    e.stopPropagation();
    onclose();
    run();
  }

  // ⇥ and ⇧⇥ in the field walk the lists.
  function tabs(node: HTMLElement) {
    const field = node.parentElement?.querySelector('input');
    const onkey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.altKey || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      const i = LISTS.findIndex((l) => l.id === inbox.list.value);
      inbox.list.value = LISTS[(i + (e.shiftKey ? LISTS.length - 1 : 1)) % LISTS.length].id;
    };
    field?.addEventListener('keydown', onkey);
    return () => field?.removeEventListener('keydown', onkey);
  }

  const count = (id: (typeof LISTS)[number]['id']) => {
    const n = inbox.data ? inboxList(items, id).length : 0;
    const more = inbox.data && inbox.data.counts[id] > n ? '+' : '';
    return n ? ` ${n}${more}` : '';
  };

  const DECISION = { approved: 'Approved', changes: 'Changes requested', required: 'Review required' } as const;

  const EMPTY: Record<string, string> = {
    review: 'Nothing is waiting for your review.',
    mine: "You haven't any open pull requests here.",
    assigned: 'None are assigned to you.',
    open: 'No open pull requests.',
  };

  function emptyText(q: string) {
    if (inbox.error && !inbox.data) return `Couldn't load the pull requests: ${inbox.error}`;
    if (!inbox.data) return 'Loading pull requests…';
    return q.trim() ? `Nothing matches “${q.trim()}”. Type #123 to open any pull request.` : EMPTY[inbox.list.value];
  }
</script>

<CommandPalette
  items={rows}
  {onclose}
  bind:query
  {search}
  onchoose={choose}
  label="Pull requests"
  placeholder="Filter, or #123 to open any…"
  emptyText={emptyText}
  rowHeight={50}
  width="min(760px, calc(100vw - 32px))"
>
  {#snippet trailing()}
    <span class="lists" {@attach tabs}>
      <Segmented
        size="sm"
        label="Which pull requests"
        options={LISTS.map((l) => ({ id: l.id, label: `${l.label}${count(l.id)}` }))}
        bind:value={inbox.list.value}
      />
    </span>
  {/snippet}
  {#snippet row(item: Row, state: RowState)}
    {#if item.pr}
      {@const p = item.pr}
      <span class="state"><PrStatus state={p.state} size="16px" tip={false} /></span>
      <span class="text">
        <span class="title truncate"><Highlight text={item.label} indices={state.field === 0 ? state.indices : []} /></span>
        <span class="meta">
          <span class="mono">#{p.number}</span>
          {#if p.author}
            <span class="who"><Avatar name={p.author.login} src={ghAvatar(p.author.avatar)} size={14} round title="" />{p.author.login}</span>
          {/if}
          <span class="refs mono truncate">{p.fork ? `${p.fork.split('/')[0]}:` : ''}{p.head} → {p.base}</span>
          {#if p.requested && p.requested !== 'you'}<span class="truncate">for {p.requested}</span>{/if}
          <span use:tooltip={formatFull(p.updatedAt)}>{formatRelative(p.updatedAt)}</span>
        </span>
      </span>
      <span class="side">
        {#if p.comments}
          <span class="comments" aria-label={`${p.comments} comments`}><ChatCircleRegular />{p.comments}</span>
        {/if}
        {#if p.reviewDecision && p.state !== 'merged' && p.state !== 'closed'}
          <span class="decision {p.reviewDecision}">{DECISION[p.reviewDecision]}</span>
        {/if}
        {#if p.checks}
          <span class="checks" use:tooltip={checksLabel(p.checks)} role="img" aria-label={checksLabel(p.checks)}>
            <CheckIcon state={p.checks === 'error' ? 'failure' : p.checks === 'expected' ? 'pending' : p.checks} />
          </span>
        {/if}
        <span class="actions" class:shown={state.active}>
          <IconButton label="Check out" shortcut="⌘↩" size="sm" disabled={checkouts.fetching !== null} onclick={(e) => action(e, () => checkoutPr(p.number))}>
            <GitBranchRegular />
          </IconButton>
          <IconButton label="Review in a worktree" shortcut="⌥↩" size="sm" disabled={checkouts.fetching !== null} onclick={(e) => action(e, () => checkoutPr(p.number, true))}>
            <FolderSimplePlusRegular />
          </IconButton>
        </span>
      </span>
    {:else}
      <span class="state muted">{#if item.icon}<item.icon />{:else}<MagnifyingGlassRegular />{/if}</span>
      <span class="text">
        <span class="title truncate">
          {#if item.asked !== undefined && inbox.found[item.asked] === null}
            Open #{item.asked}
          {:else}
            {item.label}
          {/if}
        </span>
        <span class="meta">
          {#if item.asked === undefined}
            {item.detail}
          {:else if inbox.found[item.asked] === null}
            GitHub has no pull request #{item.asked} in {repo}
          {:else}
            Looking it up…
          {/if}
        </span>
      </span>
    {/if}
  {/snippet}
  {#snippet footer()}
    <span><Kbd hint="↩" /> open</span>
    <span><Kbd hint="⌘↩" /> check out</span>
    <span><Kbd hint="⌥↩" /> review in a worktree</span>
    <span><Kbd hint="⇥" /> next list</span>
  {/snippet}
</CommandPalette>

<style>
  .lists {
    display: flex;
    flex-shrink: 0;
  }

  .state {
    display: inline-flex;
    flex-shrink: 0;
    font-size: var(--icon-md);
  }

  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--gap-1);
  }

  .title {
    font-weight: 500;
    color: var(--color2);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: var(--gap-4);
    min-width: 0;
    font-size: var(--fs-xs);
    color: var(--muted);
    white-space: nowrap;
  }

  .who {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-2);
  }

  .refs {
    min-width: 0;
  }

  .side {
    display: flex;
    align-items: center;
    gap: var(--gap-4);
    flex-shrink: 0;
    font-size: var(--fs-xs);
  }

  .comments {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-1);
    color: var(--muted);
  }

  .decision {
    padding: var(--gap-1) var(--sp-3);
    border-radius: var(--radius-pill);
    background: var(--bg3);
    color: var(--muted);
    white-space: nowrap;
  }

  .decision.approved {
    background: color-mix(in oklab, var(--success) 14%, transparent);
    color: var(--success);
  }

  .decision.changes {
    background: color-mix(in oklab, var(--danger) 14%, transparent);
    color: var(--danger);
  }

  .checks {
    display: inline-flex;
    font-size: var(--icon-md);
  }

  /* Shown on the cursor's row (and on hover), so the others have the room. */
  .actions {
    display: flex;
    gap: var(--gap-1);
    opacity: 0;
  }

  .actions.shown {
    opacity: 1;
  }

  @media (hover: none) {
    .actions {
      opacity: 1;
    }
  }
</style>
