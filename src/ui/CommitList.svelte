<script lang="ts">
  import CloudCheckIcon from 'phosphor-svelte/lib/CloudCheckIcon';
  import DotsSixVerticalIcon from 'phosphor-svelte/lib/DotsSixVerticalIcon';
  import GitMergeIcon from 'phosphor-svelte/lib/GitMergeIcon';
  import UsersIcon from 'phosphor-svelte/lib/UsersIcon';
  import { ago, app, shortSha } from './lib/app.svelte.ts';

  const mac = navigator.platform.startsWith('Mac');

  let dragging = $state<string[] | null>(null);
  let drop = $state<{ sha: string; after: boolean } | null>(null);

  function onclick(e: MouseEvent, sha: string) {
    app.select(sha, e.shiftKey ? 'range' : (mac ? e.metaKey : e.ctrlKey) ? 'toggle' : 'set');
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

  .boundary {
    font-size: 11px;
    padding: 10px 16px 4px;
    border-top: 1px dashed var(--border);
    margin-top: 6px;
  }
</style>
