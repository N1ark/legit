<script lang="ts">
  // Virtualized diff. Rows have a fixed height and never wrap, so every file's height is
  // known from the summary alone: the full layout (and scrollbar) exists before any content
  // loads, nothing is ever measured, and nothing jumps. Only files near the viewport are
  // mounted, and within them only the rows near the viewport. Contents load as files come
  // into view; highlighting runs in a worker and fills in afterwards.
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
  import CopyIcon from 'phosphor-svelte/lib/CopyIcon';
  import FileArrowUpIcon from 'phosphor-svelte/lib/FileArrowUpIcon';
  import { onMount, untrack } from 'svelte';
  import type { SvelteSet } from 'svelte/reactivity';
  import type { DiffSummary, FileSummary } from '../shared/types.ts';
  import ContextMenu from './ContextMenu.svelte';
  import { app } from './lib/app.svelte.ts';
  import { type Tokens, highlight, segments } from './lib/highlighter.ts';
  import { ADDED, type FileRows, HUNK, REMOVED, buildRows } from './lib/rows.ts';

  let {
    summary,
    sel,
    readonly,
  }: { summary: DiffSummary; sel: Record<string, SvelteSet<number>>; readonly: boolean } = $props();

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
    untrack(() => Object.fromEntries(summary.files.flatMap((f, i) => (f.generated ? [[i, true]] : [])))),
  );
  const generatedCount = $derived(files.filter((f) => f.generated).length);
  let contents = $state.raw<Record<number, FileRows>>({});
  let tokens = $state.raw<Record<number, Tokens>>({});
  let view = $state({ top: 0, bottom: 1000 });
  let filesEl: HTMLElement;
  let scroller: HTMLElement;
  let alive = true;

  const bodyHeight = (f: FileSummary) => (f.rows ? f.rows * ROW + PAD : NOTE);
  /** tops[i] = y of file i; tops[n] = total height (plus one trailing gap). */
  const tops = $derived.by(() => {
    const t = new Float64Array(files.length + 1);
    let y = 0;
    for (let i = 0; i < files.length; i++) {
      t[i] = y;
      y += HEAD + (collapsed[i] ? 0 : bodyHeight(files[i])) + GAP;
    }
    t[files.length] = y;
    return t;
  });
  const fileHeight = (i: number) => tops[i + 1] - tops[i] - GAP;

  /** [first, end) of the files overlapping the viewport plus overscan. */
  const range = $derived.by(() => {
    const top = view.top - OVERSCAN;
    const bottom = view.bottom + OVERSCAN;
    let lo = 0;
    let hi = files.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tops[mid + 1] - GAP <= top) lo = mid + 1;
      else hi = mid;
    }
    let end = lo;
    while (end < files.length && tops[end] < bottom) end++;
    return [lo, end] as const;
  });
  const visible = $derived(Array.from({ length: range[1] - range[0] }, (_, k) => range[0] + k));

  /** [first, end) of file i's rows near the viewport. */
  function rowRange(i: number): number[] {
    const y = tops[i] + HEAD;
    const a = Math.max(0, Math.floor((view.top - OVERSCAN - y) / ROW));
    const b = Math.min(files[i].rows, Math.ceil((view.bottom + OVERSCAN - y) / ROW));
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
        app.toast(e.message, 'error');
      },
    );
  });

  function queueHighlight(i: number, rows: FileRows) {
    const distance = () => Math.abs(tops[i] - view.top);
    highlight(`${summary.sha}:${i}`, files[i].path, rows.hunks, distance, () => alive).then((t) => {
      if (t && alive) tokens = { ...tokens, [i]: t };
    });
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

  // Context menu (right-click a file header or a line): open in Zed, copy paths.
  let menu = $state<{ x: number; y: number; i: number; line?: number } | null>(null);

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
    e.preventDefault();
    const r = rowOf(e);
    const rows = contents[i];
    const line = rows && r >= 0 && rows.kind[r] !== HUNK ? lineFor(rows, r) : firstChange(i);
    menu = { x: e.clientX, y: e.clientY, i, line };
  }

  function menuAction(fn: (f: FileSummary) => void) {
    if (!menu) return;
    const f = files[menu.i];
    menu = null;
    fn(f);
  }

  const statusLabel = { A: 'added', D: 'deleted', M: '', T: 'type changed' };
  const MARK = [' ', ' ', '+', '-'];
  const KIND = ['', 'tc', 'ta', 'td'];
