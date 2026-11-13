<script lang="ts">
  // A JSON file as a tree of its values, opened a container at a time (read as it opens: see
  // lib/json.ts). The containers holding what the diff changed start open, and changed entries are
  // washed green. Right-click an entry to open or close everything in it, or copy it as JSON.
  import { Twisty, menu, toast } from 'purr';
  import { ArrowsInSimpleRegular, ArrowsOutSimpleRegular, BracketsCurlyRegular, PathRegular } from 'purr/glyphs';
  import { app } from './lib/app.svelte.ts';
  import { type JsonNode, JsonError, isContainer, members, pathOf, pretty, readJson } from './lib/json.ts';

  interface Props {
    text: string;
    /** Line numbers (1-based) the diff adds or changes. */
    changed?: ReadonlySet<number>;
  }
  let { text, changed }: Props = $props();

  /** Members a container shows at first, and more each time it's asked for more. */
  const STEP = 500;
  /** Rows "Expand all" opens at most, so a huge file doesn't hold the window up. */
  const MAX_ROWS = 5000;

  const top = $derived.by(() => {
    try {
      return readJson(text);
    } catch (e) {
      if (e instanceof JsonError) return e;
      throw e;
    }
  });

  // Read once per container, by where it starts (the parent re-creates this view for another text).
  const read = new Map<number, JsonNode[] | JsonError>();
  function kids(n: JsonNode): JsonNode[] | JsonError {
    let k = read.get(n.start);
    if (!k) {
      try {
        k = members(text, n);
      } catch (e) {
        if (!(e instanceof JsonError)) throw e;
        k = e;
      }
      read.set(n.start, k);
    }
    return k;
  }

  const lines = $derived(changed?.size ? Int32Array.from(changed).sort() : null);
  /** Some line from `a` to `b` changed. */
  function touched(a: number, b: number): boolean {
    if (!lines) return false;
    let lo = 0;
    let hi = lines.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (lines[m] < a) lo = m + 1;
      else hi = m;
    }
    return lo < lines.length && lines[lo] <= b;
  }

  /** Containers opened or closed by hand, by where they start; the rest are open when they're the top or hold a change (not when they're one). */
  let toggled = $state<Record<number, boolean>>({});
  const isOpen = (n: JsonNode, depth: number) =>
    toggled[n.start] ?? (depth === 0 || (touched(n.line, n.last) && !changed?.has(n.line)));
  let limits = $state<Record<number, number>>({});

  /** Open every container in n (as far as MAX_ROWS rows), or close them. */
  function setAll(n: JsonNode, depth: number, on: boolean) {
    const next = { ...toggled };
    if (!on) {
      const close = (c: JsonNode, d: number) => {
        if (!isContainer(c)) return;
        const was = isOpen(c, d);
        next[c.start] = false;
        const list = kids(c);
        if (was && Array.isArray(list)) for (const m of list) close(m, d + 1);
      };
      close(n, depth);
      toggled = next;
      return;
    }
    let rows = 0;
    let queue = [n];
    while (queue.length && rows < MAX_ROWS) {
      const level: JsonNode[] = [];
      for (const c of queue) {
        if (!isContainer(c) || rows >= MAX_ROWS) continue;
        next[c.start] = true;
        const list = kids(c);
        if (!Array.isArray(list)) continue;
        const shown = list.slice(0, limits[c.start] ?? STEP);
        rows += shown.length;
        level.push(...shown);
      }
      queue = level;
    }
    toggled = next;
    if (rows >= MAX_ROWS) toast(`Opened the first ${MAX_ROWS.toLocaleString('en-US')} entries`);
  }

  function copyJson(n: JsonNode) {
    try {
      app.copy(pretty(text, n), 'as JSON');
    } catch (e) {
      toast.error(e instanceof JsonError ? `Line ${e.line}: ${e.message}` : e);
    }
  }

  function openMenu(e: MouseEvent, n: JsonNode, keys: (string | number)[], depth: number) {
    e.preventDefault();
    e.stopPropagation();
    // Opening and closing reach the entry's insides, or the whole file's from a value.
    const root = top instanceof JsonError ? null : top;
    const box = isContainer(n) ? { n, depth } : root && { n: root, depth: 0 };
    const scope = box && box.n !== root ? `In ${pathOf(keys)}` : undefined;
    menu.show(e, [
      !!box && { label: 'Expand all', icon: ArrowsOutSimpleRegular, note: scope, run: () => setAll(box.n, box.depth, true) },
      !!box && { label: 'Collapse all', icon: ArrowsInSimpleRegular, note: scope, run: () => setAll(box.n, box.depth, false) },
      'separator',
      { label: 'Copy as JSON', icon: BracketsCurlyRegular, run: () => copyJson(n) },
      { label: 'Copy path', icon: PathRegular, note: pathOf(keys), run: () => app.copy(pathOf(keys), 'path') },
    ]);
  }

  const count = (n: JsonNode, list: JsonNode[] | JsonError) =>
    list instanceof JsonError ? '' : `${list.length} ${n.kind === 'object' ? (list.length === 1 ? 'key' : 'keys') : list.length === 1 ? 'item' : 'items'}`;
