<script lang="ts">
  // A file shown as it reads rather than as lines: markdown as a document, CSV and TSV as a table.
  // Its height is its content's: the diff measures it, and the view scrolls past it as past a diff.
  import type { RenderKind } from '../shared/files.ts';
  import Markdown from './Markdown.svelte';
  import { type CsvIndex, indexDelimited, laterRows, numericColumns } from './lib/csv.ts';
  import { TABLE_ROWS } from './lib/tables.ts';

  interface Props {
    kind: RenderKind;
    path: string;
    text: string;
    /** Line numbers (1-based, in `text`) the diff adds or changes, to mark what changed. */
    changed?: ReadonlySet<number>;
    /** Told as a markdown file is shown, a slice at a time: the first line of the last block shown, and whether that's all. */
    onprogress?: (line: number, done: boolean) => void;
    /** A CSV's or TSV's rows, read ahead (see `readTable`); read from `text` here otherwise. */
    table?: CsvIndex;
  }
  let { kind, path, text, changed, onprogress, table }: Props = $props();

  /** A table shows its header and this many rows at most, fewer when wide (no more than MAX_CELLS cells, but
   *  50 rows), then up to MAX_AFTER changed rows after them, saying how many are left out between. */
  const MAX_ROWS = TABLE_ROWS - 1;
  const MAX_CELLS = 25_000;
  const MAX_AFTER = 100;
  /** Rows are added this many cells' worth a frame (a row costing as much as a few cells), so a big table never holds a
   *  frame up for long. */
  const FRAME_CELLS = 800;
  const ROW_CELLS = 4;
  /** Cells per column the table is sized by from the start (see `sizers`). */
  const SIZERS = 3;

  /** Whether lines first to last include a changed one. */
  function hit(first: number, last: number) {
    if (!changed?.size) return false;
    for (let l = first; l <= last; l++) if (changed.has(l)) return true;
    return false;
  }

  interface Row {
    fields: string[];
    /** Its place among all rows (0 for the header). */
    n: number;
    lines: [number, number];
  }
  const delimiter = $derived(kind === 'tsv' ? '\t' : ',');
  const index = $derived(kind === 'markdown' ? null : (table ?? indexDelimited(text, delimiter, TABLE_ROWS)));
  const head = $derived(index ? 1 + Math.max(50, Math.min(MAX_ROWS, Math.floor(MAX_CELLS / Math.max(1, index.columns)))) : 0);
  // Apart from the changed rows after them, so those coming in doesn't redraw these.
  const first = $derived(index ? index.rows.slice(0, head).map((fields, n): Row => ({ fields, n, lines: index.lines[n] })) : []);
  const after = $derived.by(() => {
    const out: Row[] = [];
    if (!index || !changed?.size) return out;
    for (let n = head; n < index.rows.length && out.length < MAX_AFTER; n++) {
      if (hit(...index.lines[n])) out.push({ fields: index.rows[n], n, lines: index.lines[n] });
    }
    if (out.length < MAX_AFTER && index.marks.length) {
      const from = index.marks[2];
      const wanted = Int32Array.from([...changed].filter((l) => l >= from)).sort();
      const later = laterRows(text, index, delimiter, wanted, MAX_AFTER - out.length);
      later.rows.forEach((fields, k) => out.push({ fields, n: later.index[k], lines: later.lines[k] }));
    }
    return out;
  });
  /** The rows shown, in order. */
  const shown = $derived(after.length ? [...first, ...after] : first);
  const width = $derived(after.reduce((w, r) => Math.max(w, r.fields.length), index?.columns ?? 0));
  const columns = $derived(Array.from({ length: width }, (_, c) => c));
  const numeric = $derived(index ? numericColumns(index.rows.slice(0, head), width) : []);
  const left = $derived(shown.length ? (index?.total ?? 0) - 1 - shown[shown.length - 1].n : 0);
  const more = (n: number) => `${n.toLocaleString('en-US')} more ${n === 1 ? 'row' : 'rows'}`;

  /** Rows added a frame. */
  const step = $derived(Math.max(10, Math.floor(FRAME_CELLS / (width + 1 + ROW_CELLS))));
  // Counted afresh for a new text: its table is made anew, a frame's rows at a time again.
  let added = $state.raw<{ of: CsvIndex | null; rows: number }>({ of: null, rows: 0 });
  /** How many of the rows shown are in yet (the table is busy until all are): a frame's at once, then more each frame. */
  const upTo = $derived(Math.min(shown.length, Math.max(added.of === index ? added.rows : 0, 1 + step)));
  /** Where each frame's rows start in `shown`. */
  const sections = $derived(Array.from({ length: Math.ceil((upTo - 1) / step) }, (_, k) => 1 + k * step));
  $effect(() => {
    if (upTo >= shown.length) return;
    const next = { of: index, rows: upTo + step };
    const id = requestAnimationFrame(() => (added = next));
    return () => cancelAnimationFrame(id);
  });

  /** The table scrolled sideways, if it is. */
  let sideways = $state.raw<CsvIndex | null>(null);

  /** A row's cells, made here rather than by the template: a table has thousands, made and dropped with the view. */
  function cells(row: Row) {
    return (tr: HTMLElement) => {
      const out: HTMLElement[] = [];
      const n = document.createElement('td');
      n.className = 'n';
      n.textContent = String(row.n);
      out.push(n);
      for (let c = 0; c < columns.length; c++) {
        const td = document.createElement('td');
        if (numeric[c]) td.className = 'num';
        td.textContent = row.fields[c] ?? '';
        out.push(td);
      }
      tr.replaceChildren(...out);
    };
  }

  /** Rows of each column's longest cells (and the biggest row number), collapsed: the columns are as wide as they'll be
   *  from the first frame, so rows coming in don't widen one, which would lay the whole table out and paint it again. */
  const sizers = $derived.by(() => {
    if (shown.length <= step) return [];
    const best = Array.from({ length: width }, () => [] as { len: number; text: string }[]);
    for (let k = 1; k < shown.length; k++) {
      const fields = shown[k].fields;
      for (let c = 0; c < fields.length; c++) {
        const text = fields[c];
        let len = text.length;
        // A cell is as wide as its longest line.
        if (text.includes('\n')) len = Math.max(...text.split('\n').map((l) => l.length));
        const top = best[c];
        if (top.length === SIZERS && len <= top[SIZERS - 1].len) continue;
        top.push({ len, text });
        top.sort((a, b) => b.len - a.len);
        if (top.length > SIZERS) top.pop();
      }
    }
    return Array.from({ length: SIZERS }, (_, k) => best.map((top) => top[k]?.text ?? ''));
  });
