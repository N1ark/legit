<script lang="ts">
  // Virtualized diff. Rows have a fixed height and never wrap, so every file's height is
  // known from the summary alone: the full layout (and scrollbar) exists before any content
  // loads, nothing is ever measured, and nothing jumps. Only files near the viewport are
  // mounted, and within them only the rows near the viewport. Contents load as files come
  // into view; highlighting runs in a worker and fills in afterwards.
  import {
    type MaybeEntry,
    ResizeEdge,
    Tag,
    Twisty,
    fixedRange,
    menu,
    offsets,
    persisted,
    rowAt,
    toast,
    variableRange,
  } from 'purr';
  import { Copy, Eraser, FileArrowUp, PencilSimple } from 'purr/icons';
  import { flushSync, onMount, untrack } from 'svelte';
  import type { SvelteSet } from 'svelte/reactivity';
  import type { DiffSummary, FileSummary, Selection } from '../shared/types.ts';
  import FileTree from './FileTree.svelte';
  import { type DiffPosition, app } from './lib/app.svelte.ts';
  import { type Tokens, highlight, segments } from './lib/highlighter.ts';
  import { ADDED, type FileRows, HUNK, REMOVED, buildRows } from './lib/rows.ts';

  let {
    summary,
    sel,
    readonly,
    hint = 'Pick lines to split out: click, drag, or shift-click; the left edge picks whole blocks.',
    fileActions,
    tree = false,
    initial = null,
    onremove,
    oneditline,
  }: {
    summary: DiffSummary;
    sel: Record<string, SvelteSet<number>>;
    readonly: boolean;
    hint?: string;
    /** More entries for a file's context menu. */
    fileActions?: (f: FileSummary) => MaybeEntry[];
    /** Show the files as a folder tree beside the diff, to jump between them. */
    tree?: boolean;
    /** Where to open, from `position()` of the view this one replaces. */
    initial?: DiffPosition | null;
    /** Take changes out of the commit (offered in a changed line's menu). */
    onremove?: (selection: Selection) => void;
    /** Replace line `line` of the commit's version of file `path` with `text` (lines separated by \n). */
    oneditline?: (path: string, line: number, text: string) => Promise<boolean>;
  } = $props();

  // Fixed geometry (px). The CSS below pins elements to exactly these sizes.
  const HEAD = 34;
  const ROW = 19;
  const NOTE = 38;
  const PAD = 4;
  const GAP = 10;
  /** Block strip + old/new line numbers + marker; keep in sync with .gutter's CSS width. */
  const GUTTER = 98;
  /** How far beyond the viewport to render, so scrolling rarely shows unrendered rows. */
  const OVERSCAN = 1200;
  /** Files past the viewport whose contents are fetched ahead of time. */
  const PREFETCH = 4;

  const files = $derived(summary.files);
  // Generated files (lockfiles etc.) start collapsed. The view is re-created per commit.
  let collapsed = $state<Record<number, boolean>>(
    untrack(() =>
      Object.fromEntries(
        summary.files.flatMap((f, i) => ((initial ? initial.collapsed.includes(f.path) : f.generated) ? [[i, true]] : [])),
      ),
    ),
  );
  const generatedCount = $derived(files.filter((f) => f.generated).length);
  let contents = $state.raw<Record<number, FileRows>>({});
  let tokens = $state.raw<Record<number, Tokens>>({});
  let view = $state({ top: 0, bottom: 1000 });
  let filesEl: HTMLElement;
  let scroller: HTMLElement;
  let alive = true;

  // Editing a line in place (double-click it, or its menu): the row becomes a text field, which
  // grows by a row per line typed into it and pushes the rows below down.
  let editing = $state<{ i: number; r: number; text: string; orig: string } | null>(null);
  let saving = $state(false);
  const editRows = $derived(editing ? editing.text.split('\n').length : 1);

  const bodyHeight = (i: number) =>
    files[i].rows ? files[i].rows * ROW + PAD + (editing?.i === i ? (editRows - 1) * ROW : 0) : NOTE;
  /** tops[i] = y of file i; tops[n] = total height (plus one trailing gap). */
  const tops = $derived(offsets(files.length, (i) => HEAD + (collapsed[i] ? 0 : bodyHeight(i)) + GAP));
  const fileHeight = (i: number) => tops[i + 1] - tops[i] - GAP;

  /** [first, end) of the files overlapping the viewport plus overscan. */
  const range = $derived(variableRange(tops, view.top, view.bottom - view.top, OVERSCAN));
  const visible = $derived(Array.from({ length: range[1] - range[0] }, (_, k) => range[0] + k));

  /** File i's rows near the viewport. */
  function rowRange(i: number): number[] {
    const y = tops[i] + HEAD;
    const [a, b] = fixedRange(files[i].rows, ROW, view.top - OVERSCAN - y, view.bottom - view.top + 2 * OVERSCAN);
    const out: number[] = [];
    for (let r = a; r < b; r++) out.push(r);
    return out;
  }

  // Scroll position -> view, measured synchronously in the scroll event so the new rows
  // are in the DOM before the frame paints.
  function measure() {
    if (!filesEl || !scroller) return;
    const top = scroller.getBoundingClientRect().top - filesEl.getBoundingClientRect().top;
    if (top !== view.top || view.bottom - view.top !== scroller.clientHeight) {
      view = { top, bottom: top + scroller.clientHeight };
    }
  }

  onMount(() => {
    scroller = filesEl.closest('[data-scroller]') as HTMLElement;
    scroller.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    ro.observe(scroller.firstElementChild ?? filesEl);
    measure();
    if (initial) {
      const k = initial.path === null ? -1 : files.findIndex((f) => f.path === initial.path);
      if (k >= 0) scroller.scrollTop += tops[k] + Math.min(initial.offset, fileHeight(k)) - view.top;
      else scroller.scrollTop = initial.scrollTop;
      measure();
    }
    return () => {
      alive = false;
      scroller.removeEventListener('scroll', measure);
      ro.disconnect();
    };
  });

  // Fetch the contents of files as they come near the viewport, in one batch per change.
  const requested = new Set<number>();
  $effect(() => {
    const want: number[] = [];
    for (let i = range[0]; i < Math.min(files.length, range[1] + PREFETCH); i++) {
      if (files[i].rows && !collapsed[i] && !requested.has(i)) want.push(i);
    }
    if (!want.length) return;
    for (const i of want) requested.add(i);
    app.fileContents(summary.sha, want).then(
      (res) => {
        if (!alive) return;
        const next = { ...contents };
        for (const i of want) {
          next[i] = buildRows(res[i]);
          queueHighlight(i, next[i]);
        }
        contents = next;
      },
      (e) => {
        for (const i of want) requested.delete(i);
        toast.error(e);
      },
    );
  });

  function queueHighlight(i: number, rows: FileRows) {
    const distance = () => Math.abs(tops[i] - view.top);
    highlight(`${summary.sha}:${i}`, files[i].path, rows.hunks, distance, () => alive).then((t) => {
      if (t && alive) tokens = { ...tokens, [i]: t };
    });
  }

  // The file tree, beside the diff when there's more than one file and room for it.
  const showTree = $derived(tree && files.length > 1);
  const TREE_WIDTH = 240;
  const savedTreeWidth = persisted('legit:tree-width', TREE_WIDTH);
  let treeWidth = $state(savedTreeWidth.value);

  /** Where the last jump left the diff, so a file too near the end to reach the top still shows as picked. */
  let jump = $state<{ i: number; top: number } | null>(null);
  const current = $derived(
    jump && Math.abs(jump.top - view.top) < 1 ? jump.i : view.top < 0 ? -1 : rowAt(tops, view.top + 1),
  );

  function reveal(i: number) {
    if (!scroller) return;
    if (collapsed[i]) {
      collapsed[i] = false;
      flushSync();
    }
    scroller.scrollTop += tops[i] - view.top;
    measure();
    jump = { i, top: view.top };
  }

  /** Where the view is, to open the next one (of the rewritten commit) at the same place. */
  export function position(): DiffPosition {
    const k = view.top >= 0 ? rowAt(tops, view.top) : -1;
    const at = k >= 0 && k < files.length ? k : -1;
    return {
      path: at >= 0 ? files[at].path : null,
      offset: at >= 0 ? view.top - tops[at] : 0,
      scrollTop: scroller?.scrollTop ?? 0,
      collapsed: files.filter((_, i) => collapsed[i]).map((f) => f.path),
      shown: visible.map((i) => files[i].path),
    };
  }

  const totals = $derived(files.reduce((t, f) => ({ a: t.a + f.added, r: t.r + f.removed }), { a: 0, r: 0 }));

  // Selection (split). A file with no line changes (binary, mode-only) uses index 0 as "whole file".
  const changes = (f: FileSummary) => f.added + f.removed;
  function fileState(f: FileSummary): 'none' | 'some' | 'all' {
    const n = sel[f.path].size;
    return n === 0 ? 'none' : n >= Math.max(1, changes(f)) ? 'all' : 'some';
  }

  function toggleFile(f: FileSummary) {
    if (readonly) return;
    const s = sel[f.path];
    if (fileState(f) === 'all') s.clear();
    else for (let k = 0; k < Math.max(1, changes(f)); k++) s.add(k);
  }

  function toggleHunk(i: number, headerRow: number) {
    const f = files[i];
    if (readonly || !f.partial) return toggleFile(f);
    const rows = contents[i];
    const idx: number[] = [];
    for (let r = headerRow + 1; r < rows.kind.length && rows.kind[r] !== HUNK; r++) if (rows.ci[r] >= 0) idx.push(rows.ci[r]);
    const s = sel[f.path];
    const on = !idx.every((c) => s.has(c));
    for (const c of idx) on ? s.add(c) : s.delete(c);
  }

  function toggleCollapsed(i: number) {
    const above = view.top - tops[i];
    collapsed[i] = !collapsed[i];
    // Keep a stuck header where it is instead of jumping past the file.
    if (above > 0 && scroller) scroller.scrollTop -= above;
  }

  // Drag-select: mousedown picks add/remove, dragging applies it to every change crossed.
  // Starting on the block strip (left of the line numbers) works in whole blocks: runs of
  // consecutive changed lines.
  let drag: { path: string; on: boolean; last: number; block: boolean } | null = null;
  let hoverBlock = $state<{ i: number; a: number; b: number } | null>(null);

  /** Rows [a, b] of the run of consecutive changed lines around row r. */
  function blockAt(rows: FileRows, r: number): [number, number] {
    let a = r;
    let b = r;
    while (a > 0 && rows.ci[a - 1] >= 0) a--;
    while (b + 1 < rows.ci.length && rows.ci[b + 1] >= 0) b++;
    return [a, b];
  }

  const onStrip = (e: Event) => !!(e.target as HTMLElement).closest('.blk');
  let anchor: { path: string; ci: number } | null = null;

  function setRange(path: string, a: number, b: number, on: boolean) {
    const s = sel[path];
    for (let k = Math.min(a, b); k <= Math.max(a, b); k++) on ? s.add(k) : s.delete(k);
  }

  function rowOf(e: Event): number {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-r]');
    return el ? Number(el.dataset.r) : -1;
  }

  function down(e: MouseEvent, i: number) {
    if ((e.target as HTMLElement).closest('.editor')) return;
    const r = rowOf(e);
    const rows = contents[i];
    if (readonly || r < 0 || !rows || e.button !== 0) return;
    if (rows.kind[r] === HUNK) return toggleHunk(i, r);
    const ci = rows.ci[r];
    if (ci < 0) return;
    e.preventDefault();
    const f = files[i];
    if (!f.partial) return toggleFile(f);
    const s = sel[f.path];
    if (onStrip(e)) {
      const [a, b] = blockAt(rows, r);
      const [lo, hi] = [rows.ci[a], rows.ci[b]];
      let all = true;
      for (let c = lo; c <= hi; c++) if (!s.has(c)) all = false;
      setRange(f.path, lo, hi, !all);
      drag = { path: f.path, on: !all, last: ci, block: true };
      anchor = { path: f.path, ci };
      return;
    }
    if (e.shiftKey && anchor?.path === f.path) {
      setRange(f.path, anchor.ci, ci, s.has(anchor.ci));
      return;
    }
    const on = !s.has(ci);
    on ? s.add(ci) : s.delete(ci);
    drag = { path: f.path, on, last: ci, block: false };
    anchor = { path: f.path, ci };
  }

  function over(e: MouseEvent, i: number) {
    const r = rowOf(e);
    const rows = contents[i];
    if (!rows || r < 0) return;
    const ci = rows.ci[r];
    // Preview the block the strip would toggle.
    const strip = !readonly && ci >= 0 && onStrip(e);
    if (strip) {
      const [a, b] = blockAt(rows, r);
      if (hoverBlock?.i !== i || hoverBlock.a !== a) hoverBlock = { i, a, b };
    } else if (hoverBlock) hoverBlock = null;
    if (!drag || drag.path !== files[i].path || ci < 0) return;
    setRange(drag.path, drag.last, ci, drag.on);
    if (drag.block) {
      const [a, b] = blockAt(rows, r);
      setRange(drag.path, rows.ci[a], rows.ci[b], drag.on);
    }
    drag.last = ci;
  }

  /** Row r of file i is a line of the commit's version of a text file (added or unchanged). */
  function canEdit(i: number, r: number): boolean {
    const f = files[i];
    const rows = contents[i];
    return !!oneditline && !readonly && f.partial && f.status !== 'D' && !!rows && rows.kind[r] !== HUNK && rows.n[r] > 0;
  }

  /** Focus the field when it's first shown, not each time scrolling mounts it again. */
  let focusEditor = false;

  function startEdit(i: number, r: number) {
    if (saving || !canEdit(i, r)) return;
    // The line ending isn't part of the text (the server keeps the file's).
    const text = contents[i].text[r].replace(/\r$/, '');
    editing = { i, r, text, orig: text };
    focusEditor = true;
  }

  async function saveEdit() {
    if (!editing || saving || !oneditline) return;
    const { i, r, text, orig } = editing;
    if (text === orig) {
      editing = null;
      return;
    }
    saving = true;
    try {
      if (await oneditline(files[i].path, contents[i].n[r], text)) editing = null;
    } finally {
      saving = false;
    }
  }

  function editorKey(e: KeyboardEvent) {
    // The field's keys are its own (Esc mustn't also clear the picked lines, say).
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      editing = null;
    } else if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      document.execCommand('insertText', false, '\t');
    }
  }

  // Leaving the field closes it if nothing was typed. (Removing the field blurs it too.)
  function closeUnchanged() {
    if (editing && editing.text === editing.orig && !saving) editing = null;
  }

  function attachEditor(el: HTMLTextAreaElement) {
    if (!focusEditor) return;
    focusEditor = false;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }

  /** Picked changes of every file, as a selection. */
  function picked(): Selection {
    const out: Selection = {};
    for (const f of files) if (sel[f.path].size) out[f.path] = [...sel[f.path]];
    return out;
  }

  function lineActions(i: number, r: number): MaybeEntry[] {
    const f = files[i];
    const ci = contents[i].ci[r];
    const count = Object.values(sel).reduce((n, s) => n + s.size, 0);
    const many = ci >= 0 && sel[f.path].has(ci) && count > 1;
    return [
      canEdit(i, r) && { label: 'Edit line', icon: PencilSimple, note: 'Or double-click it', run: () => startEdit(i, r) },
      !!onremove && !readonly && ci >= 0 && f.partial && {
        label: many
          ? `Remove ${count} picked changes from commit`
          : contents[i].kind[r] === ADDED
            ? "Don't add this line"
            : 'Keep this removed line',
        icon: Eraser,
        note: 'Takes the change out of the commit',
        run: () => onremove!(many ? picked() : { [f.path]: [ci] }),
      },
    ];
  }

  // Context menu (right-click a file header, a line, or a file in the tree): open in Zed, copy paths.
  /** New-side line number to open at for row r: its own, or the nearest one after/before it. */
  function lineFor(rows: FileRows, r: number): number | undefined {
    for (let k = r; k < rows.n.length && rows.kind[k] !== HUNK; k++) if (rows.n[k]) return rows.n[k];
    for (let k = r; k >= 0 && rows.kind[k] !== HUNK; k--) if (rows.n[k]) return rows.n[k];
  }

  function firstChange(i: number): number | undefined {
    const rows = contents[i];
    if (!rows) return;
    const r = rows.ci.findIndex((c) => c >= 0);
    return r < 0 ? undefined : lineFor(rows, r);
  }

  function openMenu(e: MouseEvent, i: number) {
    // The line being edited keeps the field's own menu (paste...).
    if ((e.target as HTMLElement).closest('.editor')) return;
    e.preventDefault();
    const r = rowOf(e);
    const rows = contents[i];
    const onLine = !!rows && r >= 0 && rows.kind[r] !== HUNK;
    const line = onLine ? lineFor(rows, r) : firstChange(i);
    const f = files[i];
    menu.show(e, [
      ...(onLine ? [...lineActions(i, r), 'separator' as const] : []),
      {
        label: 'Open in Zed',
        icon: FileArrowUp,
        disabled: f.status === 'D',
        note: line ? `At line ${line}` : undefined,
        run: () => app.openInZed(f.path, line),
      },
      'separator',
      { label: 'Copy path', icon: Copy, run: () => app.copy(`${app.repo?.root}/${f.path}`, 'path') },
      { label: 'Copy relative path', icon: Copy, run: () => app.copy(f.path, 'relative path') },
      ...(fileActions ? ['separator' as const, ...fileActions(f)] : []),
    ]);
  }

  const statusLabel = { A: 'added', D: 'deleted', M: '', T: 'type changed' };
  const statusColor = { A: 'var(--add)', D: 'var(--del)', M: undefined, T: undefined };
  const MARK = [' ', ' ', '+', '-'];
  const KIND = ['', 'tc', 'ta', 'td'];
