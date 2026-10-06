<script lang="ts">
  import { Avatar, Spinner, Tag, Twisty, formatRelative, isMac, menu } from 'purr';
  import { tick } from 'svelte';
  import { ArrowUUpLeft, ArrowsMerge, CloudCheck, DotsSixVertical, GitBranch, GitMerge, PencilSimpleLine, Users } from 'purr/icons';
  import { WORK, app, avatarUrl, shortSha } from './lib/app.svelte.ts';
  import Markdown from './Markdown.svelte';
  import { newBranch } from './lib/branches.svelte.ts';

  let list = $state<HTMLOListElement>();

  $effect(() => app.keep('list', () => list?.scrollTop ?? 0));
  $effect(() => {
    const top = app.started ? app.restore<number>('list') : undefined;
    if (top) tick().then(() => list && (list.scrollTop = top));
  });
  let dragging = $state<string[] | null>(null);
  let drop = $state<{ sha: string; after: boolean } | null>(null);

  function onclick(e: MouseEvent, sha: string) {
    app.select(sha, e.shiftKey ? 'range' : (isMac ? e.metaKey : e.ctrlKey) ? 'toggle' : 'set');
  }

  // Right-click inside a multi-selection offers to squash it; elsewhere it just selects the row.
  const canSquash = $derived(
    app.selection.length > 1 && app.selection.every((c) => c.editable) && !app.repo?.blocked,
  );

  function oncontextmenu(e: MouseEvent, sha: string) {
    e.preventDefault();
    if (app.selected.includes(sha) && app.selected.length > 1) {
      menu.show(e, [
        {
          label: `Squash ${app.selection.length} commits`,
          icon: ArrowsMerge,
          disabled: !canSquash || app.busy,
          note: canSquash
            ? `Into ${shortSha(app.selection.at(-1)!)}, with the message shown on the right.`
            : "Some of these commits can't be rewritten.",
          run: () => app.squash(app.selection),
        },
      ]);
      return;
    }
    app.select(sha);
    const c = app.bySha.get(sha);
    if (!c) return;
    const blocked = !!app.repo?.blocked;
    menu.show(e, [
      // The newest commit can be undone (its changes stay staged).
      sha === app.repo?.head && c.editable && !c.merge && !blocked && {
        label: 'Undo commit (keep changes)',
        icon: ArrowUUpLeft,
        disabled: app.busy,
        note: c.pushed ? "It was pushed: you'll need to force push afterwards." : undefined,
        run: () => app.uncommit(),
      },
      c.editable && !c.merge && !blocked && {
        label: 'Edit files…',
        icon: PencilSimpleLine,
        disabled: app.busy,
        note: 'Check it out, change anything, then finish to amend',
        run: () => app.editCommit(c.sha),
      },
      {
        label: 'New branch from here…',
        icon: GitBranch,
        disabled: app.busy || blocked,
        run: () => newBranch(c.sha, `"${c.subject}"`),
      },
    ]);
  }

  // Older history loads as the list nears its end, and again after each page if it still does.
  function loadIfNearEnd() {
    if (list && list.scrollHeight - list.scrollTop - list.clientHeight < 600) app.loadOlder();
  }

  $effect(() => {
    void app.commits.length;
    if (!app.loadingOlder) tick().then(loadIfNearEnd);
  });

  function ondragstart(e: DragEvent, sha: string) {
    if (!app.selected.includes(sha)) app.select(sha);
    dragging = app.editable.map((c) => c.sha).filter((s) => app.selected.includes(s));
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', dragging.join(' '));
  }

  function ondragover(e: DragEvent, sha: string) {
    if (!dragging) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    drop = { sha, after: e.clientY > r.top + r.height / 2 };
  }

  function ondrop(e: DragEvent) {
    e.preventDefault();
    if (dragging && drop && !dragging.includes(drop.sha)) {
      const rest = app.editable.map((c) => c.sha).filter((s) => !dragging!.includes(s));
      const at = rest.indexOf(drop.sha) + (drop.after ? 1 : 0);
      app.reorder([...rest.slice(0, at), ...dragging, ...rest.slice(at)]);
    }
    ondragend();
  }

  function ondragend() {
    dragging = null;
    drop = null;
  }
</script>