</script>

<svelte:window onmouseup={() => (drag = null)} />

{#if menu}
  {@const f = files[menu.i]}
  <ContextMenu x={menu.x} y={menu.y} onclose={() => (menu = null)}>
    <button role="menuitem" disabled={f.status === 'D'} onclick={() => menuAction((f) => app.openInZed(f.path, menu?.line))}>
      <FileArrowUpIcon size={14} /> Open in Zed
      {#if menu.line}<span class="dim">:{menu.line}</span>{/if}
    </button>
    <hr />
    <button role="menuitem" onclick={() => menuAction((f) => app.copy(`${app.repo?.root}/${f.path}`, 'path'))}>
      <CopyIcon size={14} /> Copy path
    </button>
    <button role="menuitem" onclick={() => menuAction((f) => app.copy(f.path, 'relative path'))}>
      <CopyIcon size={14} /> Copy relative path
    </button>
  </ContextMenu>
{/if}

<div class="diff">
  <div class="summary dim">
    <span>{files.length} {files.length === 1 ? 'file' : 'files'}</span>
    <span class="add">+{totals.a}</span>
    <span class="del">−{totals.r}</span>
    {#if generatedCount}
      <span>· {generatedCount} generated {generatedCount === 1 ? 'file' : 'files'} collapsed</span>
    {/if}
    {#if !readonly && files.length}
      <span class="hint">Pick lines to split out: click, drag, or shift-click; the left edge picks whole blocks.</span>
    {/if}
  </div>

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
              checked={state === 'all'}
              indeterminate={state === 'some'}
              onchange={() => toggleFile(f)}
              title="Select whole file"
            />
          {/if}
          <button class="ghost caret" onclick={() => toggleCollapsed(i)}>
            {#if collapsed[i]}<CaretRightIcon size={12} />{:else}<CaretDownIcon size={12} />{/if}
          </button>
          <span class="path mono" title={f.path}>{f.path}</span>
          {#if statusLabel[f.status]}<span class="status {f.status}">{statusLabel[f.status]}</span>{/if}
          {#if f.generated}
            <span class="status" title="Generated file: collapsed by default (see README to change the list)">generated</span>
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
            <div class="body" class:loading={!rows} style:height="{f.rows * ROW + PAD}px">
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
                  oncontextmenu={(e) => openMenu(e, i)}
                  onfocus={() => {}}
                >
                  {#each shown as r (r)}
                    {#if rows.kind[r] === HUNK}
                      <div class="hunk" data-r={r}><span class="gutter"></span><span class="code">{rows.text[r]}</span></div>
                    {:else}
                      {@const kind = rows.kind[r]}
                      {@const ci = rows.ci[r]}
                      <div
                        class="line {KIND[kind]}"
                        class:sel={(kind === ADDED || kind === REMOVED) && sel[f.path].has(ci)}
                        class:blkhover={hoverBlock?.i === i && r >= hoverBlock.a && r <= hoverBlock.b}
                        data-r={r}
                      >
                        <span class="gutter"
                          ><span class="blk" title={ci >= 0 && !readonly ? 'Select this block of changes' : undefined}
                          ></span><span>{rows.o[r] || ''}</span><span>{rows.n[r] || ''}</span><span class="mark"
                            >{MARK[kind]}</span
                          ></span
                        ><span class="code"
                          >{#if tok}{#each segments(tok, r, rows.text[r]) as seg}{#if seg.c}<span class={seg.c}
                                  >{seg.t}</span
                                >{:else}{seg.t}{/if}{/each}{:else}{rows.text[r]}{/if}{#if rows.eof[r]}<span
                              class="eof"
                              title="No newline at end of file">⏎̸</span
                            >{/if}</span
                        >
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

<style>
  .diff {
    padding: 12px 16px 24px;
  }

  .summary {
    display: flex;
    gap: 10px;
    align-items: baseline;
    font-size: 12px;
    padding: 0 4px 12px;
  }

  .hint {
    margin-left: auto;
    font-size: 11.5px;
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
    border-radius: 4px;
    box-shadow: var(--box-shadow);
    background: var(--bg2);
    contain: layout style;
  }

  .fhead {
    position: sticky;
    top: 0;
    z-index: 2;
    height: 34px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
    background: var(--bg2);
    border-bottom: 1px solid var(--border);
    border-radius: 4px 4px 0 0;
    font-size: 12px;
  }

  .fhead input {
    accent-color: var(--theme);
    margin: 0;
  }

  .caret {
    padding: 3px;
    color: var(--dim);
  }

  .path {
    color: var(--color2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status {
    font-size: 10.5px;
    padding: 0 5px;
    border-radius: 3px;
    background: var(--bg3);
    color: var(--dim);
  }

  .status.A {
    color: var(--add);
    background: var(--add-bg);
  }

  .status.D {
    color: var(--del);
    background: var(--del-bg);
  }

  .spacer {
    flex: 1;
  }

  .note {
    height: 38px;
    display: flex;
    align-items: center;
    padding: 0 14px;
    color: var(--dim);
    cursor: pointer;
  }

  .note.sel {
    background: var(--theme-soft);
    color: var(--theme);
  }

  .body {
    position: relative;
    background: var(--code-bg);
    border-radius: 0 0 4px 4px;
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
    font-size: 12px;
    line-height: 19px;
    color: var(--code-mono-1);
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
    color: var(--dim);
    user-select: none;
    font-size: 11px;
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
    transition: box-shadow 0.08s;
  }

  .lines:not(.readonly) :is(.ta, .td) .blk:hover,
  .line.blkhover .blk {
    box-shadow: inset 4px 0 0 var(--theme);
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
    color: var(--dim);
    background: var(--bg3);
    cursor: pointer;
    font-size: 11px;
  }

  .hunk:hover .code {
    color: var(--theme);
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
    color: #fff;
  }

  .line.sel .gutter .mark {
    color: #fff;
  }

  .line.ta.sel {
    background: var(--add-sel);
  }

  .line.td.sel {
    background: var(--del-sel);
  }

  .line.sel .code {
    box-shadow: inset 2px 0 0 var(--theme);
  }

  /* Token colours: the same One Light / One Dark mapping as n1ark.com. */
  .code :global(:is(.t-comment, .t-prolog, .t-cdata, .t-doc-comment)) {
    color: var(--code-mono-3);
    font-style: italic;
  }

  .code :global(:is(.t-doctype, .t-punctuation, .t-entity)) {
    color: var(--code-mono-1);
  }

  .code :global(:is(.t-attr-name, .t-class-name, .t-boolean, .t-constant, .t-number, .t-atrule, .t-type, .t-builtin-type)) {
    color: var(--code-hue-6);
  }

  .code :global(:is(.t-keyword, .t-important, .t-directive)) {
    color: var(--code-hue-3);
  }

  .code :global(:is(.t-property, .t-tag, .t-symbol, .t-deleted, .t-title, .t-lifetime-annotation)) {
    color: var(--code-hue-5);
  }

  .code :global(:is(.t-selector, .t-string, .t-char, .t-builtin, .t-inserted, .t-regex, .t-attr-value, .t-template-string)) {
    color: var(--code-hue-4);
  }

  .code :global(:is(.t-variable, .t-operator, .t-function, .t-function-definition, .t-macro)) {
    color: var(--code-hue-2);
  }

  .code :global(.t-url) {
    color: var(--code-hue-1);
  }

  .code :global(.t-attr-value .t-punctuation) {
    color: var(--code-hue-4);
  }

  .code :global(.t-bold) {
    font-weight: 600;
  }

  .code :global(.t-italic) {
    font-style: italic;
  }

  .eof {
    color: var(--del);
    opacity: 0.7;
    margin-left: 4px;
  }
</style>
