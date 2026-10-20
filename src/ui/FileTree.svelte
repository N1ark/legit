<script lang="ts">
  // The diff's files by folder. Clicking one scrolls the diff to it; the file being read is
  // highlighted, and kept in sight as the diff scrolls. Double-clicking one opens it in Zed;
  // right-clicking one opens its menu.
  import { Twisty, fixedRange, tooltip } from 'purr';
  import { untrack } from 'svelte';
  import type { FileSummary } from '../shared/types.ts';
  import { fileTree, treeRows } from './lib/tree.ts';

  let {
    files,
    current,
    onpick,
    onopen,
    onmenu,
  }: {
    files: FileSummary[];
    /** Index of the file at the top of the diff, or -1. */
    current: number;
    onpick: (i: number) => void;
    /** Open a file in the editor (double-click). */
    onopen?: (i: number) => void;
    /** A file's context menu. */
    onmenu?: (e: MouseEvent, i: number) => void;
  } = $props();

  const tree = $derived(fileTree(files.map((f) => f.path)));
  let collapsed = $state<Record<string, boolean>>({});
  const rows = $derived(treeRows(tree, collapsed));
  let list: HTMLElement;
  let above: HTMLElement;

  // Only the rows near the view are mounted (a commit can touch thousands of files); rows are ROW px.
  const ROW = 24;
  const OVERSCAN = 600;
  let scrollTop = $state(0);
  let height = $state(0);
  const shown = $derived(fixedRange(rows.length, ROW, scrollTop - OVERSCAN, height + 2 * OVERSCAN));

  $effect(() => {
    const at = current;
    const k = untrack(() => rows.findIndex((r) => r.kind === 'file' && r.index === at));
    if (k < 0 || !list) return;
    const top = above.offsetTop + k * ROW;
    const bottom = top + ROW;
    if (top < list.scrollTop) list.scrollTop = top - ROW;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + ROW;
  });

  const STATUS = { A: 'A', D: 'D', M: 'M', T: 'T', R: 'R', C: 'C' };
  const statusTitle = { A: 'added', D: 'deleted', M: 'modified', T: 'type changed', R: 'renamed', C: 'copied' };

  /** Where a renamed file came from: its old name, or its old path when it moved folders. */
  function source(f: FileSummary): string {
    const old = f.oldPath!;
    const dir = (p: string) => p.slice(0, p.lastIndexOf('/') + 1);
    return dir(old) === dir(f.path) ? old.slice(dir(old).length) : old;
  }
</script>

<div
  class="tree"
  bind:this={list}
  bind:clientHeight={height}
  role="tree"
  aria-label="Changed files"
  onscroll={() => (scrollTop = list.scrollTop)}
>
  <div bind:this={above} style:height="{shown[0] * ROW}px"></div>
  {#each rows.slice(shown[0], shown[1]) as r (r.kind === 'dir' ? `d:${r.path}` : r.index)}
    {#if r.kind === 'dir'}
      <button
        class="row dir"
        style:--depth={r.depth}
        role="treeitem"
        aria-selected="false"
        aria-expanded={!collapsed[r.path]}
        use:tooltip={r.path}
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
        use:tooltip={`${f.path}\n${f.untracked ? 'untracked' : statusTitle[f.status]}${f.oldPath ? ` from ${f.oldPath}` : ''}, +${f.added} −${f.removed}${onopen && f.status !== 'D' ? '\nDouble-click to open in Zed' : ''}`}
        onclick={() => onpick(r.index)}
        ondblclick={onopen && (() => onopen(r.index))}
        oncontextmenu={onmenu && ((e) => onmenu(e, r.index))}
      >
        <span class="name" class:add={f.status === 'A' || f.untracked} class:del={f.status === 'D'}
          >{r.name}{#if f.oldPath}<span class="from">← {source(f)}</span>{/if}</span
        >
        <span class="status mono" class:add={f.status === 'A' || f.untracked} class:del={f.status === 'D'}
          >{f.untracked ? 'U' : STATUS[f.status]}</span
        >
      </button>
    {/if}
  {/each}
  <div style:height="{(rows.length - shown[1]) * ROW}px"></div>
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

  .dir .name,
  .from {
    color: var(--muted);
  }

  .from {
    margin-left: var(--gap-2);
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