</script>

<svelte:window onmouseup={() => (drag = null)} />

<div class="diff">
  <div class="summary muted">
    <span>{files.length} {files.length === 1 ? 'file' : 'files'}</span>
    <span class="add">+{totals.a}</span>
    <span class="del">−{totals.r}</span>
    {#if generatedCount}
      <span>· {generatedCount} generated {generatedCount === 1 ? 'file' : 'files'} collapsed</span>
    {/if}
    {#if !readonly && files.length}
      <span class="hint">{hint}</span>
    {/if}
  </div>

  <div class="panes" class:with-tree={showTree} style:--tree-width="{treeWidth}px">
    {#if showTree}
      <!-- As tall as the window, or the diff if that's shorter (a short diff above another). -->
      <nav class="tree" style:height="{Math.min(view.bottom - view.top, tops[files.length] - GAP)}px">
        <FileTree {files} {current} onpick={reveal} onmenu={openMenu} />
        <ResizeEdge
          side="left"
          label="Resize the file tree"
          size={treeWidth}
          min={140}
          max={600}
          preset={TREE_WIDTH}
          onresize={(w) => (treeWidth = w)}
          oncommit={(w) => (savedTreeWidth.value = w)}
        />
      </nav>
    {/if}
    <div class="files" bind:this={filesEl} style:height="{Math.max(0, tops[files.length] - GAP)}px">
      {#each visible as i (i)}
        {@const f = files[i]}
        {@const state = fileState(f)}
        {@const rows = contents[i]}
        {@const tok = tokens[i]}
        <div class="file" style:top="{tops[i]}px" style:height="{fileHeight(i)}px">
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="fhead" oncontextmenu={(e) => openMenu(e, i)}>
            {#if !readonly}
              <input
                type="checkbox"
                class="checkbox"
                checked={state === 'all'}
                indeterminate={state === 'some'}
                onchange={() => toggleFile(f)}
                title="Select whole file"
              />
            {/if}
            <button
              class="btn btn--ghost btn--icon btn--sm"
              aria-label={collapsed[i] ? 'Expand' : 'Collapse'}
              aria-expanded={!collapsed[i]}
              onclick={() => toggleCollapsed(i)}
            >
              <Twisty open={!collapsed[i]} size={10} />
            </button>
            <span class="path mono" title={f.path}>{f.path}</span>
            {#if f.untracked}<Tag color="var(--add)" label="untracked" />
            {:else if statusLabel[f.status]}<Tag color={statusColor[f.status]} label={statusLabel[f.status]} />{/if}
            {#if f.generated}
              <Tag label="generated" title="Generated file: collapsed by default (see README to change the list)" />
            {/if}
            <span class="spacer"></span>
            <span class="add mono">+{f.added}</span>
            <span class="del mono">−{f.removed}</span>
          </div>

          {#if !collapsed[i]}
            {#if !f.rows}
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <div class="note" class:sel={state === 'all'} onclick={() => toggleFile(f)}>
                {f.binary ? 'Binary file' : f.oldMode === f.newMode ? 'Empty file' : `Mode ${f.oldMode} → ${f.newMode}`}
              </div>
            {:else}
              <div class="body" class:loading={!rows} style:height="{bodyHeight(i)}px">
                {#if rows}
                  {@const shown = rowRange(i)}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div
                    class="lines mono"
                    class:readonly
                    style:top="{(shown[0] ?? 0) * ROW}px"
                    style:min-width="max(100%, calc({GUTTER + 20}px + {f.width}ch))"
                    onmousedown={(e) => down(e, i)}
                    onmouseover={(e) => over(e, i)}
                    onmouseleave={() => (hoverBlock = null)}
                    ondblclick={(e) => startEdit(i, rowOf(e))}
                    oncontextmenu={(e) => openMenu(e, i)}
                    onfocus={() => {}}
                  >
                    {#each shown as r (r)}
                      {#if rows.kind[r] === HUNK}
                        <div class="hunk" data-r={r}><span class="gutter"></span><span class="code">{rows.text[r]}</span></div>
                      {:else}
                        {@const kind = rows.kind[r]}
                        {@const ci = rows.ci[r]}
                        {@const edit = editing?.i === i && editing.r === r ? editing : null}
                        <div
                          class="line {KIND[kind]}"
                          class:sel={(kind === ADDED || kind === REMOVED) && sel[f.path].has(ci)}
                          class:blkhover={hoverBlock?.i === i && r >= hoverBlock.a && r <= hoverBlock.b}
                          class:editing={edit}
                          style:height={edit ? `${editRows * ROW}px` : undefined}
                          data-r={r}
                        >
                          <span class="gutter"
                            ><span class="blk" title={ci >= 0 && !readonly ? 'Select this block of changes' : undefined}
                            ></span><span>{rows.o[r] || ''}</span><span>{rows.n[r] || ''}</span><span class="mark"
                              >{MARK[kind]}</span
                            ></span
                          >{#if edit}<span class="code"
                              ><textarea
                                class="editor"
                                aria-label="Line {rows.n[r]}"
                                wrap="off"
                                spellcheck="false"
                                readonly={saving}
                                bind:value={edit.text}
                                onkeydown={editorKey}
                                onblur={closeUnchanged}
                                {@attach attachEditor}
                              ></textarea></span
                            >{:else}<span class="code"
                            >{#if tok}{#each segments(tok, r, rows.text[r]) as seg}{#if seg.c}<span class={seg.c}
                                    >{seg.t}</span
                                  >{:else}{seg.t}{/if}{/each}{:else}{rows.text[r]}{/if}{#if rows.eof[r]}<span
                                class="eof"
                                title="No newline at end of file">⏎̸</span
                              >{/if}</span
                          >{/if}
                        </div>
                      {/if}
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .diff {
    padding: var(--sp-4) var(--sp-5) calc(var(--sp-5) + var(--sp-4));
    container-type: inline-size;
  }

  .panes.with-tree {
    display: grid;
    grid-template-columns: var(--tree-width) minmax(0, 1fr);
    gap: var(--sp-4);
    align-items: start;
  }

  .tree {
    position: sticky;
    top: 0;
    margin-left: calc(-1 * var(--gap-3));
  }

  /* Too narrow for both: the diff keeps the room. */
  @container (max-width: 640px) {
    .panes.with-tree {
      display: block;
    }

    .tree {
      display: none;
    }
  }

  .summary {
    display: flex;
    gap: var(--sp-4);
    align-items: baseline;
    font-size: var(--fs-sm);
    padding: 0 var(--gap-2) var(--sp-4);
  }

  .hint {
    margin-left: auto;
    font-size: var(--fs-xs);
  }

  .add {
    color: var(--add);
  }

  .del {
    color: var(--del);
  }

  .files {
    position: relative;
  }

  .file {
    position: absolute;
    left: 0;
    right: 0;
    border-radius: var(--radius);
    box-shadow: var(--box-shadow);
    background: var(--bg2);
    contain: layout style;
  }

  .fhead {
    position: sticky;
    top: 0;
    z-index: var(--z-sticky);
    height: 34px;
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    padding: 0 var(--sp-4);
    background: var(--bg2);
    border-bottom: 1px solid var(--border);
    border-radius: var(--radius) var(--radius) 0 0;
    font-size: var(--fs-sm);
  }

  .path {
    color: var(--color2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .spacer {
    flex: 1;
  }

  .note {
    height: 38px;
    display: flex;
    align-items: center;
    padding: 0 var(--sp-5);
    color: var(--muted);
    cursor: pointer;
  }

  .note.sel {
    background: var(--theme-soft);
    color: var(--theme2);
  }

  .body {
    position: relative;
    background: var(--code-bg);
    border-radius: 0 0 var(--radius) var(--radius);
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    contain: strict;
  }

  .body::-webkit-scrollbar {
    display: none;
  }

  /* Placeholder until the file's contents arrive: faint line stripes. */
  .body.loading {
    background: repeating-linear-gradient(
      to bottom,
      transparent 0 5px,
      var(--bg3) 5px 12px,
      transparent 12px 19px
    );
    background-size: 60% 19px;
    background-repeat: repeat-y;
    background-position: 100px 0;
    opacity: 0.6;
  }

  .lines {
    position: absolute;
    left: 0;
    width: max-content;
    font-size: var(--fs-sm);
    line-height: 19px;
    color: var(--color);
  }

  .line,
  .hunk {
    display: flex;
    height: 19px;
    white-space: pre;
    tab-size: 4;
  }

  .gutter {
    position: sticky;
    left: 0;
    display: flex;
    flex-shrink: 0;
    width: 98px;
    background: var(--code-bg);
    color: var(--muted);
    user-select: none;
    font-size: var(--fs-xs);
    box-shadow: inset -1px 0 0 var(--border);
  }

  .gutter > span {
    width: 38px;
    text-align: right;
    padding-right: 6px;
  }

  .gutter > .mark {
    width: 12px;
    text-align: center;
    padding: 0;
  }

  .gutter > .blk {
    width: 10px;
    padding: 0;
  }

  .lines:not(.readonly) :is(.ta, .td) .blk {
    cursor: pointer;
    box-shadow: inset 3px 0 0 transparent;
    transition: box-shadow var(--dur);
  }

  .lines:not(.readonly) :is(.ta, .td) .blk:hover,
  .line.blkhover .blk {
    box-shadow: inset 4px 0 0 var(--theme2);
  }

  .line.blkhover .gutter {
    background: var(--theme-soft);
  }

  .line.sel.blkhover .gutter {
    background: var(--theme);
  }

  .code {
    padding: 0 12px 0 8px;
    flex: 1;
  }

  .hunk {
    color: var(--muted);
    background: var(--bg3);
    cursor: pointer;
    font-size: var(--fs-xs);
  }

  .hunk:hover .code {
    color: var(--theme2);
  }

  .readonly .hunk {
    cursor: default;
  }

  .ta {
    background: var(--add-bg);
  }

  .td {
    background: var(--del-bg);
  }

  .ta .gutter {
    background: linear-gradient(var(--add-bg), var(--add-bg)), var(--code-bg);
  }

  .td .gutter {
    background: linear-gradient(var(--del-bg), var(--del-bg)), var(--code-bg);
  }

  .ta .mark {
    color: var(--add);
  }

  .td .mark {
    color: var(--del);
  }

  .lines:not(.readonly) .ta,
  .lines:not(.readonly) .td {
    cursor: pointer;
  }

  .lines:not(.readonly) .ta:not(.sel):hover .gutter,
  .lines:not(.readonly) .td:not(.sel):hover .gutter {
    background: var(--theme-soft);
  }

  .line.sel .gutter {
    background: var(--theme);
    color: var(--on-accent);
  }

  .line.sel .gutter .mark {
    color: var(--on-accent);
  }

  .line.ta.sel {
    background: var(--add-sel);
  }

  .line.td.sel {
    background: var(--del-sel);
  }

  .line.sel .code {
    box-shadow: inset 2px 0 0 var(--theme2);
  }

  /* A line being edited: the field covers the code column, a row per line it has. */
  .line.editing .code {
    position: relative;
    padding: 0;
  }

  .editor {
    position: absolute;
    inset: 0;
    width: 100%;
    margin: 0;
    padding: 0 12px 0 8px;
    border: none;
    border-radius: 0;
    resize: none;
    overflow: hidden;
    font: inherit;
    line-height: 19px;
    white-space: pre;
    tab-size: 4;
    color: var(--color);
    background: var(--surface);
    box-shadow: inset 0 0 0 1.5px var(--theme2);
    outline: none;
  }

  .editor[readonly] {
    opacity: 0.6;
  }

  .eof {
    color: var(--del);
    opacity: 0.7;
    margin-left: var(--gap-2);
  }
</style>