<ol class="list" role="listbox" aria-multiselectable="true" bind:this={list} onscroll={loadIfNearEnd}>
  {#if app.hasWork && app.repo}
    {@const w = app.repo.work}
    <li
      data-sha={WORK}
      class="row work"
      class:is-current={app.selected[0] === WORK}
      role="option"
      aria-selected={app.selected[0] === WORK}
      onclick={() => app.selectWork()}
      onkeydown={() => {}}
    >
      <span class="grip"><PencilSimpleLine /></span>
      {#if app.repo.conflict?.edit}
        <span class="subject">Editing "{app.repo.conflict.edit.subject}"</span>
      {:else if app.repo.conflict}
        {@const c = app.repo.conflict}
        <span class="subject">{c.kind === 'am' ? 'Patch series' : c.kind[0].toUpperCase() + c.kind.slice(1)} in progress</span>
        {#if c.files.length}<Tag color="var(--warn)" label="{c.files.length} conflicted" title="Files with conflicts" />{/if}
      {:else}
        <span class="subject">Uncommitted changes</span>
      {/if}
      {#if w.staged}<Tag color="var(--add)" label="{w.staged} staged" title="Files with staged changes" />{/if}
      {#if w.unstaged}<Tag label="{w.unstaged} changed" title="Files with unstaged changes" />{/if}
      {#if w.untracked}<Tag label="{w.untracked} new" title="Untracked files" />{/if}
    </li>
  {/if}
  {#each app.commits as c, i (c.sha)}
    {#if !c.editable && (i === 0 || app.commits[i - 1].editable)}
      <li class="boundary muted">{c.merge ? "history below a merge can't be rewritten" : "older history can't be rewritten here"}</li>
    {/if}
    <li
      data-sha={c.sha}
      class="row"
      class:is-current={app.selected.includes(c.sha)}
      class:locked={!c.editable}
      class:side={c.side}
      class:dnd-dragging={dragging?.includes(c.sha)}
      class:dnd-before={drop?.sha === c.sha && !drop.after}
      class:dnd-after={drop?.sha === c.sha && drop.after}
      role="option"
      aria-selected={app.selected.includes(c.sha)}
      draggable={c.editable && !app.repo?.blocked}
      onclick={(e) => onclick(e, c.sha)}
      onmouseenter={() => app.prefetch(c.sha)}
      oncontextmenu={(e) => oncontextmenu(e, c.sha)}
      onkeydown={() => {}}
      ondragstart={(e) => ondragstart(e, c.sha)}
      ondragover={(e) => c.editable && ondragover(e, c.sha)}
      ondragleave={() => drop?.sha === c.sha && (drop = null)}
      {ondrop}
      {ondragend}
      title="{c.author.name} <{c.author.email}>{c.pushed ? '\nPushed: rewriting it needs a force-push' : ''}"
    >
      {#if c.merge && !c.side}
        {@const open = c.sha in app.expanded}
        <button
          class="grip twisty"
          title={open ? 'Hide the merged commits' : 'Show the merged commits'}
          aria-label={open ? 'Hide the merged commits' : 'Show the merged commits'}
          aria-expanded={open}
          onclick={(e) => {
            e.stopPropagation();
            app.toggleMerge(c.sha);
          }}
        >
          <Twisty {open} size={10} />
        </button>
      {:else}
        <span class="grip">
          {#if c.merge}<GitMerge />{:else if c.editable}<DotsSixVertical weight="bold" />{/if}
        </span>
      {/if}
      <span class="sha mono">{shortSha(c)}</span>
      <Avatar
        name={c.author.name}
        src={avatarUrl(c.author.email, 16)}
        seed={c.author.email.toLowerCase()}
        size={16}
        round
        title=""
      />
      <span class="subject" class:muted={!c.subject}
        >{#if c.subject}<Markdown text={c.subject} inline links="mod" />{:else}(no message){/if}</span
      >
      {#if c.coauthors.length}
        <span class="meta" title={c.coauthors.map((p) => p.name).join(', ')}><Users /></span>
      {/if}
      <span class="meta">{formatRelative(c.author.time * 1000)}</span>
      <span class="meta pushed">{#if c.pushed}<CloudCheck />{/if}</span>
    </li>
    {#if c.merge && app.expanded[c.sha] === null}
      <li class="note side muted"><Spinner size={12} /> Loading merged commits…</li>
    {:else if c.merge && app.expanded[c.sha]?.commits.length === 0}
      <li class="note side muted">It didn't bring in any commits.</li>
    {/if}
    {#if c.side && app.commits[i + 1]?.side !== c.side}
      {@const m = app.expanded[c.side]}
      {#if m && m.total > m.commits.length}
        <li class="note side muted">…and {m.total - m.commits.length} older merged commits</li>
      {/if}
    {/if}
  {/each}
  {#if app.loadingOlder}
    <li class="note muted"><Spinner size={12} /> Loading older commits…</li>
  {/if}
</ol>

<style>
  .list {
    list-style: none;
    margin: 0;
    padding: var(--gap-3) 0;
    overflow: auto;
    flex: 1;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--gap-4);
    height: 30px;
    padding: 0 var(--sp-4) 0 var(--gap-2);
    margin: 0 var(--gap-3);
    border-radius: var(--radius);
    cursor: default;
  }

  @media (hover: hover) {
    .row:hover {
      background: var(--bg3);
    }
  }

  .row.is-current {
    background: var(--theme-soft);
  }

  .row.is-current .subject {
    color: var(--color2);
  }

  .row.locked {
    opacity: 0.5;
  }

  .grip {
    width: 14px;
    display: flex;
    font-size: var(--icon-md);
    color: var(--muted);
    opacity: 0.5;
    flex-shrink: 0;
  }

  .row[draggable='true'] .grip {
    cursor: grab;
  }

  .row:hover .grip {
    opacity: 1;
  }

  .sha {
    color: var(--theme2);
    flex-shrink: 0;
  }

  .subject {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    display: flex;
    color: var(--muted);
    font-size: var(--fs-xs);
    flex-shrink: 0;
  }

  .pushed {
    width: 13px;
    font-size: var(--icon-md);
  }

  .side {
    margin-left: calc(var(--gap-3) + 18px);
  }

  .twisty {
    all: unset;
    width: 14px;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    opacity: 1;
    cursor: pointer;
  }

  .note {
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    height: 30px;
    padding: 0 var(--sp-4) 0 var(--sp-5);
    font-size: var(--fs-xs);
  }

  .row.work .subject {
    font-style: italic;
    color: var(--color2);
  }

  .row.work .grip {
    opacity: 1;
    color: var(--theme2);
  }

  .boundary {
    font-size: var(--fs-xs);
    padding: var(--sp-4) var(--sp-5) var(--gap-2);
    border-top: 1px dashed var(--border);
    margin-top: var(--gap-3);
  }
</style>
