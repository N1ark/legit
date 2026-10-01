<script lang="ts">
  // The diff's files by folder. Clicking one scrolls the diff to it; the file being read is
  // highlighted, and kept in sight as the diff scrolls.
  import { Twisty } from 'purr';
  import type { FileSummary } from '../shared/types.ts';
  import { fileTree, treeRows } from './lib/tree.ts';

  let {
    files,
    current,
    onpick,
  }: {
    files: FileSummary[];
    /** Index of the file at the top of the diff, or -1. */
    current: number;
    onpick: (i: number) => void;
  } = $props();

  const tree = $derived(fileTree(files.map((f) => f.path)));
  let collapsed = $state<Record<string, boolean>>({});
  const rows = $derived(treeRows(tree, collapsed));
  let list: HTMLElement;

  $effect(() => {
    void current;
    const row = list?.querySelector<HTMLElement>('.is-current');
    if (!row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top - row.offsetHeight;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + row.offsetHeight;
  });

  const STATUS = { A: 'A', D: 'D', M: 'M', T: 'T' };
  const statusTitle = { A: 'added', D: 'deleted', M: 'modified', T: 'type changed' };
</script>

<div class="tree" bind:this={list} role="tree" aria-label="Changed files">
  {#each rows as r (r.kind === 'dir' ? `d:${r.path}` : r.index)}
    {#if r.kind === 'dir'}
      <button
        class="row dir"
        style:--depth={r.depth}
        role="treeitem"
        aria-selected="false"
        aria-expanded={!collapsed[r.path]}
        title={r.path}
        onclick={() => (collapsed[r.path] = !collapsed[r.path])}
      >
        <Twisty open={!collapsed[r.path]} size={10} />
        <span class="name">{r.name}</span>
      </button>
    {:else}
      {@const f = files[r.index]}
      <button
        class="row file"
        class:is-current={r.index === current}
        style:--depth={r.depth}
        role="treeitem"
        aria-selected={r.index === current}
        title="{f.path}{'\n'}{f.untracked ? 'untracked' : statusTitle[f.status]}, +{f.added} −{f.removed}"
        onclick={() => onpick(r.index)}
      >
        <span class="name" class:add={f.status === 'A' || f.untracked} class:del={f.status === 'D'}>{r.name}</span>
        <span class="status mono" class:add={f.status === 'A' || f.untracked} class:del={f.status === 'D'}
          >{f.untracked ? 'U' : STATUS[f.status]}</span
        >
      </button>
    {/if}
  {/each}
</div>

<style>
  .tree {
    position: relative;
    height: 100%;
    overflow: auto;
    overscroll-behavior: contain;
    padding: var(--gap-2) 0;
  }

  .row {
    all: unset;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    width: 100%;
    height: 24px;
    padding: 0 var(--gap-4) 0 calc(var(--gap-3) + var(--depth) * 12px);
    border-radius: var(--radius);
    font-size: var(--fs-sm);
    cursor: default;
  }

  /* Files line up with the names of the folders beside them, past the chevron. */
  .file {
    padding-left: calc(var(--gap-3) + var(--depth) * 12px + 10px + var(--gap-2));
  }

  .row:focus-visible {
    outline: 2px solid var(--theme2);
    outline-offset: -2px;
  }

  @media (hover: hover) {
    .row:hover {
      background: var(--bg3);
    }
  }

  .row.is-current {
    background: var(--theme-soft);
  }

  .row.is-current .name:not(.add, .del) {
    color: var(--color2);
  }

  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dir .name {
    color: var(--muted);
  }

  .status {
    flex-shrink: 0;
    font-size: var(--fs-xs);
    color: var(--muted);
  }

  .add {
    color: var(--add);
  }

  .del {
    color: var(--del);
  }

  .name.del {
    text-decoration: line-through;
  }
</style>
