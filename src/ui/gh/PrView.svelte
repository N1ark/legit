<script lang="ts">
  // A pull request in place of a commit, as GitHub's Conversation tab: its description, commits,
  // timeline and merge box, with who reviews it and its labels beside them. One query loads it
  // all (again on each refresh and on focus); every change answers with the overview as it now is.
  // Opened again within a minute, it shows the overview it had at once, while it loads again.
  import { Avatar, Button, IconButton, Kbd, Spinner, TextArea, formatFull, formatRelative, hasOverlay, isTyping, matches, menu, toast, tooltip } from 'purr';
  import { ArrowSquareOut, CheckCircle, Circle, GitPullRequestClosed, X, XCircle } from 'purr/icons';
  import { onMount, untrack } from 'svelte';
  import type { CheckState, PrOptions, PrOverview } from '../../shared/gh-prview.ts';
  import { isLive } from '../../shared/github.ts';
  import Markdown from '../Markdown.svelte';
  import { app } from '../lib/app.svelte.ts';
  import { checks } from '../lib/gh-checks.svelte.ts';
  import { ghAvatar } from '../lib/gh-prview.ts';
  import { gh, ghPost, ghRequest, keepPrview, keptPrview, loadPrview } from '../lib/github.svelte.ts';
  import PrMergeBox from './PrMergeBox.svelte';
  import PrStatus from './PrStatus.svelte';
  import PrReview from './PrReview.svelte';
  import PrSide from './PrSide.svelte';
  import PrTimeline from './PrTimeline.svelte';
  import ReviewThreads from './ReviewThreads.svelte';

  interface Props {
    number: number;
  }
  let { number }: Props = $props();

  // One kept from the last minute (an open one is no fresher) shows at once, and loads again unless it's from just now.
  const kept = untrack(() => keptPrview(number));
  let pr = $state.raw<PrOverview | null>(kept?.pr ?? null);
  let error = $state<string | null>(null);
  let working = $state(false);
  let loadedAt = kept?.at ?? 0;
  let gen = 0;
  let unknownTries = 0;

  async function load() {
    if (!gh.ready) return;
    const g = ++gen;
    loadedAt = Date.now();
    try {
      const got = await loadPrview(number);
      if (g !== gen) return;
      pr = got;
      keepPrview(got);
      error = null;
    } catch (e) {
      if (g !== gen) return;
      error = e instanceof Error ? e.message : String(e);
      // Opening it is asked for; a refresh of what's shown fails quietly.
      if (!pr) toast.error(e);
    }
  }

  // Again after each refresh (gh.tick), unless this view just loaded it itself.
  $effect(() => {
    void [gh.tick, gh.ready];
    untrack(() => Date.now() - loadedAt > 3000 && load());
  });

  // GitHub works out mergeability lazily: ask again shortly while it says it doesn't know yet.
  $effect(() => {
    if (!pr || pr.state !== 'open' || pr.mergeable !== 'unknown' || unknownTries >= 4) return;
    const t = setTimeout(() => (unknownTries++, load()), 2500);
    return () => clearTimeout(t);
  });

  onMount(() => {
    const focus = () => Date.now() - loadedAt > 30_000 && load();
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  });

  /** POST a change; the answer is the overview as it now is. */
  async function act(name: string, body: Record<string, unknown> = {}, done?: string): Promise<boolean> {
    if (working) return false;
    working = true;
    try {
      pr = await ghPost<PrOverview>(name, { number, ...body });
      keepPrview(pr);
      loadedAt = Date.now();
      if (done) toast(done);
      return true;
    } catch (e) {
      toast.error(e);
      // What failed may be because the pull request changed meanwhile.
      load();
      return false;
    } finally {
      working = false;
    }
  }

  // The pickers' choices (who can review, labels, branches), loaded the first time one opens.
  let optionsLoad: Promise<PrOptions | null> | null = null;
  function options(): Promise<PrOptions | null> {
    optionsLoad ??= ghRequest<PrOptions>('prviewOptions', { number }).catch((e) => {
      optionsLoad = null;
      toast.error(e);
      return null;
    });
    return optionsLoad;
  }

  // Title and description edit in place, as a commit's do.
  let editing = $state<'title' | 'body' | null>(null);
  let draft = $state('');

  function edit(field: 'title' | 'body') {
    if (!pr?.canUpdate || working) return;
    draft = field === 'title' ? pr.title : pr.body;
    editing = field;
  }

  async function saveEdit() {
    if (!pr || !editing) return;
    const field = editing;
    if (draft === (field === 'title' ? pr.title : pr.body)) return void (editing = null);
    if (await act('prviewEdit', { [field]: draft })) {
      editing = null;
      if (field === 'title') gh.refresh({ fresh: true });
    }
  }

  function onEditKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      editing = null;
    } else if (!e.isComposing && ((editing === 'title' && e.key === 'Enter') || matches('⌘↩', e))) {
      e.preventDefault();
      saveEdit();
    }
  }

  /** A click on a link follows it rather than starting to edit. */
  function keepLinks(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('a')) e.preventDefault();
  }

  function focusEnd(el: HTMLInputElement | HTMLTextAreaElement) {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }

  async function pickBase(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    if (!pr) return;
    const anchor = e.currentTarget;
    const o = await options();
    if (!o || !pr) return;
    const current = pr.base;
    menu.showFor(
      anchor,
      o.branches.filter((b) => b !== pr?.head).map((b) => ({
        label: b,
        checked: b === current,
        run: () => void (b !== current && setBase(b)),
      })),
      'Merge into',
    );
  }

  async function setBase(base: string) {
    if (await act('prviewEdit', { base }, `#${number} now merges into ${base}`)) gh.refresh({ fresh: true });
  }

  // The comment box at the bottom.
  let comment = $state('');

  async function send() {
    if (!comment.trim() || working) return;
    if (await act('prviewComment', { body: comment })) comment = '';
  }

  async function setOpen(open: boolean) {
    if (!pr) return;
    if (!open && comment.trim() && !(await act('prviewComment', { body: comment }))) return;
    if (!open) comment = '';
    if (await act('prviewState', { open }, open ? `Reopened #${number}` : `Closed #${number}`)) gh.refresh({ fresh: true });
  }

  function onCommentKey(e: KeyboardEvent) {
    if (matches('⌘↩', e) && !e.isComposing) {
      e.preventDefault();
      send();
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.defaultPrevented || isTyping(document.activeElement) || hasOverlay()) return;
    e.preventDefault();
    gh.close();
  }

  const CHECK: Record<NonNullable<CheckState>, { icon: typeof Circle; color: string; label: string }> = {
    success: { icon: CheckCircle, color: 'var(--success)', label: 'Checks passed' },
    failure: { icon: XCircle, color: 'var(--danger)', label: 'Checks failed' },
    error: { icon: XCircle, color: 'var(--danger)', label: 'Checks errored' },
    pending: { icon: Circle, color: 'var(--warn)', label: 'Checks running' },
    expected: { icon: Circle, color: 'var(--warn)', label: 'Checks expected' },
  };

  const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
