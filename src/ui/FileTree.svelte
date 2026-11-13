<script lang="ts">
  // The diff's files by folder. Clicking one scrolls the diff to it; the file being read is
  // highlighted, and kept in sight as the diff scrolls. Double-clicking one opens it in Zed;
  // right-clicking a file or a folder opens its menu. Conflicted files have a tree of their own, above the rest.
  import { Twisty, fixedRange, tooltip } from 'purr';
  import { untrack } from 'svelte';
  import type { FileSummary } from '../shared/types.ts';
  import { type TreeRow, fileTree, treeRows } from './lib/tree.ts';

  let {
    files,
    current,
    onpick,
    onopen,
    onmenu,
    ondirmenu,
    natural = $bindable(0),
  }: {
    files: FileSummary[];
    /** Index of the file at the top of the diff, or -1. */
    current: number;
    onpick: (i: number) => void;
    /** Open a file in the editor (double-click). */
    onopen?: (i: number) => void;
    /** A file's context menu. */
    onmenu?: (e: MouseEvent, i: number) => void;
    /** A folder's context menu, with its full path. */
    ondirmenu?: (e: MouseEvent, dir: string) => void;
    /** How tall it would be with every row shown (out): a short tree needs no more room. */
    natural?: number;
  } = $props();

  /** A row: a folder or file of one of the trees (`group` 'c:' for the conflicted one's), or a tree's label. */
  type Row = (TreeRow & { group: string }) | { kind: 'label'; text: string; group: string; first: boolean };
  const paths = $derived(files.map((f) => f.path));
  const conflicted = $derived(files.some((f) => f.conflicted));
  const tree = $derived(fileTree(paths, conflicted ? (i) => !files[i].conflicted : undefined));
  const top = $derived(conflicted ? fileTree(paths, (i) => !!files[i].conflicted) : []);
  // Folders by group and path: the same folder can be in both trees.
  let collapsed = $state<Record<string, boolean>>({});
  const rows = $derived.by((): Row[] => {
    const rest = treeRows(tree, collapsed).map((r) => ({ ...r, group: '' }));
    if (!conflicted) return rest;
    const out: Row[] = [{ kind: 'label', text: 'Conflicted', group: 'c:', first: true }];
    for (const r of treeRows(top, collapsed, 'c:')) out.push({ ...r, group: 'c:' });
    if (rest.length) out.push({ kind: 'label', text: 'Merged', group: '', first: false }, ...rest);
    return out;
  });
  let list: HTMLElement;
  let above: HTMLElement;

  // Only the rows near the view are mounted (a commit can touch thousands of files); rows are ROW px.
  const ROW = 24;
  const OVERSCAN = 600;
  let scrollTop = $state(0);
  let height = $state(0);
  const shown = $derived(fixedRange(rows.length, ROW, scrollTop - OVERSCAN, height + 2 * OVERSCAN));

  // The list's padding above the rows, read again only when it's resized: reading layout as the
  // current file changes (each frame of a fast scroll) would force a layout every time.
  let pad = 0;
  $effect(() => {
    void height;
    pad = above.offsetTop;
    natural = rows.length * ROW + 2 * pad;
  });

  $effect(() => {
    const at = current;
    const k = untrack(() => rows.findIndex((r) => r.kind === 'file' && r.index === at));
    if (k < 0 || !list) return;
    const top = pad + k * ROW;
    const bottom = top + ROW;
    const [y, h, n] = untrack(() => [scrollTop, height, rows.length]);
    const to = top < y ? top - ROW : bottom > y + h ? bottom - h + ROW : y;
    // Where the list will be, kept at once so the rows there mount in this frame.
    if (to !== y) list.scrollTop = scrollTop = Math.max(0, Math.min(to, n * ROW + 2 * pad - h));
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
  {#each rows.slice(shown[0], shown[1]) as r (r.kind === 'label' ? `l:${r.group}` : r.kind === 'dir' ? `d:${r.group}${r.path}` : r.index)}
    {#if r.kind === 'label'}
      <div class="label" class:conflicts={r.group} class:first={r.first} role="presentation">{r.text}</div>
    {:else if r.kind === 'dir'}
      {@const key = r.group + r.path}
      <button
        class="row dir"
        style:--depth={r.depth}
        role="treeitem"
        aria-selected="false"
        aria-expanded={!collapsed[key]}
        use:tooltip={r.path}
        onclick={() => (collapsed[key] = !collapsed[key])}
        oncontextmenu={ondirmenu && ((e) => ondirmenu(e, r.path))}
      >
        <Twisty open={!collapsed[key]} size={10} />
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
        use:tooltip={`${f.path}\n${f.conflicted ? 'conflicted, ' : ''}${f.untracked ? 'untracked' : statusTitle[f.status]}${f.oldPath ? ` from ${f.oldPath}` : ''}, +${f.added} −${f.removed}${onopen && f.status !== 'D' ? '\nDouble-click to open in Zed' : ''}`}
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

  /* A tree's name: the conflicted files', then the rest's under a rule. */
  .label {
    box-sizing: border-box;
    height: 24px;
    display: flex;
    align-items: center;
    padding: 0 var(--gap-4) 0 var(--gap-3);
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--muted);
    user-select: none;
  }

  .label:not(.first) {
    margin: 0 var(--gap-3);
    padding-left: 0;
    border-top: 1px solid var(--border);
    padding-top: var(--gap-2);
  }

  .label.conflicts {
    color: var(--warn);
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
