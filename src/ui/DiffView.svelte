<script lang="ts">
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
  import { untrack } from 'svelte';
  import type { SvelteSet } from 'svelte/reactivity';
  import type { CommitDiff, DiffLine, FileDiff, Hunk } from '../shared/types.ts';

  let { diff, sel, readonly }: { diff: CommitDiff; sel: Record<string, SvelteSet<number>>; readonly: boolean } = $props();

  const BIG = 1500;
  const size = (f: FileDiff) => f.hunks.reduce((n, h) => n + h.lines.length, 0);
  const changes = (f: FileDiff) => f.added + f.removed;
  // The view is re-created for each commit, so the initial diff is the only one.
  let collapsed = $state<Record<string, boolean>>(
    untrack(() => Object.fromEntries(diff.files.map((f) => [f.path, size(f) > BIG]))),
  );

  const totals = $derived(
    diff.files.reduce((t, f) => ({ a: t.a + f.added, r: t.r + f.removed }), { a: 0, r: 0 }),
  );

  // Selecting: a file with no line changes (binary, mode-only) uses index 0 as "whole file".
  function fileState(f: FileDiff): 'none' | 'some' | 'all' {
    const n = sel[f.path].size;
    return n === 0 ? 'none' : n >= Math.max(1, changes(f)) ? 'all' : 'some';
  }

  function toggleFile(f: FileDiff) {
    if (readonly) return;
    const s = sel[f.path];
    if (fileState(f) === 'all') s.clear();
    else for (let i = 0; i < Math.max(1, changes(f)); i++) s.add(i);
  }

  function toggleHunk(f: FileDiff, h: Hunk) {
    if (readonly || !f.partial) return toggleFile(f);
    const idx = h.lines.filter((l) => l.i !== undefined).map((l) => l.i!);
    const s = sel[f.path];
    const on = !idx.every((i) => s.has(i));
    for (const i of idx) on ? s.add(i) : s.delete(i);
  }

  // Line drag-selection: mousedown picks add/remove mode, dragging applies it to every line crossed.
  let drag: { path: string; on: boolean; last: number } | null = null;
  let anchor: { path: string; i: number } | null = null;

  function setRange(path: string, a: number, b: number, on: boolean) {
    const s = sel[path];
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) on ? s.add(i) : s.delete(i);
  }

  function down(e: MouseEvent, f: FileDiff, l: DiffLine) {
    if (readonly || l.i === undefined || e.button !== 0) return;
    e.preventDefault();
    if (!f.partial) return toggleFile(f);
    const s = sel[f.path];
    if (e.shiftKey && anchor?.path === f.path) {
      setRange(f.path, anchor.i, l.i, s.has(anchor.i));
      return;
    }
    const on = !s.has(l.i);
    on ? s.add(l.i) : s.delete(l.i);
    drag = { path: f.path, on, last: l.i };
    anchor = { path: f.path, i: l.i };
  }

  function enter(f: FileDiff, l: DiffLine) {
    if (!drag || drag.path !== f.path || l.i === undefined) return;
    setRange(f.path, drag.last, l.i, drag.on);
    drag.last = l.i;
  }

  const statusLabel = { A: 'added', D: 'deleted', M: '', T: 'type changed' };
</script>

<svelte:window onmouseup={() => (drag = null)} />