</script>

<svelte:window {onkeydown} />

<div class="view">
  <div class="top">
    <div class="what">
      {#if pr}
        <PrStatus state={pr.state} look="pill" />
        <span class="mono num">#{pr.number}</span>
      {:else}
        <span class="mono num">#{number}</span>
      {/if}
    </div>
    {#if pr && isLive(pr.state)}
      <PrReview {pr} {act} {working} />
    {/if}
    {#if pr}
      <IconButton label="Open on GitHub" onclick={() => pr && app.openUrl(pr.url)}><ArrowSquareOut /></IconButton>
    {/if}
    <IconButton label="Close" shortcut="Esc" onclick={() => gh.close()}><X /></IconButton>
  </div>

  {#if !gh.ready}
    <p class="muted empty">{gh.status?.error ?? 'This repository is not on GitHub.'}</p>
  {:else if !pr && error}
    <div class="empty">
      <p class="muted">Couldn't load #{number}: {error}</p>
      <Button onclick={load}>Try again</Button>
    </div>
  {:else if !pr}
    <p class="muted empty"><Spinner label="Loading the pull request" /> Loading #{number}…</p>
  {:else}
    <div class="title">
      {#if editing === 'title'}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="edit-row" onkeydown={onEditKey}>
          <input class="field-input subject" bind:value={draft} aria-label="Title" spellcheck="true" {@attach focusEnd} />
          <Button variant="primary" onclick={saveEdit} disabled={!draft.trim() || working}>Save <Kbd hint="↩" /></Button>
          <Button onclick={() => (editing = null)}>Cancel</Button>
        </div>
      {:else}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
        <h2
          class="field-input subject shown"
          class:readonly={!pr.canUpdate}
          tabindex={pr.canUpdate ? 0 : undefined}
          onfocus={() => edit('title')}
          onmousedown={keepLinks}
        >
          <Markdown text={pr.title} inline />
        </h2>
      {/if}
      <div class="byline muted">
        {#if pr.author}<Avatar name={pr.author.login} src={ghAvatar(pr.author.avatar)} size={16} round />{/if}
        <b>{pr.author?.login ?? 'ghost'}</b> opened this
        <span use:tooltip={formatFull(pr.createdAt)}>{formatRelative(pr.createdAt)}</span>
        {#if pr.state === 'merged' && pr.mergedAt}
          · merged by <b>{pr.mergedBy?.login ?? 'someone'}</b> <span use:tooltip={formatFull(pr.mergedAt)}>{formatRelative(pr.mergedAt)}</span>
        {/if}
        <span class="refs mono" use:tooltip={`Merges ${pr.head} into ${pr.base}`}>
          {#if pr.canUpdate && isLive(pr.state)}
            <button class="btn btn--ghost btn--sm ref" use:tooltip={'Change the base'} onclick={pickBase}>{pr.base}</button>
          {:else}
            <span class="ref">{pr.base}</span>
          {/if}
          <span class="muted" aria-label="from">←</span>
          <span class="ref">{pr.head}</span>
        </span>
      </div>
    </div>

    <div class="cols">
      <div class="main">
        <section class="card">
          <header class="card-head">
            <span class="muted">Description</span>
            <span class="spacer"></span>
            {#if pr.canUpdate && editing !== 'body'}
              <button class="btn btn--link" onclick={() => edit('body')}>Edit</button>
            {/if}
          </header>
          {#if editing === 'body'}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="card-body edit" onkeydown={onEditKey}>
              <TextArea bind:value={draft} rows={8} aria-label="Description" placeholder="Description" {@attach focusEnd} />
              <div class="actions">
                <Button variant="primary" onclick={saveEdit} disabled={working}>Save <Kbd hint="⌘↩" /></Button>
                <Button onclick={() => (editing = null)}>Cancel <Kbd hint="Esc" /></Button>
              </div>
            </div>
          {:else}
            <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
            <div class="card-body md-body" class:editable={pr.canUpdate} ondblclick={() => edit('body')}>
              {#if pr.body.trim()}<Markdown text={pr.body} />{:else}<p class="muted">No description</p>{/if}
            </div>
          {/if}
        </section>

        <section class="commits" aria-label="Commits">
          <h3 class="muted">
            {plural(pr.commitCount, 'commit')}
            {#if pr.commitCount > pr.commits.length}<span>(the last {pr.commits.length})</span>{/if}
          </h3>
          <ol>
            {#each pr.commits as c (c.sha)}
              {@const here = app.bySha.has(c.sha)}
              {@const k = c.checks ? CHECK[c.checks] : null}
              <li>
                {#if k}
                  <button
                    class="check"
                    style:color={k.color}
                    use:tooltip={`${k.label}: show them`}
                    aria-label={k.label}
                    aria-expanded={checks.open?.sha === c.sha}
                    onclick={(e) => checks.show(c.sha, e.currentTarget, c.sha === pr?.headSha ? pr.number : undefined)}
                  >
                    <k.icon weight="fill" />
                  </button>
                {:else}
                  <span class="check" style:color="var(--faint)" use:tooltip={'No checks'} aria-label="No checks"><Circle /></span>
                {/if}
                {#if here}
                  <button class="headline linked" use:tooltip={'Show this commit'} onclick={() => app.select(c.sha)}>{c.headline}</button>
                {:else}
                  <span class="headline" use:tooltip={"Not in this branch's history here"}>{c.headline}</span>
                {/if}
                <span class="mono sha" class:here>{c.short}</span>
              </li>
            {/each}
          </ol>
        </section>

        <ReviewThreads number={pr.number} />

        <PrTimeline {pr} {act} {working} />

        {#if pr.state !== 'closed' || pr.canUpdate}
          <PrMergeBox {pr} {act} {working} />
        {/if}

        <section class="card compose" aria-label="Add a comment">
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="card-body" onkeydown={onCommentKey}>
            <TextArea bind:value={comment} rows={3} placeholder="Comment…" aria-label="Comment" />
            <div class="actions end">
              {#if pr.canUpdate && pr.state === 'closed'}
                <Button onclick={() => setOpen(true)} disabled={working}>Reopen</Button>
              {:else if pr.canUpdate && pr.state !== 'merged'}
                <Button onclick={() => setOpen(false)} disabled={working}>
                  <GitPullRequestClosed /> {comment.trim() ? 'Close with comment' : 'Close'}
                </Button>
              {/if}
              <Button variant="primary" onclick={send} disabled={!comment.trim() || working}>Comment <Kbd hint="⌘↩" /></Button>
            </div>
          </div>
        </section>
      </div>

      <PrSide {pr} {act} {working} {options} />
    </div>
  {/if}
</div>

<style>
  .view {
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    min-height: 100%;
  }

  .top {
    display: flex;
    align-items: flex-start;
    gap: var(--gap-4);
    padding: var(--sp-4) var(--sp-5) 0 var(--sp-5);
  }

  .what {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--gap-4) var(--sp-4);
    min-height: var(--btn);
  }

  .num {
    color: var(--muted);
  }

  .refs {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-2);
    min-width: 0;
    max-width: 100%;
    font-size: var(--fs-sm);
  }

  /* Narrow, a long name is cut short (its full name is in the tooltip) rather than broken up. */
  .ref {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    padding: var(--gap-1) var(--sp-3);
    border-radius: var(--radius);
    background: var(--theme-soft);
    color: var(--theme2);
    font-family: var(--mono);
    font-size: var(--fs-sm);
  }

  .spacer {
    flex: 1;
  }

  .title {
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
    padding: var(--sp-4) var(--sp-5) var(--sp-5);
    border-bottom: 1px solid var(--border);
  }

  .subject {
    margin: 0;
    font-size: var(--fs-xl);
    font-weight: 600;
    padding: var(--sp-3) var(--sp-4);
    line-height: 1.4;
  }

  .edit-row {
    display: flex;
    gap: var(--gap-3);
    align-items: center;
  }

  .edit-row .subject {
    flex: 1;
  }

  .shown {
    cursor: text;
    overflow-wrap: anywhere;
  }

  .shown.readonly {
    cursor: auto;
    user-select: text;
    background: transparent;
    border-color: transparent;
  }

  .byline {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--gap-2);
    padding: 0 var(--sp-4);
    font-size: var(--fs-sm);
  }

  .byline b {
    color: var(--color);
    font-weight: 600;
  }

  .cols {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 220px;
    gap: var(--sp-5);
    padding: var(--sp-5);
    align-items: start;
  }

  @container (max-width: 720px) {
    .cols {
      grid-template-columns: minmax(0, 1fr);
    }

    .cols > :global(:last-child) {
      order: -1;
    }
  }

  .main {
    display: flex;
    flex-direction: column;
    gap: var(--sp-5);
    min-width: 0;
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
    gap: var(--gap-4);
    padding: var(--sp-2) var(--sp-4);
    background: var(--bg2);
    border-bottom: 1px solid var(--border);
    font-size: var(--fs-sm);
  }

  .card-body {
    padding: var(--sp-4);
    overflow-wrap: anywhere;
  }

  .card-body.edit,
  .compose .card-body {
    display: flex;
    flex-direction: column;
    gap: var(--gap-4);
  }

  .md-body.editable {
    cursor: text;
  }

  .md-body :global(.md > :first-child) {
    margin-top: 0;
  }

  .md-body :global(.md > :last-child) {
    margin-bottom: 0;
  }

  .actions {
    display: flex;
    gap: var(--gap-3);
  }

  .actions.end {
    justify-content: flex-end;
  }

  .commits h3 {
    margin: 0 0 var(--gap-3);
    font-size: var(--fs-sm);
    font-weight: 500;
  }

  .commits ol {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .commits li {
    display: flex;
    align-items: center;
    gap: var(--gap-4);
    padding: var(--sp-2) var(--sp-4);
    min-height: var(--row-h);
  }

  .commits li + li {
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
  }

  .linked {
    color: var(--color2);
  }

  @media (hover: hover) {
    .linked:hover {
      color: var(--theme2);
      text-decoration: underline;
    }
  }

  .sha {
    color: var(--faint);
    font-size: var(--fs-xs);
  }

  .sha.here {
    color: var(--theme2);
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-4);
    padding: 40px;
    text-align: center;
  }
</style>
