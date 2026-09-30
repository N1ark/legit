<script lang="ts">
  import CloudCheckIcon from 'phosphor-svelte/lib/CloudCheckIcon';
  import DotsSixVerticalIcon from 'phosphor-svelte/lib/DotsSixVerticalIcon';
  import GitMergeIcon from 'phosphor-svelte/lib/GitMergeIcon';
  import ArrowUUpLeftIcon from 'phosphor-svelte/lib/ArrowUUpLeftIcon';
  import ArrowsMergeIcon from 'phosphor-svelte/lib/ArrowsMergeIcon';
  import UsersIcon from 'phosphor-svelte/lib/UsersIcon';
  import Avatar from './Avatar.svelte';
  import ContextMenu from './ContextMenu.svelte';
  import PencilSimpleLineIcon from 'phosphor-svelte/lib/PencilSimpleLineIcon';
  import { WORK, ago, app, shortSha } from './lib/app.svelte.ts';

  const mac = navigator.platform.startsWith('Mac');

  let dragging = $state<string[] | null>(null);
  let drop = $state<{ sha: string; after: boolean } | null>(null);

  function onclick(e: MouseEvent, sha: string) {
    app.select(sha, e.shiftKey ? 'range' : (mac ? e.metaKey : e.ctrlKey) ? 'toggle' : 'set');
  }

  // Right-click inside a multi-selection offers to squash it; elsewhere it just selects the row.
  let menu = $state<{ x: number; y: number; head: boolean } | null>(null);
  const canSquash = $derived(
    app.selection.length > 1 && app.selection.every((c) => c.editable) && !app.repo?.blocked,
  );

  function oncontextmenu(e: MouseEvent, sha: string) {
    e.preventDefault();
    if (app.selected.includes(sha) && app.selected.length > 1) menu = { x: e.clientX, y: e.clientY, head: false };
    else {
      app.select(sha);
      const c = app.bySha.get(sha);
      // The newest commit can be undone (its changes stay staged).
      if (sha === app.repo?.head && c?.editable && !c.merge && !app.repo?.blocked) {
        menu = { x: e.clientX, y: e.clientY, head: true };
      }
    }
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

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} onclose={() => (menu = null)}>
    {#if menu.head}
      <button
        role="menuitem"
        disabled={app.busy}
        onclick={() => {
          menu = null;
          app.uncommit();
        }}
      >
        <ArrowUUpLeftIcon size={14} /> Undo commit (keep changes)
      </button>
      {#if app.selection[0]?.pushed}<p class="note">It was pushed: you'll need to force push afterwards.</p>{/if}
    {:else}
    <button
      role="menuitem"
      disabled={!canSquash || app.busy}
      onclick={() => {
        menu = null;
        app.squash(app.selection);
      }}
    >
      <ArrowsMergeIcon size={14} /> Squash {app.selection.length} commits
    </button>
    <p class="note">
      {canSquash
        ? `Into ${app.selection.at(-1)!.sha.slice(0, 7)}, with the message shown on the right.`
        : "Some of these commits can't be rewritten."}
    </p>
    {/if}
  </ContextMenu>
{/if}

<ol class="list" role="listbox" aria-multiselectable="true">
  {#if app.hasWork && app.repo}
    {@const w = app.repo.work}
    <li
      data-sha={WORK}
      class="row work"
      class:selected={app.selected[0] === WORK}
      role="option"
      aria-selected={app.selected[0] === WORK}
      onclick={() => app.selectWork()}
      onkeydown={() => {}}
    >
      <span class="grip"><PencilSimpleLineIcon size={13} /></span>
      <span class="subject">Uncommitted changes</span>
      {#if w.staged}<span class="pill staged" title="Files with staged changes">{w.staged} staged</span>{/if}
      {#if w.unstaged}<span class="pill" title="Files with unstaged changes">{w.unstaged} changed</span>{/if}
      {#if w.untracked}<span class="pill" title="Untracked files">{w.untracked} new</span>{/if}
    </li>
  {/if}
  {#each app.commits as c, i (c.sha)}
    {#if !c.editable && (i === 0 || app.commits[i - 1].editable)}
      <li class="boundary dim">history below a merge can't be rewritten</li>
    {/if}
    <li
      data-sha={c.sha}
      class="row"
      class:selected={app.selected.includes(c.sha)}
      class:locked={!c.editable}
      class:dragged={dragging?.includes(c.sha)}
      class:drop-before={drop?.sha === c.sha && !drop.after}
      class:drop-after={drop?.sha === c.sha && drop.after}
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
        {#if c.merge}<GitMergeIcon size={13} />{:else if c.editable}<DotsSixVerticalIcon size={13} weight="bold" />{/if}
      </span>
      <span class="sha mono">{shortSha(c)}</span>
      <Avatar email={c.author.email} name={c.author.name} size={16} />
      <span class="subject" class:dim={!c.subject}>{c.subject || '(no message)'}</span>
      {#if c.coauthors.length}
        <span class="meta" title={c.coauthors.map((p) => p.name).join(', ')}><UsersIcon size={12} /></span>
      {/if}
      <span class="meta">{ago(c.author.time)}</span>
      <span class="meta pushed">{#if c.pushed}<CloudCheckIcon size={13} />{/if}</span>
    </li>
  {/each}
</ol>

<style>
  .list {
    list-style: none;
    margin: 0;
    padding: 6px 0;
    overflow: auto;
    flex: 1;
    user-select: none;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 10px 0 4px;
    margin: 0 6px;
    border-radius: 4px;
    cursor: default;
    position: relative;
  }

  .row:hover {
    background: var(--bg3);
  }

  .row.selected {
    background: var(--theme-soft);
    box-shadow: inset 2px 0 0 var(--theme);
  }

  .row.selected .subject {
    color: var(--color2);
  }

  .row.locked {
    opacity: 0.5;
  }

  .row.dragged {
    opacity: 0.35;
  }

  .row.drop-before::before,
  .row.drop-after::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    height: 2px;
    background: var(--theme);
    border-radius: 1px;
  }

  .row.drop-before::before {
    top: -1px;
  }

  .row.drop-after::after {
    bottom: -1px;
  }

  .grip {
    width: 14px;
    display: flex;
    color: var(--dim);
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
    color: var(--theme);
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
    color: var(--dim);
    font-size: 11.5px;
    flex-shrink: 0;
  }

  .pushed {
    width: 13px;
  }

  .row.work .subject {
    font-style: italic;
    color: var(--color2);
  }

  .row.work .grip {
    opacity: 1;
    color: var(--theme);
  }

  .pill {
    font-size: 10.5px;
    padding: 0 6px;
    border-radius: 8px;
    background: var(--bg3);
    color: var(--dim);
    flex-shrink: 0;
  }

  .pill.staged {
    background: var(--add-bg);
    color: var(--add);
  }

  .boundary {
    font-size: 11px;
    padding: 10px 16px 4px;
    border-top: 1px dashed var(--border);
    margin-top: 6px;
  }
</style>