<div class="diff">
  <div class="summary dim">
    <span>{diff.files.length} {diff.files.length === 1 ? 'file' : 'files'}</span>
    <span class="add">+{totals.a}</span>
    <span class="del">−{totals.r}</span>
    {#if !readonly && diff.files.length}
      <span class="hint">Pick lines to split out: click, drag, or shift-click a range.</span>
    {/if}
  </div>

  {#each diff.files as f (f.path)}
    {@const state = fileState(f)}
    <div class="file">
      <div class="fhead">
        {#if !readonly}
          <input
            type="checkbox"
            checked={state === 'all'}
            indeterminate={state === 'some'}
            onchange={() => toggleFile(f)}
            title="Select whole file"
          />
        {/if}
        <button class="ghost caret" onclick={() => (collapsed[f.path] = !collapsed[f.path])}>
          {#if collapsed[f.path]}<CaretRightIcon size={12} />{:else}<CaretDownIcon size={12} />{/if}
        </button>
        <span class="path mono">{f.path}</span>
        {#if statusLabel[f.status]}<span class="status {f.status}">{statusLabel[f.status]}</span>{/if}
        <span class="spacer"></span>
        <span class="add mono">+{f.added}</span>
        <span class="del mono">−{f.removed}</span>
      </div>

      {#if !collapsed[f.path]}
        {#if f.binary}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="note" class:sel={state === 'all'} onclick={() => toggleFile(f)}>Binary file</div>
        {:else if !f.hunks.length}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="note" class:sel={state === 'all'} onclick={() => toggleFile(f)}>
            {f.oldMode === f.newMode ? 'Empty file' : `Mode ${f.oldMode} → ${f.newMode}`}
          </div>
        {:else}
          <div class="scroll">
            <div class="lines mono" class:readonly>
              {#each f.hunks as h, hi (hi)}
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <div class="hunk" onclick={() => toggleHunk(f, h)}>
                  <span class="gutter"></span><span class="code">{h.header}</span>
                </div>
                {#each h.lines as l, li (li)}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div
                    class="line t{l.t === '+' ? 'a' : l.t === '-' ? 'd' : 'c'}"
                    class:sel={l.i !== undefined && sel[f.path].has(l.i)}
                    onmousedown={(e) => down(e, f, l)}
                    onmouseenter={() => enter(f, l)}
                  >
                    <span class="gutter"><span>{l.o ?? ''}</span><span>{l.n ?? ''}</span><span class="mark">{l.t}</span></span>
                    <span class="code">{l.s}{#if l.eof}<span class="eof" title="No newline at end of file">⏎̸</span>{/if}</span>
                  </div>
                {/each}
              {/each}
            </div>
          </div>
        {/if}
      {/if}
    </div>
  {/each}
</div>

<style>
  .diff {
    padding: 12px 16px 24px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .summary {
    display: flex;
    gap: 10px;
    align-items: baseline;
    font-size: 12px;
    padding: 0 4px;
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

  .file {
    border-radius: 4px;
    box-shadow: var(--box-shadow);
    background: var(--bg2);
    content-visibility: auto;
    contain-intrinsic-size: auto 200px;
  }

  .fhead {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
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
    padding: 10px 14px;
    color: var(--dim);
    cursor: pointer;
  }

  .note.sel {
    background: var(--theme-soft);
    color: var(--theme);
  }

  .scroll {
    overflow-x: auto;
  }

  .lines {
    display: grid;
    width: max-content;
    min-width: 100%;
    font-size: 12px;
    line-height: 19px;
    padding-bottom: 2px;
  }

  .line,
  .hunk {
    display: flex;
    white-space: pre;
    tab-size: 4;
  }

  .gutter {
    position: sticky;
    left: 0;
    display: flex;
    flex-shrink: 0;
    width: 88px;
    background: var(--bg2);
    color: var(--dim);
    opacity: 0.8;
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

  .ta .gutter {
    background: linear-gradient(var(--add-bg), var(--add-bg)), var(--bg2);
  }

  .td .gutter {
    background: linear-gradient(var(--del-bg), var(--del-bg)), var(--bg2);
  }

  .ta .mark {
    color: var(--add);
  }

  .td {
    background: var(--del-bg);
  }

  .td .mark {
    color: var(--del);
  }

  .lines:not(.readonly) .ta,
  .lines:not(.readonly) .td {
    cursor: pointer;
  }

  .lines:not(.readonly) .ta:hover .gutter,
  .lines:not(.readonly) .td:hover .gutter {
    background: var(--theme-soft);
  }

  .line.sel .gutter {
    background: var(--theme);
    color: #fff;
    opacity: 1;
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

  .eof {
    color: var(--del);
    opacity: 0.7;
    margin-left: 4px;
  }
</style>