</script>

{#if kind === 'markdown'}
  <div class="rendered">
    <Markdown {text} file={path} {changed} {onprogress} images />
  </div>
{:else if index}
  <div class="rendered csv">
    {#if shown.length}
      {@const top = shown[0]}
      {#key index}
        <div class="scroll" class:sideways={sideways === index} onscroll={(e) => (sideways = e.currentTarget.scrollLeft ? index : null)}>
          <table aria-busy={upTo < shown.length}>
            <thead>
              <tr class:changed={hit(...top.lines)} data-line={top.lines[0]}>
                <th class="n"></th>
                {#each columns as c (c)}<th class:num={numeric[c]}>{top.fields[c] ?? ''}</th>{/each}
              </tr>
            </thead>
            {#if sizers.length}
              <tbody aria-hidden="true">
                {#each sizers as cells, k (k)}
                  <tr class="sizer">
                    <td class="n">{shown[shown.length - 1].n}</td>
                    {#each columns as c (c)}<td>{cells[c]}</td>{/each}
                  </tr>
                {/each}
              </tbody>
            {/if}
            <!-- A section per frame's rows: one coming in leaves those before it laid out as they were. -->
            {#each sections as from (from)}
              <tbody>
                {#each shown.slice(from, Math.min(from + step, upTo)) as row, j (row.n)}
                  {@const skipped = row.n - shown[from + j - 1].n - 1}
                  {#if skipped}
                    <tr class="gap"><td class="n"></td><td colspan={columns.length}>{more(skipped)}</td></tr>
                  {/if}
                  <tr class:changed={hit(...row.lines)} data-line={row.lines[0]} {@attach cells(row)}></tr>
                {/each}
              </tbody>
            {/each}
            {#if left && upTo === shown.length}
              <tbody>
                <tr class="gap"><td class="n"></td><td colspan={columns.length}>{more(left)}</td></tr>
              </tbody>
            {/if}
          </table>
        </div>
      {/key}
    {:else}
      <p class="note">No rows</p>
    {/if}
  </div>
{/if}

<style>
  .rendered {
    padding: var(--sp-5) calc(var(--sp-5) * 2);
    /* A changed block's wash reaches the pane's edges and no further. */
    overflow-x: clip;
    font-size: var(--fs-lg);
  }

  .csv {
    padding: var(--sp-4);
    font-size: var(--fs-sm);
  }

  .scroll {
    width: fit-content;
    max-width: 100%;
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  table {
    border-collapse: separate;
    border-spacing: 0;
    /* Columns as wide as their text (up to a cell's max-width), scrolled sideways rather than squeezed. */
    width: max-content;
    font-variant-numeric: tabular-nums;
  }

  /* A row's cells are made by `cells`, unscoped. */
  th,
  tbody :global(td) {
    max-width: 40em;
    padding: var(--gap-2) var(--sp-3);
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    text-align: left;
    vertical-align: top;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }

  tr > :global(:last-child) {
    border-right: none;
  }

  tbody:last-child tr:last-child > :global(*) {
    border-bottom: none;
  }

  th {
    background: var(--bg3);
    font-weight: 600;
    color: var(--color2);
  }

  th.num,
  tbody :global(.num) {
    text-align: right;
  }

  th.n,
  tbody :global(.n) {
    min-width: 3ch;
    background: var(--surface);
    color: var(--muted);
    font-family: var(--mono);
    font-size: var(--fs-xs);
    text-align: right;
    user-select: none;
  }

  th.n {
    background: var(--bg3);
  }

  /* The row numbers stay in view as the table scrolls sideways (sticky only then: hundreds of sticky cells make every
     frame that adds rows dearer). */
  .sideways th.n,
  .sideways tbody :global(.n) {
    position: sticky;
    left: 0;
  }

  .changed > :global(*) {
    background: var(--add-bg);
  }

  .changed > :global(.n) {
    background: linear-gradient(var(--add-bg), var(--add-bg)), var(--surface);
  }

  .changed > th,
  .changed > th.n {
    background: linear-gradient(var(--add-bg), var(--add-bg)), var(--bg3);
  }

  .sizer {
    visibility: collapse;
  }

  .sizer > .n {
    position: static;
  }

  .gap > td {
    background: var(--bg2);
    color: var(--muted);
    font-size: var(--fs-xs);
  }

  .note {
    margin: 0;
    color: var(--muted);
  }
</style>
