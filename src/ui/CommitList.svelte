<script lang="ts">
  import { Avatar, Tag, formatRelative, isMac, menu } from 'purr';
  import { ArrowUUpLeft, ArrowsMerge, CloudCheck, DotsSixVertical, GitBranch, GitMerge, PencilSimpleLine, Users } from 'purr/icons';
  import { WORK, app, avatarUrl, shortSha } from './lib/app.svelte.ts';
  import { newBranch } from './lib/branches.svelte.ts';

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
      {
        label: 'New branch from here…',
        icon: GitBranch,
        disabled: app.busy || blocked,
        run: () => newBranch(c.sha, `"${c.subject}"`),
      },
    ]);
  }

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

<ol class="list" role="listbox" aria-multiselectable="true">
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
      <span class="subject">Uncommitted changes</span>
      {#if w.staged}<Tag color="var(--add)" label="{w.staged} staged" title="Files with staged changes" />{/if}
      {#if w.unstaged}<Tag label="{w.unstaged} changed" title="Files with unstaged changes" />{/if}
      {#if w.untracked}<Tag label="{w.untracked} new" title="Untracked files" />{/if}
    </li>
  {/if}
  {#each app.commits as c, i (c.sha)}
    {#if !c.editable && (i === 0 || app.commits[i - 1].editable)}
      <li class="boundary muted">history below a merge can't be rewritten</li>
    {/if}
    <li
      data-sha={c.sha}
      class="row"
      class:is-current={app.selected.includes(c.sha)}
      class:locked={!c.editable}
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
      <span class="grip">
        {#if c.merge}<GitMerge />{:else if c.editable}<DotsSixVertical weight="bold" />{/if}
      </span>
      <span class="sha mono">{shortSha(c)}</span>
      <Avatar
        name={c.author.name}
        src={avatarUrl(c.author.email, 16)}
        seed={c.author.email.toLowerCase()}
        size={16}
        round
        title=""
      />
      <span class="subject" class:muted={!c.subject}>{c.subject || '(no message)'}</span>
      {#if c.coauthors.length}
        <span class="meta" title={c.coauthors.map((p) => p.name).join(', ')}><Users /></span>
      {/if}
      <span class="meta">{formatRelative(c.author.time * 1000)}</span>
      <span class="meta pushed">{#if c.pushed}<CloudCheck />{/if}</span>
    </li>
  {/each}
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
    box-shadow: inset 2px 0 0 var(--theme2);
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
