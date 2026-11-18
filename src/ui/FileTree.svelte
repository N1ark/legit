<script module lang="ts">
  let knownPad = 0;
</script>

<script lang="ts">
  // The diff's files by folder. Clicking one scrolls the diff to it; the file being read is
  // highlighted, and kept in sight as the diff scrolls. Double-clicking one opens it in Zed;
  // right-clicking a file or a folder opens its menu. Conflicted files have a tree of their own, above the rest.
  // Once a row has the focus (clicked), ↑/↓ go to the file above or below instead of the next commit.
  import { Twisty, fixedRange, tooltip } from 'purr';
  import { ChatCircleCheckRegular, ChatCircleFill, CheckBold, CubeRegular, UserFill } from 'purr/glyphs';
  import NoteIcon from './gh/NoteIcon.svelte';
  import { type NoteCounts, describeNotes } from './lib/gh-files.ts';
  import { tick, untrack } from 'svelte';
  import type { FileSummary } from '../shared/types.ts';
  import { type TreeRow, fileTree, treeRows } from './lib/tree.ts';
  import { sized } from './lib/size.ts';

  let {
    files,
    current,
    onpick,
    onopen,
    onmenu,
    ondirmenu,
    mark,
    onthreads,
    only,
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
    /** A pull request's marks on file i: viewed, the viewer's own, CI's annotations on it, its review threads. */
    mark?: (i: number) => { viewed: boolean; mine: boolean; notes: NoteCounts | null; threads: { open: number; resolved: number } | null } | null;
    /** Go to file i's first review thread (a click on its count). */
    onthreads?: (i: number) => void;
    /** Only the files it keeps are listed. */
    only?: ((i: number) => boolean) | null;
    /** How tall it would be with every row shown (out): a short tree needs no more room. */
    natural?: number;
  } = $props();

  /** A row: a folder or file of one of the trees (`group` 'c:' for the conflicted one's), or a tree's label. */
  type Row = (TreeRow & { group: string }) | { kind: 'label'; text: string; group: string; first: boolean };
  const paths = $derived(files.map((f) => f.path));
  const conflicted = $derived(files.some((f) => f.conflicted));
  const tree = $derived(fileTree(paths, conflicted || only ? (i) => !files[i].conflicted && (!only || only(i)) : undefined));
  const top = $derived(conflicted ? fileTree(paths, (i) => !!files[i].conflicted && (!only || only(i))) : []);
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
  /** [first, end) of the rows mounted; the same array while they stay the same, as they do for most scroll events. */
  let lastShown: [number, number] = [0, 0];
  const shown = $derived.by(() => {
    const [a, b] = fixedRange(rows.length, ROW, scrollTop - OVERSCAN, height + 2 * OVERSCAN);
    return a === lastShown[0] && b === lastShown[1] ? lastShown : (lastShown = [a, b]);
  });
  const slice = $derived(rows.slice(shown[0], shown[1]));

  // The list's padding above the rows, read again only as it's resized, once laid out: reading layout as the
  // current file changes (each frame of a fast scroll), or as the tree mounts, would force a layout then.
  let pad = knownPad;
  const measure = (el: HTMLElement) => {
    pad = knownPad = above.offsetTop;
    return el.clientHeight;
  };
  $effect(() => {
    void height;
    natural = rows.length * ROW + 2 * pad;
  });

  /** Its height is in, once laid out: until then, whether the current file is in sight can't be told. */
  const laidOut = $derived(height > 0);
  $effect(() => {
    const at = current;
    if (!laidOut) return;
    const k = untrack(() => rows.findIndex((r) => r.kind === 'file' && r.index === at));
    if (k < 0 || !list) return;
    const top = pad + k * ROW;
    const bottom = top + ROW;
    const [y, h, n] = untrack(() => [scrollTop, height, rows.length]);
    const to = top < y ? top - ROW : bottom > y + h ? bottom - h + ROW : y;
    // Where the list will be, kept at once so the rows there mount in this frame.
    if (to !== y) list.scrollTop = scrollTop = Math.max(0, Math.min(to, n * ROW + 2 * pad - h));
  });

  /** ↑/↓ on a row: the file above or below it is picked, and takes the focus. */
  async function onkeydown(e: KeyboardEvent) {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const at = Number((e.target as HTMLElement).closest<HTMLElement>('[data-k]')?.dataset.k ?? -1);
    if (at < 0) return;
    // The commit list's own ↑/↓ stay out of it, even with no file further on.
    e.preventDefault();
    e.stopPropagation();
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    let k = at + dir;
    while (k >= 0 && k < rows.length && rows[k].kind !== 'file') k += dir;
    const r = rows[k];
    if (!r || r.kind !== 'file') return;
    onpick(r.index);
    // Scrolled into the mounted rows first, when it's past them.
    if (k < shown[0] || k >= shown[1]) list.scrollTop = scrollTop = Math.max(0, pad + k * ROW - height / 2);
    await tick();
    list.querySelector<HTMLElement>(`[data-k="${k}"]`)?.focus({ preventScroll: true });
  }

  const STATUS = { A: 'A', D: 'D', M: 'M', T: 'T', R: 'R', C: 'C' };
  const statusTitle = { A: 'added', D: 'deleted', M: 'modified', T: 'type changed', R: 'renamed', C: 'copied' };

  const marksTip = (m: NonNullable<ReturnType<NonNullable<typeof mark>>>) =>
    `${m.viewed ? '\nViewed' : ''}${m.mine ? '\nYou own it' : ''}${m.threads ? `\n${threadsLabel(m.threads)}` : ''}${m.notes ? `\nCI: ${describeNotes(m.notes)}` : ''}`;
  const threadsLabel = ({ open, resolved }: { open: number; resolved: number }) =>
    [open && `${open} unresolved ${open === 1 ? 'thread' : 'threads'}`, resolved && `${resolved} resolved`].filter(Boolean).join(', ');

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
  {@attach sized(measure, (h) => (height = h))}
  role="tree"
  tabindex="-1"
  aria-label="Changed files"
  {onkeydown}
  onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