</script>

{#snippet entry(n: JsonNode, keys: (string | number)[], depth: number)}
  {@const box = isContainer(n)}
  {@const open = box && isOpen(n, depth)}
  {@const list = box ? kids(n) : null}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="row"
    class:changed={changed?.has(n.line)}
    class:inner={box && !open && !changed?.has(n.line) && touched(n.line, n.last)}
    style:--depth={depth}
    data-line={n.line}
    oncontextmenu={(e) => openMenu(e, n, keys, depth)}
  >
    {#if box}
      <button class="head" aria-expanded={open} onclick={() => (toggled[n.start] = !open)}>
        <Twisty {open} size={10} />
        {#if n.key !== null}<span class="key" class:index={typeof n.key === 'number'}>{n.key}</span>{/if}
        <span class="sum">{n.kind === 'object' ? '{' : '['}{open ? '' : '…'}{n.kind === 'object' ? '}' : ']'} {count(n, list!)}</span>
      </button>
    {:else}
      <span class="leaf">
        {#if n.key !== null}<span class="key" class:index={typeof n.key === 'number'}>{n.key}</span>{/if}
        <span class="v {n.kind}">{text.slice(n.start, n.end)}</span>
      </span>
    {/if}
  </div>
  {#if open && list}
    {#if list instanceof JsonError}
      <p class="error" style:--depth={depth + 1}>Line {list.line}: {list.message}</p>
    {:else}
      {@const limit = limits[n.start] ?? STEP}
      {#each list.slice(0, limit) as m (m.start)}
        {@render entry(m, [...keys, m.key!], depth + 1)}
      {/each}
      {#if list.length > limit}
        <button class="btn btn--link more" style:--depth={depth + 1} onclick={() => (limits[n.start] = limit + STEP)}>
          Show {Math.min(STEP, list.length - limit).toLocaleString('en-US')} more of {(list.length - limit).toLocaleString('en-US')}
        </button>
      {/if}
    {/if}
  {/if}
{/snippet}

{#if top instanceof JsonError}
  <p class="note">Not valid JSON: {top.message} on line {top.line}.</p>
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="json mono" oncontextmenu={(e) => openMenu(e, top as JsonNode, [], 0)}>
    {@render entry(top, [], 0)}
  </div>
{/if}

<style>
  .json {
    font-size: var(--fs-sm);
    line-height: 1.6;
  }

  .row {
    display: flex;
    align-items: flex-start;
    padding-left: calc(var(--depth) * 16px);
    border-radius: var(--radius-sm);
  }

  .row.changed {
    background: var(--add-bg);
  }

  .head,
  .leaf {
    display: flex;
    align-items: baseline;
    gap: var(--gap-3);
    min-width: 0;
  }

  .head {
    all: unset;
    display: flex;
    align-items: center;
    gap: var(--gap-3);
    cursor: default;
    border-radius: var(--radius-sm);
  }

  .head:focus-visible {
    outline: 2px solid var(--theme2);
  }

  /* Values line up with containers' keys, past the chevron. */
  .leaf {
    padding-left: calc(10px + var(--gap-3));
  }

  .key {
    flex-shrink: 0;
    color: var(--code-tag);
  }

  .key::after {
    content: ':';
    color: var(--muted);
  }

  .key.index {
    color: var(--muted);
  }

  .sum {
    color: var(--muted);
  }

  /* Closed, with a change inside. */
  .inner .sum {
    color: var(--add);
  }

  .v {
    min-width: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .string {
    color: var(--code-str);
  }

  .number {
    color: var(--code-num);
  }

  .true,
  .false,
  .null {
    color: var(--code-kw);
  }

  .more {
    margin-left: calc(var(--depth) * 16px + 10px + var(--gap-3));
    font-size: var(--fs-xs);
  }

  .error {
    margin: 0;
    padding-left: calc(var(--depth) * 16px);
    color: var(--del);
  }

  .note {
    margin: 0;
    color: var(--muted);
  }
</style>
