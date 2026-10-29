<script lang="ts">
  // A file shown as it reads rather than as lines: markdown as a document, CSV and TSV as a table.
  // Its height is its content's: the diff measures it, and the view scrolls past it as past a diff.
  import type { RenderKind } from '../shared/files.ts';
  import Markdown from './Markdown.svelte';
  import { numericColumns, parseDelimited } from './lib/csv.ts';

  interface Props {
    kind: RenderKind;
    path: string;
    text: string;
    /** Line numbers (1-based, in `text`) the diff adds or changes, to mark what changed. */
    changed?: ReadonlySet<number>;
  }
  let { kind, path, text, changed }: Props = $props();

  /** A table shows its header and this many rows at most, fewer when wide (no more than MAX_CELLS cells, but
   *  50 rows), then up to MAX_AFTER changed rows after them, saying how many are left out between. */
  const MAX_ROWS = 500;
  const MAX_CELLS = 25_000;
  const MAX_AFTER = 100;

  /** Whether lines first to last include a changed one. */
  function hit(first: number, last: number) {
    if (!changed?.size) return false;
    for (let l = first; l <= last; l++) if (changed.has(l)) return true;
    return false;
  }

  const table = $derived(
    kind === 'markdown' ? null : parseDelimited(text, kind === 'tsv' ? '\t' : ',', MAX_ROWS + 1, changed?.size ? hit : undefined),
  );
  const head = $derived(table ? 1 + Math.max(50, Math.min(MAX_ROWS, Math.floor(MAX_CELLS / Math.max(1, table.columns)))) : 0);
  /** The rows shown, by their place in `table.rows`. */
  const shown = $derived.by(() => {
    const out: number[] = [];
    let after = 0;
    for (let k = 0; table && k < table.rows.length; k++) {
      if (table.index[k] < head || (hit(...table.lines[k]) && after++ < MAX_AFTER)) out.push(k);
    }
    return out;
  });
  const columns = $derived(table ? Array.from({ length: table.columns }, (_, c) => c) : []);
  const numeric = $derived(table ? numericColumns(table.rows.slice(0, head), table.columns) : []);
  const left = $derived(table && shown.length ? table.total - 1 - table.index[shown[shown.length - 1]] : 0);
  const more = (n: number) => `${n.toLocaleString('en-US')} more ${n === 1 ? 'row' : 'rows'}`;
</script>

{#if kind === 'markdown'}
  <div class="rendered">
    <Markdown {text} file={path} {changed} images />
  </div>
{:else if table}
  <div class="rendered csv">
    {#if shown.length}
      <div class="scroll">
        <table>
          <thead>
            <tr class:changed={hit(...table.lines[0])}>
              <th class="n"></th>
              {#each columns as c (c)}<th class:num={numeric[c]}>{table.rows[0][c] ?? ''}</th>{/each}
            </tr>
          </thead>
          <tbody>
            {#each shown.slice(1) as k, j (k)}
              {@const row = table.rows[k]}
              {@const skipped = table.index[k] - table.index[shown[j]] - 1}
              {#if skipped}
                <tr class="gap"><td class="n"></td><td colspan={columns.length}>{more(skipped)}</td></tr>
              {/if}
              <tr class:changed={hit(...table.lines[k])}>
                <td class="n">{table.index[k]}</td>
                {#each columns as c (c)}<td class:num={numeric[c]}>{row[c] ?? ''}</td>{/each}
              </tr>
            {/each}
            {#if left}
              <tr class="gap"><td class="n"></td><td colspan={columns.length}>{more(left)}</td></tr>
            {/if}
          </tbody>
        </table>
      </div>
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

  th,
  td {
    max-width: 40em;
    padding: var(--gap-2) var(--sp-3);
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    text-align: left;
    vertical-align: top;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }

  tr > :last-child {
    border-right: none;
  }

  tbody tr:last-child > * {
    border-bottom: none;
  }

  th {
    background: var(--bg3);
    font-weight: 600;
    color: var(--color2);
  }

  .num {
    text-align: right;
  }

  /* The row numbers stay in view as the table scrolls sideways. */
  .n {
    position: sticky;
    left: 0;
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

  .changed > * {
    background: var(--add-bg);
  }

  .changed > .n {
    background: linear-gradient(var(--add-bg), var(--add-bg)), var(--surface);
  }

  .changed > th,
  .changed > th.n {
    background: linear-gradient(var(--add-bg), var(--add-bg)), var(--bg3);
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