>
  <div bind:this={above} style:height="{shown[0] * ROW}px"></div>
  {#each slice as r, j (r.kind === 'label' ? `l:${r.group}` : r.kind === 'dir' ? `d:${r.group}${r.path}` : r.index)}
    {#if r.kind === 'label'}
      <div class="label" class:conflicts={r.group} class:first={r.first} role="presentation">{r.text}</div>
    {:else if r.kind === 'dir'}
      {@const key = r.group + r.path}
      <button
        class="row dir"
        data-k={shown[0] + j}
        style:--depth={r.depth}
        role="treeitem"
        aria-selected="false"
        aria-expanded={!collapsed[key]}
        use:tooltip={r.path}
        onclick={(e) => {
          e.currentTarget.focus();
          collapsed[key] = !collapsed[key];
        }}
        oncontextmenu={ondirmenu && ((e) => ondirmenu(e, r.path))}
      >
        <Twisty open={!collapsed[key]} size={10} />
        <span class="name">{r.name}</span>
      </button>
    {:else}
      {@const f = files[r.index]}
      {@const m = mark?.(r.index)}
      <button
        class="row file"
        data-k={shown[0] + j}
        class:is-current={r.index === current}
        style:--depth={r.depth}
        role="treeitem"
        aria-selected={r.index === current}
        use:tooltip={`${f.path}\n${f.submodule ? (f.submodule.nested ? 'nested repository, ' : 'submodule, ') : ''}${f.conflicted ? 'conflicted, ' : ''}${f.untracked ? 'untracked' : statusTitle[f.status]}${f.oldPath ? ` from ${f.oldPath}` : ''}, +${f.added} −${f.removed}${m ? marksTip(m) : ''}${onopen && f.status !== 'D' ? '\nDouble-click to open in Zed' : ''}`}
        onclick={(e) => {
          // WebKit doesn't focus a clicked button: the arrows need it to.
          e.currentTarget.focus();
          onpick(r.index);
        }}
        ondblclick={onopen && (() => onopen(r.index))}
        oncontextmenu={onmenu && ((e) => onmenu(e, r.index))}
      >
        {#if f.submodule}<span class="sub" aria-label={f.submodule.nested ? 'Nested repository' : 'Submodule'}><CubeRegular /></span>{/if}
        <span class="name" class:add={f.status === 'A' || f.untracked} class:del={f.status === 'D'} class:seen={m?.viewed}
          >{r.name}{#if f.oldPath}<span class="from">← {source(f)}</span>{/if}</span
        >
        {#if m?.threads}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <span
            class="mk threads"
            class:open={m.threads.open > 0}
            onclick={onthreads &&
              ((e) => {
                e.stopPropagation();
                onthreads(r.index);
              })}
            ondblclick={(e) => e.stopPropagation()}
            >{#if m.threads.open}<ChatCircleFill />{m.threads.open}{:else}<ChatCircleCheckRegular />{m.threads.resolved}{/if}</span
          >
        {/if}
        {#if m?.notes}<span class="mk notes"><NoteIcon level={m.notes.level} />{m.notes.count}</span>{/if}
        {#if m?.mine}<span class="mk mine"><UserFill /></span>{/if}
        {#if m?.viewed}<span class="mk seen"><CheckBold /></span>{/if}
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

  /* A submodule's mark, before its name. */
  .sub {
    display: flex;
    flex: none;
    margin-right: calc(-1 * var(--gap-1));
    color: var(--muted);
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

  .name.seen:not(.add, .del) {
    color: var(--muted);
  }

  .mk {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-1);
    flex-shrink: 0;
    font-size: var(--fs-xs);
    color: var(--muted);
  }

  /* Unresolved threads stand out; resolved ones only, quietly. */
  .mk.threads.open {
    color: var(--theme2);
    font-weight: 600;
  }

  .mk.mine {
    color: var(--theme2);
  }

  .mk.seen {
    color: var(--success);
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
